// Wikipedia/Wikidata Intelligence Module — structured person data from open knowledge graph
// Extracts: birth date, nationality, occupations, family, positions held, organizations, net worth
// FREE, no API key, no rate limits

async function safeFetchJson(url, timeout = 10000) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "OzzuIntel/1.0 (OSINT research)" },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

module.exports = {
  name: "wikipedia-intel",
  profileTypes: ["name", "username"],

  async scan(profile) {
    const findings = [];
    const query = profile.value || profile.label;
    if (!query || query.length < 2) return findings;

    // 1. Search Wikidata for entity
    const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&format=json&limit=5&type=item`;
    const searchResult = await safeFetchJson(searchUrl);
    if (!searchResult?.search?.length) {
      findings.push({ category: "intelligence", severity: "info", title: "Wikipedia: no entity found", rawData: { type: "wikipedia_miss", query } });
      return findings;
    }

    const entity = searchResult.search[0];
    const entityId = entity.id;
    const entityLabel = entity.label;

    // 2. Get full Wikidata entity with claims
    const entityUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${entityId}&languages=en&props=claims|descriptions|aliases|sitelinks&format=json`;
    const entityData = await safeFetchJson(entityUrl, 15000);
    const claims = entityData?.entities?.[entityId]?.claims || {};
    const description = entityData?.entities?.[entityId]?.descriptions?.en?.value || "";
    const aliases = (entityData?.entities?.[entityId]?.aliases?.en || []).map(a => a.value);
    const sitelinks = entityData?.entities?.[entityId]?.sitelinks || {};

    // 3. Extract structured data from claims
    const structured = {};

    // Birth date (P569)
    const birthClaim = claims.P569?.[0]?.mainsnak?.datavalue?.value?.time;
    if (birthClaim) structured.birthDate = birthClaim.replace("+", "").split("T")[0];

    // Death date (P570)
    const deathClaim = claims.P570?.[0]?.mainsnak?.datavalue?.value?.time;
    if (deathClaim) structured.deathDate = deathClaim.replace("+", "").split("T")[0];

    // Nationality/citizenship (P27)
    if (claims.P27) {
      structured.citizenship = [];
      for (const c of claims.P27) {
        const cid = c.mainsnak?.datavalue?.value?.id;
        if (cid) {
          const label = await resolveEntityLabel(cid);
          if (label) structured.citizenship.push(label);
        }
      }
    }

    // Occupation (P106)
    if (claims.P106) {
      structured.occupations = [];
      for (const c of claims.P106.slice(0, 10)) {
        const cid = c.mainsnak?.datavalue?.value?.id;
        if (cid) {
          const label = await resolveEntityLabel(cid);
          if (label) structured.occupations.push(label);
        }
      }
    }

    // Employer/organization (P108)
    if (claims.P108) {
      structured.employers = [];
      for (const c of claims.P108.slice(0, 10)) {
        const cid = c.mainsnak?.datavalue?.value?.id;
        if (cid) {
          const label = await resolveEntityLabel(cid);
          if (label) structured.employers.push(label);
        }
      }
    }

    // Positions held (P39)
    if (claims.P39) {
      structured.positions = [];
      for (const c of claims.P39.slice(0, 10)) {
        const cid = c.mainsnak?.datavalue?.value?.id;
        if (cid) {
          const label = await resolveEntityLabel(cid);
          if (label) structured.positions.push(label);
        }
      }
    }

    // Spouse (P26)
    if (claims.P26) {
      structured.spouses = [];
      for (const c of claims.P26) {
        const cid = c.mainsnak?.datavalue?.value?.id;
        if (cid) {
          const label = await resolveEntityLabel(cid);
          if (label) structured.spouses.push(label);
        }
      }
    }

    // Children (P40)
    if (claims.P40) {
      structured.children = [];
      for (const c of claims.P40.slice(0, 15)) {
        const cid = c.mainsnak?.datavalue?.value?.id;
        if (cid) {
          const label = await resolveEntityLabel(cid);
          if (label) structured.children.push(label);
        }
      }
    }

    // Education (P69)
    if (claims.P69) {
      structured.education = [];
      for (const c of claims.P69.slice(0, 10)) {
        const cid = c.mainsnak?.datavalue?.value?.id;
        if (cid) {
          const label = await resolveEntityLabel(cid);
          if (label) structured.education.push(label);
        }
      }
    }

    // Net worth (P2218)
    const netWorthClaim = claims.P2218?.[0]?.mainsnak?.datavalue?.value;
    if (netWorthClaim) {
      structured.netWorth = {
        amount: netWorthClaim.amount,
        unit: netWorthClaim.unit?.split("/").pop(),
      };
    }

    // Website (P856)
    const website = claims.P856?.[0]?.mainsnak?.datavalue?.value;
    if (website) structured.website = website;

    // Social media accounts
    const socialProps = {
      P2002: "twitter", P2003: "instagram", P2013: "facebook",
      P2037: "github", P2397: "youtube", P4003: "tiktok",
      P4033: "mastodon", P6634: "linkedin",
    };
    structured.socialAccounts = {};
    for (const [prop, platform] of Object.entries(socialProps)) {
      const val = claims[prop]?.[0]?.mainsnak?.datavalue?.value;
      if (val) structured.socialAccounts[platform] = val;
    }

    // 4. Get Wikipedia article extract
    const wpTitle = sitelinks.enwiki?.title;
    let articleExtract = null;
    if (wpTitle) {
      const wpUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=true&explaintext=true&titles=${encodeURIComponent(wpTitle)}&format=json`;
      const wpData = await safeFetchJson(wpUrl);
      const pages = wpData?.query?.pages;
      if (pages) {
        const page = Object.values(pages)[0];
        articleExtract = page?.extract?.substring(0, 2000);
      }
    }

    // 5. Create findings
    const fieldCount = Object.keys(structured).filter(k => {
      const v = structured[k];
      return v && (typeof v === "string" || (Array.isArray(v) && v.length > 0) || (typeof v === "object" && Object.keys(v).length > 0));
    }).length;

    findings.push({
      category: "intelligence",
      severity: fieldCount > 5 ? "high" : "medium",
      title: `Wikipedia: ${entityLabel} — ${fieldCount} data fields extracted`,
      description: [
        description,
        structured.birthDate ? `Born: ${structured.birthDate}` : null,
        structured.citizenship?.length ? `Nationality: ${structured.citizenship.join(", ")}` : null,
        structured.occupations?.length ? `Occupations: ${structured.occupations.join(", ")}` : null,
        structured.employers?.length ? `Organizations: ${structured.employers.join(", ")}` : null,
        structured.positions?.length ? `Positions: ${structured.positions.join(", ")}` : null,
      ].filter(Boolean).join("\n"),
      rawData: {
        type: "wikipedia_profile",
        entityId,
        entityLabel,
        description,
        aliases,
        structured,
        articleExtract,
        wikipediaUrl: wpTitle ? `https://en.wikipedia.org/wiki/${encodeURIComponent(wpTitle)}` : null,
        wikidataUrl: `https://www.wikidata.org/wiki/${entityId}`,
      },
    });

    // Extract social accounts as separate findings for pivoting
    for (const [platform, username] of Object.entries(structured.socialAccounts)) {
      findings.push({
        category: "identity",
        severity: "medium",
        title: `Wikipedia: ${platform} account — @${username}`,
        rawData: {
          type: "discovered_profile",
          platform,
          username,
          source: "wikidata",
          confidence: 0.95,
          pivotRecommended: true,
        },
      });
    }

    // Family members as pivot recommendations
    const familyMembers = [...(structured.spouses || []), ...(structured.children || [])];
    for (const member of familyMembers.slice(0, 5)) {
      findings.push({
        category: "intelligence",
        severity: "info",
        title: `Wikipedia: family member — ${member}`,
        rawData: {
          type: "pivot_recommendation",
          pivotType: "name",
          pivotValue: member,
          confidence: 0.6,
          autoExecute: false,
          relationship: structured.spouses?.includes(member) ? "spouse" : "child",
        },
      });
    }

    return findings;
  },
};

// Resolve Wikidata entity ID to human-readable label
const _labelCache = new Map();
async function resolveEntityLabel(entityId) {
  if (_labelCache.has(entityId)) return _labelCache.get(entityId);
  try {
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${entityId}&languages=en&props=labels&format=json`;
    const data = await safeFetchJson(url, 5000);
    const label = data?.entities?.[entityId]?.labels?.en?.value || null;
    _labelCache.set(entityId, label);
    return label;
  } catch {
    return null;
  }
}
