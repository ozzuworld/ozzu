/**
 * Identity Resolver — Fellegi-Sunter cross-platform disambiguation
 *
 * Given a seed (name + email) and raw sherlock/maigret candidates,
 * scores each candidate through a 4-stage cascade and classifies as
 * CONFIRMED / PROBABLE / POSSIBLE / UNLIKELY / REJECTED.
 *
 * Pipeline position: between Phase 1.5 (username enum) and Phase 2 (ADB collect)
 *
 * Directive: dir_1776008019752
 */

"use strict";

const path = require("path");
const fs = require("fs");
const enricher = require("./enricher");

const BRIDGE_URL = process.env.BRIDGE_URL || "http://localhost:3333";
const COLLECTOR_URL = process.env.COLLECTOR_URL || "http://localhost:3335";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// ── Thresholds ──

const THRESHOLDS = {
  CONFIRMED: 10,
  PROBABLE: 7,
  POSSIBLE: 4,
  UNLIKELY: 0,
  // below 0 = REJECTED
};

const PRIOR = Math.log2(0.24 / 0.76); // ~24% base rate from discovery

// ── String Similarity Utilities ──

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1.0;
  const len1 = s1.length, len2 = s2.length;
  if (!len1 || !len2) return 0;
  const matchDist = Math.floor(Math.max(len1, len2) / 2) - 1;
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);
  let matches = 0, transpositions = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  const jaro = (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(len1, len2)); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function longestCommonSubstring(a, b) {
  let longest = "";
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > longest.length) longest = a.substring(i, i + k);
    }
  }
  return longest;
}

function deLeet(str) {
  return str.toLowerCase()
    .replace(/4/g, "a").replace(/3/g, "e").replace(/1/g, "i")
    .replace(/0/g, "o").replace(/5/g, "s").replace(/7/g, "t")
    .replace(/8/g, "b").replace(/@/g, "a");
}

function cosineSimilarityMaps(mapA, mapB) {
  const keys = new Set([...Object.keys(mapA), ...Object.keys(mapB)]);
  let dot = 0, normA = 0, normB = 0;
  for (const k of keys) {
    const a = mapA[k] || 0, b = mapB[k] || 0;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}

// ── Username Pattern Analysis ──

function extractUsernameFeatures(username, seedName) {
  const u = username.toLowerCase().replace(/^@+/, "");
  const nameParts = (seedName || "").toLowerCase().split(/\s+/).filter(Boolean);
  return {
    raw: u,
    hasNumbers: /\d/.test(u),
    hasUnderscore: /_/.test(u),
    hasDot: /\./.test(u),
    length: u.length,
    containsFirstName: nameParts[0] ? u.includes(nameParts[0]) : false,
    containsLastName: nameParts[1] ? u.includes(nameParts[1]) : false,
    containsInitials: nameParts.length >= 2 ? u.includes(nameParts[0][0] + nameParts[1][0]) : false,
    leetspeak: deLeet(u),
    stripped: u.replace(/[^a-z]/gi, ""),
    numberSuffix: (u.match(/\d+$/) || [null])[0],
  };
}

function usernamePatternScore(knownUsernames, candidate) {
  let maxScore = 0;
  const cf = extractUsernameFeatures(candidate, "");

  for (const known of knownUsernames) {
    const kf = extractUsernameFeatures(known, "");

    // Exact match
    if (kf.raw === cf.raw) return 1.0;

    // Same base, different suffix
    if (kf.stripped === cf.stripped && kf.stripped.length >= 4) {
      maxScore = Math.max(maxScore, 0.9);
    }

    // Leetspeak variant
    if (kf.leetspeak === cf.leetspeak && kf.leetspeak.length >= 4) {
      maxScore = Math.max(maxScore, 0.85);
    }

    // Shared substring
    const lcs = longestCommonSubstring(kf.raw, cf.raw);
    if (lcs.length >= 5) {
      const ratio = lcs.length / Math.max(kf.raw.length, cf.raw.length);
      maxScore = Math.max(maxScore, ratio * 0.8);
    }

    // Edit distance
    const editDist = levenshtein(kf.raw, cf.raw);
    const editSim = 1 - editDist / Math.max(kf.raw.length, cf.raw.length);
    if (editSim > 0.7) maxScore = Math.max(maxScore, editSim * 0.7);
  }
  return maxScore;
}

// Does the candidate username look like it could derive from the seed name?
function usernameNameAffinity(username, seedName) {
  const u = username.toLowerCase().replace(/[^a-z0-9]/g, "");
  const parts = seedName.toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return 0;
  const [first, last] = parts;

  let score = 0;
  if (u.includes(first + last) || u.includes(last + first)) score = 0.95;
  else if (u.includes(first) && u.includes(last)) score = 0.9;
  else if (u.includes(first[0] + last) || u.includes(first + last[0])) score = 0.6;
  else if (u.includes(first) || u.includes(last)) score = 0.4;
  return score;
}

// ── Bio Semantic Comparison (Claude Haiku) ──

async function getAnthropicKey() {
  if (ANTHROPIC_API_KEY) return ANTHROPIC_API_KEY;
  try {
    const envFile = path.join(__dirname, "..", "..", "..", "private", "influence-ops-credentials.env");
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, "utf8");
      const match = content.match(/ANTHROPIC_API_KEY=(.+)/);
      if (match) return match[1].trim();
    }
  } catch {}
  // Try reading from bridge container env
  try {
    const resp = await fetch(`${BRIDGE_URL}/health`);
    // Bridge doesn't expose the key, so we call Haiku through bridge if available
  } catch {}
  return null;
}

async function compareBiosSemantic(knownBios, candidateBio, seedName) {
  const apiKey = await getAnthropicKey();
  if (!apiKey) {
    // Fallback: simple keyword overlap
    const knownWords = new Set(knownBios.join(" ").toLowerCase().split(/\W+/));
    const candWords = candidateBio.toLowerCase().split(/\W+/);
    const overlap = candWords.filter(w => w.length > 3 && knownWords.has(w)).length;
    return Math.min(1, overlap / Math.max(candWords.length, 1));
  }

  const prompt = `Compare these profile bios and determine if they likely belong to the same person named "${seedName}".

KNOWN BIOS (confirmed accounts):
${knownBios.map((b, i) => `${i + 1}. ${b}`).join("\n")}

CANDIDATE BIO:
${candidateBio}

Score 0.0 to 1.0:
- shared_entities: same employer/school/city/people?
- shared_interests: same hobbies/topics/communities?
- factual_consistency: no contradictions?
- overall: combined score

Return ONLY JSON: {"shared_entities":0.0,"shared_interests":0.0,"factual_consistency":0.0,"overall":0.0}`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return 0;
    const result = await resp.json();
    const text = result.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.overall || 0;
    }
  } catch (err) {
    console.error("[resolver] Bio comparison failed:", err.message);
  }
  return 0;
}

// ── Location Matching ──

function locationMatch(knownLocations, candidateLocation) {
  if (!candidateLocation || !knownLocations.length) return { weight: 0, similarity: 0 };
  const cand = candidateLocation.toLowerCase().trim();

  for (const known of knownLocations) {
    const k = known.toLowerCase().trim();
    if (cand === k) return { weight: 3.9, similarity: 1.0 };
    if (cand.includes(k) || k.includes(cand)) return { weight: 2.5, similarity: 0.7 };
    // City-level: check if they share a city name
    const candParts = cand.split(/[,\s]+/);
    const kParts = k.split(/[,\s]+/);
    for (const cp of candParts) {
      for (const kp of kParts) {
        if (cp.length > 3 && kp.length > 3 && cp === kp) return { weight: 2.0, similarity: 0.5 };
      }
    }
  }
  return { weight: -0.4, similarity: 0 };
}

// ── Fellegi-Sunter Scoring ──

function classify(totalWeight) {
  if (totalWeight >= THRESHOLDS.CONFIRMED) return "confirmed";
  if (totalWeight >= THRESHOLDS.PROBABLE) return "probable";
  if (totalWeight >= THRESHOLDS.POSSIBLE) return "possible";
  if (totalWeight >= THRESHOLDS.UNLIKELY) return "unlikely";
  return "rejected";
}

function weightToConfidence(w) {
  return Math.pow(2, w) / (1 + Math.pow(2, w));
}

function scoreCandidate(seed, candidate, collectedData) {
  const signals = [];

  // --- Tier 1: Deterministic ---
  // Check if profile contains seed email or phone
  if (collectedData) {
    const profileText = JSON.stringify(collectedData).toLowerCase();
    for (const email of (seed.emails || [])) {
      if (profileText.includes(email.toLowerCase())) {
        signals.push({ signal: "email_anchor", weight: 20, value: email });
        const w = PRIOR + signals.reduce((s, x) => s + x.weight, 0);
        return { classification: "confirmed", confidence: 1.0, weight: w, signals };
      }
    }
  }

  // --- Tier 2: Strong signals ---

  // Face match
  if (collectedData?.faceMatch) {
    const sim = collectedData.faceMatch.topScore || 0;
    if (sim > 0.6) {
      signals.push({ signal: "face_match", weight: 13.2, value: sim });
    } else if (sim > 0.4) {
      signals.push({ signal: "face_weak", weight: 3.0, value: sim });
    } else if (sim > 0 && sim < 0.3) {
      signals.push({ signal: "face_nomatch", weight: -3.5, value: sim });
    }
    // Check if face matches a DIFFERENT known person
    if (collectedData.faceMatch.matchedSubjectId &&
        collectedData.faceMatch.matchedSubjectId !== seed.subjectId) {
      signals.push({ signal: "face_different_person", weight: -15, value: collectedData.faceMatch });
    }
  }

  // Display name
  if (collectedData?.display_name) {
    const nameSim = jaroWinkler(seed.name.toLowerCase(), collectedData.display_name.toLowerCase());
    if (nameSim > 0.95) {
      signals.push({ signal: "name_exact", weight: 9.7, value: nameSim });
    } else if (nameSim > 0.80) {
      signals.push({ signal: "name_fuzzy", weight: 4.0, value: nameSim });
    } else if (nameSim < 0.5) {
      signals.push({ signal: "name_nomatch", weight: -1.9, value: nameSim });
    }
  }

  // Username pattern
  const userSim = usernamePatternScore(seed.knownUsernames || [], candidate.username);
  const nameAff = usernameNameAffinity(candidate.username, seed.name);
  const bestUserScore = Math.max(userSim, nameAff);
  if (bestUserScore > 0.8) {
    signals.push({ signal: "username_match", weight: 5.9, value: bestUserScore });
  } else if (bestUserScore > 0.5) {
    signals.push({ signal: "username_similar", weight: 2.0, value: bestUserScore });
  } else if (bestUserScore < 0.2) {
    signals.push({ signal: "username_unrelated", weight: -1.0, value: bestUserScore });
  }

  // Bio semantic match
  if (collectedData?.bioScore !== undefined && collectedData.bioScore > 0) {
    if (collectedData.bioScore > 0.7) {
      signals.push({ signal: "bio_match", weight: 5.1, value: collectedData.bioScore });
    } else if (collectedData.bioScore > 0.4) {
      signals.push({ signal: "bio_weak", weight: 1.5, value: collectedData.bioScore });
    } else if (collectedData.bioScore < 0.1) {
      signals.push({ signal: "bio_nomatch", weight: -0.5, value: collectedData.bioScore });
    }
  }

  // --- Tier 3: Moderate signals ---

  // Location
  if (collectedData?.location && seed.knownLocations?.length > 0) {
    const loc = locationMatch(seed.knownLocations, collectedData.location);
    if (loc.weight !== 0) {
      signals.push({ signal: "location", weight: loc.weight, value: loc.similarity });
    }
  }

  // Account age consistency
  if (collectedData?.joinDate && seed.knownJoinDates?.length > 0) {
    const candYear = parseInt(collectedData.joinDate);
    if (candYear) {
      const withinRange = seed.knownJoinDates.some(d => {
        const y = parseInt(d);
        return y && Math.abs(candYear - y) <= 5;
      });
      signals.push({ signal: "account_age", weight: withinRange ? 1.5 : -0.5, value: candYear });
    }
  }

  // --- Compute final score ---
  const totalWeight = PRIOR + signals.reduce((sum, s) => sum + s.weight, 0);
  const confidence = weightToConfidence(totalWeight);
  const classification = classify(totalWeight);

  return { classification, confidence, weight: totalWeight, signals };
}

// ── Stage Runners ──

/**
 * Stage 1: Username pattern analysis (FREE — no ADB, no API)
 * Filters out candidates with completely unrelated usernames
 */
function runStage1(seed, candidates) {
  const results = [];
  for (const c of candidates) {
    if (!c.platform || !c.username) continue;

    const score = scoreCandidate(seed, c, null);
    results.push({
      ...c,
      stage1Score: score,
      classification: score.classification,
      match_weight: score.weight,
      confidence: score.confidence,
      signals: score.signals,
      stage_reached: 1,
    });
  }

  // Sort by weight descending — highest probability candidates first
  results.sort((a, b) => b.match_weight - a.match_weight);

  const rejected = results.filter(r => r.classification === "rejected");
  const continuing = results.filter(r => r.classification !== "rejected");

  console.log(`[resolver] Stage 1: ${candidates.length} candidates → ${continuing.length} continue, ${rejected.length} rejected`);
  return { continuing, rejected, all: results };
}

/**
 * Stage 2: Profile collection + face/name/bio/location scoring
 * ADB scrapes each candidate profile in dry-run mode
 */
async function runStage2(subjectId, seed, candidates, opts = {}) {
  const maxCollections = opts.maxAdbCollections || 10;
  const results = [];
  let collected = 0;

  for (const c of candidates) {
    if (collected >= maxCollections) {
      // Can't collect more — leave as-is for next session
      results.push({ ...c, stage_reached: 1 });
      continue;
    }

    // Only collect if we have a platform the collector supports
    if (!["twitter", "linkedin"].includes(c.platform)) {
      results.push({ ...c, stage_reached: 2 }); // skip but mark as processed
      continue;
    }

    try {
      console.log(`[resolver] Stage 2: Collecting @${c.username} on ${c.platform}...`);

      // Dry-run collection — scrapes profile without storing to KG
      const resp = await fetch(`${COLLECTOR_URL}/collect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: c.platform,
          action: "profile",
          subject_id: subjectId,
          params: { handle: c.username, dryRun: true },
        }),
        signal: AbortSignal.timeout(45000),
      });
      const collectResult = await resp.json();
      collected++;

      if (!collectResult.ok || !collectResult.result) {
        console.log(`[resolver] Stage 2: Collection failed for @${c.username}: ${collectResult.error || "unknown"}`);
        results.push({ ...c, stage_reached: 2 });
        continue;
      }

      const data = collectResult.result;
      const collectedData = {
        display_name: data.profile?.display_name || data.profile?.displayName || null,
        bio: data.profile?.bio || null,
        location: data.profile?.location || null,
        joinDate: data.profile?.joined || null,
        followers: data.profile?.followers || null,
        following: data.profile?.following || null,
        verified: data.profile?.verified || false,
      };

      // Face matching
      if (data.photo?.screenshotFilename) {
        const photoPath = path.join(enricher.PHOTO_DIR, data.photo.screenshotFilename);
        const avatarPath = photoPath.replace(".png", "_avatar.png");
        const imgPath = fs.existsSync(avatarPath) ? avatarPath : photoPath;

        if (fs.existsSync(imgPath)) {
          const faceResult = await enricher.matchFace(imgPath, {
            threshold: 0.3,
            topK: 5,
          });
          if (faceResult.facesDetected > 0 && faceResult.matches.length > 0) {
            collectedData.faceMatch = {
              topScore: faceResult.matches[0].score,
              matchedName: faceResult.matches[0].name,
              matchedSubjectId: faceResult.matches[0].subjectId,
              totalMatches: faceResult.matches.length,
            };
          } else if (faceResult.facesDetected > 0) {
            collectedData.faceMatch = { topScore: 0, matchedSubjectId: null };
          }
        }
      }

      // Bio comparison
      if (collectedData.bio && seed.knownBios?.length > 0) {
        collectedData.bioScore = await compareBiosSemantic(
          seed.knownBios, collectedData.bio, seed.name
        );
      }

      // Re-score with collected data
      const score = scoreCandidate(seed, c, collectedData);

      results.push({
        ...c,
        collected_data: collectedData,
        classification: score.classification,
        match_weight: score.weight,
        confidence: score.confidence,
        signals: score.signals,
        stage_reached: 2,
      });

      console.log(`[resolver] Stage 2: @${c.username} → ${score.classification} (weight: ${score.weight.toFixed(1)}, confidence: ${(score.confidence * 100).toFixed(0)}%)`);

      // Small delay between collections
      await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      console.error(`[resolver] Stage 2 error for @${c.username}:`, err.message);
      results.push({ ...c, stage_reached: 2 });
    }
  }

  const confirmed = results.filter(r => r.classification === "confirmed");
  const probable = results.filter(r => r.classification === "probable");
  const possible = results.filter(r => r.classification === "possible");
  const rejected = results.filter(r => r.classification === "rejected");

  console.log(`[resolver] Stage 2 complete: ${confirmed.length} confirmed, ${probable.length} probable, ${possible.length} possible, ${rejected.length} rejected`);

  return results;
}

// ── Main Orchestrator ──

/**
 * Resolve identities for a subject given raw discovery candidates.
 *
 * @param {number} subjectId - KG subject ID
 * @param {Array} rawCandidates - [{platform, username, profile_url, site}]
 * @param {object} opts - {maxStage: 2, maxAdbCollections: 10}
 * @returns {Array} scored candidates with classification
 */
async function resolveIdentities(subjectId, rawCandidates, opts = {}) {
  const maxStage = opts.maxStage || 2;
  const db = require("../db");

  // Build seed profile from existing KG data
  const seed = await buildSeedProfile(subjectId);

  console.log(`[resolver] Starting identity resolution for "${seed.name}" — ${rawCandidates.length} candidates`);
  console.log(`[resolver] Seed: ${seed.emails.length} emails, ${seed.knownUsernames.length} known usernames, ${seed.knownLocations.length} locations, ${seed.knownBios.length} bios`);

  // Deduplicate candidates by platform+username
  const seen = new Set();
  const uniqueCandidates = [];
  for (const c of rawCandidates) {
    const key = `${c.platform}:${c.username}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueCandidates.push(c);
  }

  // Stage 1: Username pattern (free)
  const stage1 = runStage1(seed, uniqueCandidates);

  // Store all candidates in DB
  for (const c of stage1.all) {
    await db.kgUpsertCandidate({
      subject_id: subjectId,
      platform: c.platform,
      username: c.username,
      profile_url: c.profile_url || null,
      classification: c.classification,
      match_weight: c.match_weight,
      confidence: c.confidence,
      signals: c.signals,
      stage_reached: 1,
    });
  }

  if (maxStage < 2) {
    return stage1.all;
  }

  // Stage 2: Profile collection (ADB)
  // Only run on candidates not yet rejected and not already confirmed
  const stage2Input = stage1.continuing.filter(c =>
    c.classification !== "confirmed" && c.classification !== "rejected"
  );
  const stage2Results = await runStage2(subjectId, seed, stage2Input, opts);

  // Update DB with stage 2 results
  for (const c of stage2Results) {
    await db.kgUpsertCandidate({
      subject_id: subjectId,
      platform: c.platform,
      username: c.username,
      profile_url: c.profile_url || null,
      classification: c.classification,
      match_weight: c.match_weight,
      confidence: c.confidence,
      signals: c.signals,
      collected_data: c.collected_data,
      stage_reached: c.stage_reached,
    });
  }

  // Combine results
  const allResults = [
    ...stage1.rejected,
    ...stage2Results,
  ];

  // Summary
  const summary = {
    total: allResults.length,
    confirmed: allResults.filter(r => r.classification === "confirmed").length,
    probable: allResults.filter(r => r.classification === "probable").length,
    possible: allResults.filter(r => r.classification === "possible").length,
    unlikely: allResults.filter(r => r.classification === "unlikely").length,
    rejected: allResults.filter(r => r.classification === "rejected").length,
  };
  console.log(`[resolver] Resolution complete:`, summary);

  return allResults;
}

/**
 * Build a seed profile from existing KG data for a subject.
 * Aggregates emails, usernames, bios, locations from anchors and facts.
 */
async function buildSeedProfile(subjectId) {
  const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subjectId}/dossier`);
  const dossier = await resp.json();

  const subject = dossier.subject || {};
  const anchors = dossier.anchors || [];
  const facts = dossier.facts || [];
  const observations = dossier.observations || [];

  const emails = anchors.filter(a => a.anchor_type === "email").map(a => a.value);
  const knownUsernames = anchors
    .filter(a => a.anchor_type === "social_handle")
    .map(a => a.value);

  // Also add email local parts as username candidates
  for (const email of emails) {
    const local = email.split("@")[0];
    if (local && !knownUsernames.includes(local)) knownUsernames.push(local);
  }

  // Locations from facts
  const knownLocations = facts
    .filter(f => f.category === "location" || f.key?.includes("location"))
    .map(f => f.value);

  // Bios from facts
  const knownBios = facts
    .filter(f => f.key?.includes("bio"))
    .map(f => f.value);

  // Join dates
  const knownJoinDates = facts
    .filter(f => f.key?.includes("joined"))
    .map(f => f.value);

  return {
    subjectId,
    name: subject.name || "",
    emails,
    knownUsernames,
    knownLocations,
    knownBios,
    knownJoinDates,
  };
}

module.exports = {
  resolveIdentities,
  buildSeedProfile,
  scoreCandidate,
  runStage1,
  runStage2,
  // Utilities exported for testing
  jaroWinkler,
  levenshtein,
  longestCommonSubstring,
  usernamePatternScore,
  usernameNameAffinity,
  extractUsernameFeatures,
  compareBiosSemantic,
  locationMatch,
  classify,
  weightToConfidence,
  THRESHOLDS,
};
