// Identity Resolver Module — takes face search results + scene analysis → identity candidates
// Extracts usernames from URLs, names from pages, cross-references matches
const db = require("../db");

const SOCIAL_URL_PATTERNS = [
  { regex: /instagram\.com\/([^\/\?#]+)/, platform: "instagram" },
  { regex: /(?:twitter|x)\.com\/([^\/\?#]+)/, platform: "twitter" },
  { regex: /facebook\.com\/([^\/\?#]+)/, platform: "facebook" },
  { regex: /linkedin\.com\/in\/([^\/\?#]+)/, platform: "linkedin" },
  { regex: /tiktok\.com\/@([^\/\?#]+)/, platform: "tiktok" },
  { regex: /youtube\.com\/@([^\/\?#]+)/, platform: "youtube" },
  { regex: /reddit\.com\/user\/([^\/\?#]+)/, platform: "reddit" },
  { regex: /github\.com\/([^\/\?#]+)/, platform: "github" },
  { regex: /t\.me\/([^\/\?#]+)/, platform: "telegram" },
  { regex: /bsky\.app\/profile\/([^\/\?#]+)/, platform: "bluesky" },
  { regex: /mastodon\.\w+\/@([^\/\?#]+)/, platform: "mastodon" },
  { regex: /pinterest\.com\/([^\/\?#]+)/, platform: "pinterest" },
  { regex: /twitch\.tv\/([^\/\?#]+)/, platform: "twitch" },
  { regex: /medium\.com\/@([^\/\?#]+)/, platform: "medium" },
];

const SKIP_USERNAMES = new Set([
  "about", "help", "login", "signup", "settings", "explore", "search",
  "home", "messages", "notifications", "p", "reel", "stories", "share",
  "hashtag", "i", "intent", "compose", "status", "company", "jobs",
]);

module.exports = {
  name: "identity-resolver",
  profileTypes: ["image"],

  async scan(profile, rateLimiter) {
    const findings = [];

    // Collect all findings from face-search and scene-analysis for this profile
    const allFindings = await db.getOsintFindings({ profileId: profile.id, limit: 200 });

    const identityCandidates = new Map(); // name → { confidence, sources[], usernames[], emails[] }

    // 1. Extract identity guesses from search engines
    const faceSearchFindings = allFindings.filter(f => f.module === "face-search");
    for (const f of faceSearchFindings) {
      // Identity guesses (Google "best guess", Yandex entity detection)
      const guesses = f.raw_data?.identityGuesses || [];
      for (const guess of guesses) {
        const normalized = guess.trim().toLowerCase();
        if (normalized.length < 2 || normalized.length > 100) continue;
        addCandidate(identityCandidates, guess.trim(), "search_engine_guess", 0.7, f.module);
      }

      // Discovered profiles from face match URLs
      if (f.raw_data?.type === "discovered_profile") {
        const username = f.raw_data.username;
        const platform = f.raw_data.platform;
        if (username) {
          addCandidate(identityCandidates, username, `${platform}_profile`, 0.85, f.module);
        }
      }

      // Extract usernames from all verified match URLs
      const matches = f.raw_data?.verifiedMatches || [];
      for (const match of matches) {
        const extracted = extractFromUrl(match.sourceUrl);
        for (const e of extracted) {
          addCandidate(identityCandidates, e.username, `${e.platform}_url`,
            match.similarity > 0.6 ? 0.9 : 0.7, "face-search");
        }
      }

      // Extract from unverified source URLs too (lower confidence)
      const sourceUrls = f.raw_data?.sourceUrls || [];
      for (const url of sourceUrls.slice(0, 30)) {
        const extracted = extractFromUrl(url);
        for (const e of extracted) {
          addCandidate(identityCandidates, e.username, `${e.platform}_url_unverified`, 0.4, "face-search");
        }
      }
    }

    // 2. Extract from scene analysis
    const sceneFindings = allFindings.filter(f => f.module === "scene-analysis");
    for (const f of sceneFindings) {
      // Name tags
      const nameTagSeeds = f.raw_data?.nameTagSeeds || f.raw_data?.names || [];
      for (const name of nameTagSeeds) {
        addCandidate(identityCandidates, name, "name_tag", 0.8, "scene-analysis");
      }

      // Organization affiliations
      const orgSeeds = f.raw_data?.orgSeeds || f.raw_data?.organizations || [];
      for (const org of orgSeeds) {
        // Try to derive email patterns: firstname.lastname@org.com
        // Store as metadata on candidates
      }
    }

    // 3. Score and rank candidates
    const ranked = [];
    for (const [name, data] of identityCandidates) {
      // Boost confidence if multiple sources agree
      const sourceCount = new Set(data.sources.map(s => s.source)).size;
      const boostedConfidence = Math.min(1.0, data.confidence * (1 + (sourceCount - 1) * 0.15));

      ranked.push({
        name,
        confidence: boostedConfidence,
        sourceCount,
        sources: data.sources,
        platforms: [...new Set(data.sources.map(s => s.source.replace(/_.*/, "")))],
      });
    }

    ranked.sort((a, b) => b.confidence - a.confidence);

    if (ranked.length === 0) {
      findings.push({
        category: "identity",
        severity: "info",
        title: "Identity resolver: no identity candidates found",
        description: "Face search and scene analysis did not yield identity candidates.",
        rawData: { type: "no_candidates" },
      });
      return findings;
    }

    // 4. Report top candidates
    const topCandidates = ranked.slice(0, 20);

    findings.push({
      category: "identity",
      severity: topCandidates[0].confidence > 0.7 ? "high" : "medium",
      title: `Identity resolver: ${topCandidates.length} candidate(s) — top: "${topCandidates[0].name}" (${(topCandidates[0].confidence * 100).toFixed(0)}%)`,
      description: topCandidates.slice(0, 10).map((c, i) =>
        `${i + 1}. "${c.name}" — ${(c.confidence * 100).toFixed(0)}% confidence (${c.sourceCount} sources: ${c.platforms.join(", ")})`
      ).join("\n"),
      rawData: {
        candidates: topCandidates,
        type: "identity_candidates",
        pivotRecommended: true,
      },
    });

    // 5. Generate pivot recommendations
    // Only pivot on names that look like actual person names (not page titles, headings, etc.)
    const isPersonName = (name) => {
      if (!name || name.length < 3 || name.length > 60) return false;
      // Skip page titles and headings (contain separators or meta words)
      if (/[-–—|:@#]/.test(name)) return false;
      if (/\b(wikipedia|forbes|news|about|deep dive|highlights|search|wiki)\b/i.test(name)) return false;
      // Skip dimension strings, URLs, technical strings
      if (/^\d|https?:|www\.|\.com|\.org/.test(name)) return false;
      // Must have 2-4 words (typical for person names)
      const words = name.split(/\s+/).filter(w => w.length > 1);
      if (words.length < 2 || words.length > 5) return false;
      return true;
    };

    // Deduplicate name pivots — only pivot on the best Latin name
    const pivotedNames = new Set();

    for (const candidate of topCandidates.filter(c => c.confidence >= 0.5)) {
      // Recommend username search if looks like a username (no spaces, reasonable length)
      if (!candidate.name.includes(" ") && candidate.name.length <= 30) {
        findings.push({
          category: "identity",
          severity: "info",
          title: `Pivot recommended: scan username "${candidate.name}"`,
          description: `Identity candidate "${candidate.name}" should be scanned as a username profile. Confidence: ${(candidate.confidence * 100).toFixed(0)}%`,
          rawData: {
            type: "pivot_recommendation",
            pivotType: "username",
            pivotValue: candidate.name,
            confidence: candidate.confidence,
            autoExecute: candidate.confidence >= 0.7,
          },
        });
      }

      // If it looks like a full name, create name profile + generate username variants
      if (candidate.name.includes(" ") && isPersonName(candidate.name)) {
        const parts = candidate.name.split(/\s+/).filter(p => p.length > 1);
        const nameKey = candidate.name.toLowerCase().trim();
        if (parts.length >= 2 && !pivotedNames.has(nameKey)) {
          pivotedNames.add(nameKey);

          // First: create a "name" profile pivot for Wikipedia, news, social search
          findings.push({
            category: "identity",
            severity: "medium",
            title: `Pivot recommended: deep intel scan for "${candidate.name}"`,
            description: `Full name identified with ${(candidate.confidence * 100).toFixed(0)}% confidence. Will trigger Wikipedia, news, and social media intelligence gathering.`,
            rawData: {
              type: "pivot_recommendation",
              pivotType: "name",
              pivotValue: candidate.name,
              confidence: candidate.confidence,
              autoExecute: candidate.confidence >= 0.5, // Low threshold — names are high-value pivots
            },
          });

          // Then: username variants — only for Latin names (Cyrillic usernames are useless)
          const isLatin = /^[a-zA-Z\s\u00C0-\u024F]+$/.test(candidate.name);
          if (isLatin) {
            const first = parts[0].toLowerCase();
            const last = parts[parts.length - 1].toLowerCase();
            const variants = [
              `${first}${last}`,
              `${first}.${last}`,
              `${first}_${last}`,
              `${first}${last[0]}`,
              `${first[0]}${last}`,
            ];

            findings.push({
              category: "identity",
              severity: "info",
              title: `Pivot recommended: scan name variants for "${candidate.name}"`,
              description: `Username variants to try: ${variants.join(", ")}`,
              rawData: {
                type: "pivot_recommendation",
                pivotType: "name_variants",
                fullName: candidate.name,
                variants,
                confidence: candidate.confidence,
                autoExecute: candidate.confidence >= 0.7,
              },
            });
          }

          // Email patterns
          const emailDomains = getOrgDomains(allFindings);
          for (const domain of emailDomains.slice(0, 3)) {
            findings.push({
              category: "identity",
              severity: "info",
              title: `Pivot recommended: try email ${first}.${last}@${domain}`,
              rawData: {
                type: "pivot_recommendation",
                pivotType: "email",
                pivotValue: `${first}.${last}@${domain}`,
                confidence: candidate.confidence * 0.6,
              },
            });
          }
        }
      }
    }

    return findings;
  },
};

const GARBAGE_RE = /^\d+[×x]\d+$/; // dimension strings like "2924×3843"
const GENERIC_WORDS = new Set(["человек", "person", "people", "man", "woman", "photo", "image", "picture"]);

function addCandidate(map, name, source, confidence, module) {
  if (!name || name.length < 2) return;
  const key = name.toLowerCase().trim();
  if (SKIP_USERNAMES.has(key)) return;
  if (GARBAGE_RE.test(key) || GENERIC_WORDS.has(key)) return;

  if (!map.has(key)) {
    map.set(key, { confidence, sources: [] });
  }
  const entry = map.get(key);
  entry.confidence = Math.max(entry.confidence, confidence);
  entry.sources.push({ source, confidence, module });
}

function extractFromUrl(url) {
  if (!url) return [];
  const results = [];
  for (const pattern of SOCIAL_URL_PATTERNS) {
    const match = url.match(pattern.regex);
    if (match) {
      const username = match[1].toLowerCase();
      if (!SKIP_USERNAMES.has(username) && username.length > 1 && username.length < 50) {
        results.push({ platform: pattern.platform, username });
      }
    }
  }
  return results;
}

function getOrgDomains(findings) {
  const domains = new Set();
  for (const f of findings) {
    const orgs = f.raw_data?.orgSeeds || f.raw_data?.organizations?.logos || [];
    for (const org of orgs) {
      // Simple heuristic: "Google" → "google.com"
      const cleaned = org.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (cleaned.length > 2) domains.add(`${cleaned}.com`);
    }
  }
  return [...domains];
}
