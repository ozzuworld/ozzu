// Intelligence Analysis Engine — transforms raw OSINT findings into CIA-style assessments
// Phase 1: Source reliability grading (A-F)
// Phase 2: LLM synthesis via Gemini
// Phase 3: Threat & exposure scoring
const db = require("./db");

// ── Phase 1: Source Reliability Grading ──

const SOURCE_GRADES = {
  A: { label: "Reliable", weight: 1.0, description: "Verified official source" },
  B: { label: "Usually Reliable", weight: 0.85, description: "Corroborated by multiple sources" },
  C: { label: "Fairly Reliable", weight: 0.65, description: "Single credible source" },
  D: { label: "Not Usually Reliable", weight: 0.4, description: "Unconfirmed, single weak source" },
  E: { label: "Unreliable", weight: 0.2, description: "Low confidence, dubious source" },
  F: { label: "Cannot Be Judged", weight: 0.1, description: "Reliability unknown" },
};

// Module → base grade mapping
const MODULE_GRADES = {
  // A-tier: verified APIs and official databases
  "wikipedia-intel": "A",
  "github-intel": "A",
  "co-dian": "A",
  "co-registraduria": "A",
  "co-contraloria": "A",
  "co-procuraduria": "A",
  "co-rama-judicial": "A",
  "co-policia": "A",
  "co-secop": "A",
  "co-sigep": "A",
  "co-fiscalia": "A",
  "co-rues": "A",
  "hibp-email": "A",
  "hibp-password": "A",

  // B-tier: structured API with good data
  "news-intel": "B",
  "domain-recon": "B",
  "crtsh-monitor": "B",
  "virustotal-lookup": "B",
  "shodan-lookup": "B",
  "otx-lookup": "B",
  "gravatar-lookup": "B",
  "ghunt-email": "B",
  "mastodon-intel": "B",
  "telegram-intel": "B",
  "twitter-intel": "B",
  "tiktok-intel": "B",

  // C-tier: scraping with decent accuracy
  "face-search": "C",
  "identity-resolver": "C",
  "social-deep": "C",
  "username-enum": "C",
  "email-domain": "C",
  "phone-lookup": "C",
  "maigret-cli": "C",
  "sherlock-cli": "C",
  "holehe-cli": "C",

  // D-tier: indirect/low-confidence
  "web-crawler": "D",
  "data-broker": "D",
  "paste-monitor": "D",
  "darkweb-search": "D",
  "leak-search": "D",
  "image-search": "D",
  "reverse-image": "D",
  "dnstwist-scan": "D",

  // C-tier (continued): geoint collector inherits source confidence
  "geoint-collector": "C",
  "photo-forensics": "C",
  "ip-geolocation": "C",
  "timezone-inference": "D",

  // E-tier: very low signal
  "scene-analysis": "E",
  "avatar-compare": "E",
  "document-meta": "E",
  "exif-extract": "E",
  "exiftool-cli": "E",
  "secret-scanner": "E",
};

function gradeForFinding(finding) {
  let grade = MODULE_GRADES[finding.module] || "F";

  // Upgrade based on confidence in raw_data
  const confidence = finding.raw_data?.confidence;
  if (confidence !== undefined) {
    if (confidence >= 0.95 && grade > "A") grade = "A";
    else if (confidence >= 0.85 && grade > "B") grade = String.fromCharCode(Math.max(grade.charCodeAt(0) - 1, 65)); // upgrade one level
  }

  // Upgrade if corroborated (multiple sources in raw_data)
  const sourceCount = finding.raw_data?.sourceCount || finding.raw_data?.sources?.length;
  if (sourceCount >= 3 && grade > "A") grade = "A";
  else if (sourceCount >= 2 && grade > "B") grade = "B";

  // Downgrade info-severity findings
  if (finding.severity === "info" && grade < "D") grade = "D";

  return grade;
}

function gradeWeight(grade) {
  return SOURCE_GRADES[grade]?.weight || 0.1;
}

async function gradeAllFindings(profileId) {
  const findings = await db.getOsintFindings({ profileId, limit: 2000 });
  const graded = findings.map(f => ({
    ...f,
    source_grade: gradeForFinding(f),
    source_weight: gradeWeight(gradeForFinding(f)),
  }));
  return graded;
}


// ── Phase 2: LLM Synthesis via Gemini ──

const GEMINI_MODELS = [
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
];

async function callGemini(prompt, maxTokens = 4096) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set — cannot generate assessment");

  let lastErr;
  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
        }),
        signal: AbortSignal.timeout(90000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        lastErr = new Error(`Gemini ${model} ${res.status}: ${errText.substring(0, 200)}`);
        // If key is invalid/expired, don't try other models
        if (res.status === 400 && errText.includes("API_KEY_INVALID")) {
          throw new Error("GEMINI_API_KEY expired or invalid. Please renew at https://aistudio.google.com/apikey");
        }
        // If quota, try next model
        if (res.status === 429) {
          console.log(`[analysis] ${model} quota exceeded, trying next model...`);
          continue;
        }
        throw lastErr;
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (text) {
        console.log(`[analysis] Used model: ${model}`);
        return text;
      }
    } catch (err) {
      lastErr = err;
      if (err.message.includes("expired") || err.message.includes("invalid")) throw err;
    }
  }
  throw lastErr || new Error("All Gemini models failed");
}

function buildAnalysisPrompt(profileLabel, gradedFindings, wikiData, newsData, githubData, relationships, locations) {
  // Summarize findings by grade and category
  const byGrade = { A: [], B: [], C: [], D: [], E: [], F: [] };
  for (const f of gradedFindings) {
    if (byGrade[f.source_grade]) {
      byGrade[f.source_grade].push(`[${f.module}] ${f.title}`);
    }
  }

  // Extract key structured data
  const wikiStructured = wikiData?.raw_data?.structured || {};
  const wikiExtract = wikiData?.raw_data?.articleExtract?.substring(0, 1500) || "";
  const newsArticles = newsData?.raw_data?.articles?.slice(0, 10) || [];
  const githubProfile = githubData?.raw_data?.profile || {};

  const identityFindings = gradedFindings.filter(f => f.category === "identity");
  const threatFindings = gradedFindings.filter(f => f.severity === "critical" || f.severity === "high");
  const socialFindings = gradedFindings.filter(f => f.category === "account_found" || f.module?.includes("intel"));

  // Build relationship context
  const relContext = (relationships || []).slice(0, 20).map(r =>
    `${r.source_label || r.source_entity_id} --[${r.relationship}]--> ${r.target_label || r.target_entity_id} (confidence: ${r.confidence}%)`
  ).join("\n");

  return `You are a senior intelligence analyst at a national intelligence agency. You are producing a classified intelligence assessment on a subject based on open-source intelligence (OSINT) collection.

SUBJECT: "${profileLabel}"

INSTRUCTIONS:
- Write a professional intelligence assessment in the style of a CIA Intelligence Assessment or PDB (President's Daily Brief) entry
- Use intelligence community confidence language: "We assess with HIGH confidence...", "We assess with MODERATE confidence...", "We assess with LOW confidence..."
- HIGH confidence = multiple corroborated sources (Grade A-B), consistent evidence
- MODERATE confidence = credible but limited sourcing (Grade B-C), some gaps
- LOW confidence = single source or uncorroborated (Grade D-F), significant uncertainty
- Cite source grades in brackets: [Source: A] or [Sources: A, B]
- Focus on ANALYSIS — what the data MEANS, not just what was found
- Identify patterns, vulnerabilities, risks, and key relationships
- Be direct and concise — every sentence should add intelligence value
- Do NOT include information not supported by the data below
- Use ONLY the data provided — do not hallucinate or add external knowledge

OUTPUT FORMAT (respond in valid JSON):
{
  "classification": "CONFIDENTIAL",
  "executiveSummary": "3-4 sentences. Who is this person, why do they matter, what is their digital exposure level.",
  "identityConfidence": "HIGH|MODERATE|LOW",
  "identityConfidenceJustification": "Why this confidence level — cite sources.",
  "keyFindings": [
    {"finding": "One actionable intelligence finding.", "confidence": "HIGH|MODERATE|LOW", "sourceGrades": ["A","B"], "category": "identity|digital|financial|social|threat|network"},
    ...up to 10 findings
  ],
  "vulnerabilityAssessment": {
    "overallRisk": "CRITICAL|HIGH|MODERATE|LOW",
    "identity": {"risk": "HIGH|MODERATE|LOW", "detail": "How exposed is their identity"},
    "digital": {"risk": "HIGH|MODERATE|LOW", "detail": "How exposed is their digital presence"},
    "financial": {"risk": "HIGH|MODERATE|LOW", "detail": "Financial exposure indicators"},
    "social": {"risk": "HIGH|MODERATE|LOW", "detail": "Social engineering attack surface"},
    "physical": {"risk": "HIGH|MODERATE|LOW", "detail": "Physical security indicators from OSINT"}
  },
  "networkAnalysis": "2-3 sentences on key relationships, organizations, influence networks identified.",
  "behavioralPatterns": "2-3 sentences on activity patterns, platform preferences, temporal patterns observed.",
  "outlook": "2-3 sentences. Based on current intelligence, what should be monitored. What could change.",
  "intelligenceGaps": ["Gap 1: What we don't know but should", "Gap 2: ...", ...up to 5],
  "collectionRecommendations": ["Recommendation for additional collection to fill gaps", ...up to 3]
}

=== GRADE-A INTELLIGENCE (Verified Official Sources) ===
${byGrade.A.slice(0, 30).join("\n") || "None"}

=== GRADE-B INTELLIGENCE (Usually Reliable) ===
${byGrade.B.slice(0, 30).join("\n") || "None"}

=== GRADE-C INTELLIGENCE (Fairly Reliable) ===
${byGrade.C.slice(0, 30).join("\n") || "None"}

=== GRADE-D INTELLIGENCE (Not Usually Reliable) ===
${byGrade.D.slice(0, 20).join("\n") || "None"}

=== GRADE-E/F INTELLIGENCE (Low Reliability) ===
${[...byGrade.E, ...byGrade.F].slice(0, 10).join("\n") || "None"}

=== STRUCTURED DATA (Wikipedia/Wikidata) [Source: A] ===
${wikiExtract ? wikiExtract : "No Wikipedia data available."}
${wikiStructured.birthDate ? `Born: ${wikiStructured.birthDate}` : ""}
${wikiStructured.citizenship?.length ? `Nationality: ${wikiStructured.citizenship.join(", ")}` : ""}
${wikiStructured.occupations?.length ? `Occupations: ${wikiStructured.occupations.join(", ")}` : ""}
${wikiStructured.employers?.length ? `Organizations: ${wikiStructured.employers.join(", ")}` : ""}
${wikiStructured.positions?.length ? `Positions: ${wikiStructured.positions.join(", ")}` : ""}
${wikiStructured.education?.length ? `Education: ${wikiStructured.education.join(", ")}` : ""}
${wikiStructured.spouses?.length ? `Spouses: ${wikiStructured.spouses.join(", ")}` : ""}
${wikiStructured.children?.length ? `Children: ${wikiStructured.children.join(", ")}` : ""}
${wikiStructured.socialAccounts ? `Social accounts: ${JSON.stringify(wikiStructured.socialAccounts)}` : ""}

=== NEWS INTELLIGENCE [Source: B] ===
${newsArticles.length ? newsArticles.map(a => `- ${a.title} (${a.source}, ${a.publishedAt})`).join("\n") : "No recent news."}

=== GITHUB INTELLIGENCE [Source: A] ===
${githubProfile.login ? `Login: ${githubProfile.login}, Name: ${githubProfile.name || "N/A"}, Repos: ${githubProfile.publicRepos}, Followers: ${githubProfile.followers}, Company: ${githubProfile.company || "N/A"}, Location: ${githubProfile.location || "N/A"}, Bio: ${githubProfile.bio || "N/A"}` : "No GitHub profile found."}

=== IDENTITY CANDIDATES ===
${identityFindings.slice(0, 15).map(f => `- ${f.title} [Grade: ${f.source_grade}]`).join("\n") || "None"}

=== THREAT INDICATORS ===
${threatFindings.slice(0, 15).map(f => `- [${f.severity.toUpperCase()}] ${f.title} (${f.module}) [Grade: ${f.source_grade}]`).join("\n") || "No threat indicators."}

=== SOCIAL INTELLIGENCE ===
${socialFindings.slice(0, 20).map(f => `- ${f.title} [Grade: ${f.source_grade}]`).join("\n") || "None"}

=== RELATIONSHIP GRAPH ===
${relContext || "No relationships mapped."}

=== GEOSPATIAL INTELLIGENCE ===
${(locations || []).length > 0 ? locations.slice(0, 15).map(l =>
    `- ${l.location_text} | Type: ${l.location_type} | Confidence: ${(l.confidence * 100).toFixed(0)}% | Coords: ${l.latitude ? `${l.latitude.toFixed(4)}, ${l.longitude.toFixed(4)}` : "unknown"} | Source: ${l.source_module}`
  ).join("\n") : "No geospatial data collected."}

=== STATISTICS ===
Total findings: ${gradedFindings.length}
By grade: A=${byGrade.A.length} B=${byGrade.B.length} C=${byGrade.C.length} D=${byGrade.D.length} E=${byGrade.E.length} F=${byGrade.F.length}
By severity: critical=${threatFindings.filter(f=>f.severity==="critical").length} high=${threatFindings.filter(f=>f.severity==="high").length} medium=${gradedFindings.filter(f=>f.severity==="medium").length} low=${gradedFindings.filter(f=>f.severity==="low").length} info=${gradedFindings.filter(f=>f.severity==="info").length}

Respond ONLY with valid JSON. No markdown, no code blocks, no preamble.`;
}

async function generateAssessment(profileId) {
  const profile = await db.getOsintProfile(profileId);
  if (!profile) throw new Error(`Profile ${profileId} not found`);

  console.log(`[analysis] Generating assessment for profile ${profileId}: ${profile.label}`);

  // Grade all findings
  const gradedFindings = await gradeAllFindings(profileId);

  // Also get findings from pivoted profiles (same investigation)
  let allGraded = [...gradedFindings];
  try {
    const allProfiles = await db.getOsintProfiles();
    const related = allProfiles.filter(p =>
      p.id !== profileId && p.investigation_id && p.investigation_id === profile.investigation_id
    );
    for (const rp of related) {
      const rpFindings = await gradeAllFindings(rp.id);
      allGraded.push(...rpFindings);
    }
  } catch {}

  // If this is an image profile, also grab findings from pivoted name/username profiles
  if (profile.profile_type === "image") {
    try {
      const allProfiles = await db.getOsintProfiles();
      for (const p of allProfiles) {
        if (p.id !== profileId && p.tags?.includes("auto-pivot")) {
          const pFindings = await gradeAllFindings(p.id);
          allGraded.push(...pFindings);
        }
      }
    } catch {}
  }

  // Deduplicate by title
  const seen = new Set();
  allGraded = allGraded.filter(f => {
    const key = `${f.module}:${f.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Extract specific module data for structured context
  const wikiData = allGraded.find(f => f.module === "wikipedia-intel" && f.raw_data?.type === "wikipedia_profile");
  const newsData = allGraded.find(f => f.module === "news-intel" && f.raw_data?.type === "news_coverage");
  const githubData = allGraded.find(f => f.module === "github-intel" && f.raw_data?.type === "github_profile");

  // Get relationships
  let relationships = [];
  try {
    const graphData = await db.getOsintGraph(profileId);
    relationships = graphData?.relationships || [];
  } catch {}

  // Get GEOINT locations
  let locations = [];
  try {
    locations = await db.getOsintLocations({ profile_id: profileId });
    // Also get locations from auto-pivot profiles
    const allProfiles = await db.getOsintProfiles();
    for (const p of allProfiles.filter(p => p.tags?.includes("auto-pivot"))) {
      const pLocs = await db.getOsintLocations({ profile_id: p.id });
      locations.push(...pLocs);
    }
  } catch {}

  // Build prompt and call Gemini
  const prompt = buildAnalysisPrompt(
    profile.label, allGraded, wikiData, newsData, githubData, relationships, locations
  );

  const rawResponse = await callGemini(prompt, 4096);

  // Parse JSON response
  let assessment;
  try {
    // Strip markdown code blocks if present
    const cleaned = rawResponse.replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    assessment = JSON.parse(cleaned);
  } catch (parseErr) {
    console.error("[analysis] Failed to parse Gemini response:", parseErr.message);
    console.error("[analysis] Raw response:", rawResponse.substring(0, 500));
    throw new Error("LLM returned invalid JSON");
  }

  // Compute exposure score (Phase 3)
  const exposureScore = computeExposureScore(allGraded);

  // Build the full assessment object
  const fullAssessment = {
    ...assessment,
    metadata: {
      profileId,
      profileLabel: profile.label,
      profileType: profile.profile_type,
      generatedAt: new Date().toISOString(),
      totalFindings: allGraded.length,
      gradedFindings: {
        A: allGraded.filter(f => f.source_grade === "A").length,
        B: allGraded.filter(f => f.source_grade === "B").length,
        C: allGraded.filter(f => f.source_grade === "C").length,
        D: allGraded.filter(f => f.source_grade === "D").length,
        E: allGraded.filter(f => f.source_grade === "E").length,
        F: allGraded.filter(f => f.source_grade === "F").length,
      },
      modelUsed: "gemini-2.0-flash",
    },
    exposureScore,
    sourceMatrix: buildSourceMatrix(allGraded),
  };

  // Store in DB
  await storeAssessment(profileId, fullAssessment);

  console.log(`[analysis] Assessment complete for ${profile.label}: ${assessment.identityConfidence} confidence, ${assessment.keyFindings?.length || 0} key findings`);
  return fullAssessment;
}


// ── Phase 3: Threat & Exposure Scoring ──

function computeExposureScore(gradedFindings) {
  const categories = {
    identity: { score: 0, max: 25, factors: [] },
    digital: { score: 0, max: 25, factors: [] },
    financial: { score: 0, max: 20, factors: [] },
    social: { score: 0, max: 20, factors: [] },
    physical: { score: 0, max: 10, factors: [] },
  };

  for (const f of gradedFindings) {
    const w = f.source_weight;

    // Identity exposure
    if (f.module === "face-search" && f.raw_data?.type === "verified_face_matches") {
      const matchCount = f.raw_data.verifiedMatches?.length || 0;
      categories.identity.score += Math.min(10, matchCount * 2) * w;
      categories.identity.factors.push(`Face indexed on ${matchCount} sites`);
    }
    if (f.module === "identity-resolver" && f.raw_data?.type === "identity_candidates") {
      categories.identity.score += 5 * w;
      categories.identity.factors.push("Identity resolvable from photo");
    }
    if (f.module === "wikipedia-intel" && f.raw_data?.type === "wikipedia_profile") {
      categories.identity.score += 8 * w;
      categories.identity.factors.push("Wikipedia profile exists");
    }

    // Digital exposure
    if (f.category === "account_found" || f.module === "username-enum") {
      if (f.severity !== "info") {
        categories.digital.score += 1 * w;
      }
    }
    if (f.module === "github-intel" && f.raw_data?.type === "github_profile") {
      categories.digital.score += 3 * w;
      categories.digital.factors.push(`GitHub: ${f.raw_data.profile?.publicRepos || 0} repos`);
    }
    if (f.module === "domain-recon") {
      categories.digital.score += 2 * w;
    }

    // Financial exposure
    if (f.module === "hibp-email" && f.severity !== "info") {
      categories.financial.score += 4 * w;
      categories.financial.factors.push("Email in data breach");
    }
    if (f.module === "hibp-password" && f.severity !== "info") {
      categories.financial.score += 6 * w;
      categories.financial.factors.push("Password hash exposed");
    }
    if (f.module === "leak-search" && f.severity !== "info") {
      categories.financial.score += 5 * w;
      categories.financial.factors.push("Data leak detected");
    }

    // Social exposure
    if (f.module?.includes("intel") && f.raw_data?.profileData) {
      const followers = f.raw_data.profileData.followersCount || f.raw_data.profileData.followers || 0;
      if (followers > 10000) {
        categories.social.score += 5 * w;
        categories.social.factors.push(`High-profile social account (${followers.toLocaleString()} followers)`);
      } else if (followers > 1000) {
        categories.social.score += 2 * w;
      }
    }
    if (f.module === "data-broker" && f.severity !== "info") {
      categories.social.score += 3 * w;
      categories.social.factors.push("Listed on data broker sites");
    }

    // Physical exposure
    if (f.raw_data?.profile?.location || f.raw_data?.structured?.locations?.length) {
      categories.physical.score += 3 * w;
      categories.physical.factors.push("Location data available");
    }
    if (f.module === "scene-analysis" && f.raw_data?.type === "scene_analysis") {
      categories.physical.score += 2 * w;
      categories.physical.factors.push("Scene/environment data extracted from photo");
    }
    if (f.module === "geoint-collector" && f.raw_data?.type === "geoint_summary") {
      const exact = f.raw_data.exact || 0;
      const geocoded = f.raw_data.geocoded || 0;
      categories.physical.score += Math.min(10, exact * 5 + geocoded * 2) * w;
      if (exact > 0) categories.physical.factors.push(`${exact} exact GPS location(s) exposed`);
      if (geocoded > 0) categories.physical.factors.push(`${geocoded} geocoded location(s) identified`);
      if (f.raw_data.clusters?.length > 0) categories.physical.factors.push(`${f.raw_data.clusters.length} location cluster(s) — probable home/work identifiable`);
    }
  }

  // Normalize each category to its max
  for (const cat of Object.values(categories)) {
    cat.score = Math.min(cat.max, Math.round(cat.score));
    cat.factors = [...new Set(cat.factors)].slice(0, 5);
  }

  const totalScore = Object.values(categories).reduce((sum, c) => sum + c.score, 0);
  const maxScore = Object.values(categories).reduce((sum, c) => sum + c.max, 0);
  const normalized = Math.round((totalScore / maxScore) * 100);

  let level = "LOW";
  if (normalized >= 75) level = "CRITICAL";
  else if (normalized >= 50) level = "HIGH";
  else if (normalized >= 25) level = "MODERATE";

  return {
    overall: normalized,
    level,
    categories,
  };
}


// ── Source Matrix ──

function buildSourceMatrix(gradedFindings) {
  const modules = {};
  for (const f of gradedFindings) {
    if (!modules[f.module]) {
      modules[f.module] = { grade: f.source_grade, count: 0, severities: {} };
    }
    modules[f.module].count++;
    modules[f.module].severities[f.severity] = (modules[f.module].severities[f.severity] || 0) + 1;
  }

  return Object.entries(modules)
    .map(([mod, data]) => ({ module: mod, ...data }))
    .sort((a, b) => a.grade.localeCompare(b.grade) || b.count - a.count);
}


// ── DB Storage ──

async function storeAssessment(profileId, assessment) {
  // Use osint_reports table with report_type = 'assessment'
  try {
    await db.query(
      `INSERT INTO osint_reports (title, report_type, data, profiles_included, total_findings, score_at_generation)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        `Intelligence Assessment: ${assessment.metadata.profileLabel}`,
        "assessment",
        JSON.stringify(assessment),
        [profileId],
        assessment.metadata.totalFindings,
        assessment.exposureScore.overall,
      ]
    );
  } catch (err) {
    console.error("[analysis] Failed to store assessment:", err.message);
  }
}

async function getLatestAssessment(profileId) {
  try {
    const res = await db.query(
      `SELECT * FROM osint_reports WHERE report_type = 'assessment' AND $1 = ANY(profiles_included) ORDER BY created_at DESC LIMIT 1`,
      [profileId]
    );
    return res.rows[0]?.data || null;
  } catch {
    return null;
  }
}


// ── Phase 4: Relationship Typing ──

const RELATIONSHIP_TYPES = [
  "spouse_of", "child_of", "parent_of", "sibling_of",
  "employs", "employed_by", "founded",
  "funds", "funded_by",
  "political_ally", "business_partner",
  "member_of", "owns", "uses",
  "associated_with", "linked_to",
];

async function extractTypedRelationships(profileId) {
  const allFindings = await db.getOsintFindings({ profileId, limit: 2000 });

  // Also get findings from auto-pivot profiles
  const allProfiles = await db.getOsintProfiles();
  const pivotProfiles = allProfiles.filter(p => p.tags?.includes("auto-pivot"));
  for (const pp of pivotProfiles) {
    const ppFindings = await db.getOsintFindings({ profileId: pp.id, limit: 500 });
    allFindings.push(...ppFindings);
  }

  const extracted = [];

  for (const f of allFindings) {
    // Wikipedia family relationships
    if (f.module === "wikipedia-intel" && f.raw_data?.type === "wikipedia_profile") {
      const s = f.raw_data.structured || {};
      const subject = f.raw_data.entityLabel || "";

      for (const spouse of (s.spouses || [])) {
        extracted.push({ source: subject, target: spouse, type: "spouse_of", confidence: 95, module: "wikipedia-intel" });
      }
      for (const child of (s.children || [])) {
        extracted.push({ source: subject, target: child, type: "parent_of", confidence: 95, module: "wikipedia-intel" });
      }
      for (const employer of (s.employers || [])) {
        extracted.push({ source: subject, target: employer, type: "employed_by", confidence: 90, module: "wikipedia-intel" });
      }
      for (const position of (s.positions || [])) {
        extracted.push({ source: subject, target: position, type: "member_of", confidence: 90, module: "wikipedia-intel" });
      }
      for (const [platform, username] of Object.entries(s.socialAccounts || {})) {
        extracted.push({ source: subject, target: `${platform}:${username}`, type: "uses", confidence: 95, module: "wikipedia-intel" });
      }
    }

    // GitHub organizational relationships
    if (f.module === "github-intel" && f.raw_data?.type === "github_profile") {
      const login = f.raw_data.profile?.login || "";
      const company = f.raw_data.profile?.company;
      if (company) {
        extracted.push({ source: login, target: company, type: "employed_by", confidence: 80, module: "github-intel" });
      }
      for (const org of (f.raw_data.organizations || [])) {
        extracted.push({ source: login, target: org.login, type: "member_of", confidence: 90, module: "github-intel" });
      }
    }

    // Discovered profiles (face search → platform accounts)
    if (f.raw_data?.type === "discovered_profile") {
      const platform = f.raw_data.platform;
      const username = f.raw_data.username;
      extracted.push({ source: "subject", target: `${platform}:${username}`, type: "uses", confidence: Math.round((f.raw_data.confidence || 0.5) * 100), module: f.module });
    }
  }

  return extracted;
}


module.exports = {
  SOURCE_GRADES,
  gradeForFinding,
  gradeWeight,
  gradeAllFindings,
  generateAssessment,
  getLatestAssessment,
  computeExposureScore,
  buildSourceMatrix,
  extractTypedRelationships,
  RELATIONSHIP_TYPES,
};
