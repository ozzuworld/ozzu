// Face Search Module — in-house PimEyes alternative
// Submits face to Google Lens, Yandex, Bing → scrapes results → ArcFace verification
const fs = require("fs");
const db = require("../db");
const faceSearchScraper = require("../face-search-scraper");

const FACE_API = "http://127.0.0.1:5555";
const MATCH_THRESHOLD = 0.4;

module.exports = {
  name: "face-search",
  profileTypes: ["image"],

  async scan(profile, rateLimiter) {
    const findings = [];

    // Get the uploaded image
    const image = await db.getOsintImageByProfile(profile.id);
    if (!image || !fs.existsSync(image.file_path)) {
      findings.push({
        category: "identity",
        severity: "info",
        title: "Face search: no image file available",
        rawData: { reason: "no_image_file" },
      });
      return findings;
    }

    // Check if face-recognition service is up
    try {
      const healthRes = await fetch(`${FACE_API}/health`, { signal: AbortSignal.timeout(3000) });
      if (!healthRes.ok) throw new Error("not healthy");
    } catch {
      findings.push({
        category: "identity",
        severity: "info",
        title: "Face search: face recognition service unavailable",
        rawData: { reason: "service_down" },
      });
      return findings;
    }

    // Extract face embedding from uploaded image
    const release = await rateLimiter.acquire();
    let originalEmbedding = null;
    try {
      const imageBuffer = fs.readFileSync(image.file_path);
      const form = new URLSearchParams();
      form.append("base64_image", imageBuffer.toString("base64"));
      const embedRes = await fetch(`${FACE_API}/embed`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(15000),
      });
      if (embedRes.ok) {
        const data = await embedRes.json();
        if (data.faces?.length > 0) {
          originalEmbedding = data.faces[0];
        }
      }
    } finally {
      release();
    }

    if (!originalEmbedding) {
      findings.push({
        category: "identity",
        severity: "info",
        title: "Face search: no face detected in uploaded image",
        rawData: { reason: "no_face_detected" },
      });
      return findings;
    }

    // Run reverse image search across engines
    const release2 = await rateLimiter.acquire();
    let searchResults;
    try {
      searchResults = await faceSearchScraper.searchFace(image.file_path);
    } finally {
      release2();
    }

    if (!searchResults || searchResults.totalResults === 0) {
      findings.push({
        category: "identity",
        severity: "info",
        title: "Face search: no reverse image results found",
        description: "Google Lens, Yandex, and Bing returned no matching results.",
        rawData: { engines: searchResults?.engines || {}, reason: "no_results" },
      });
      return findings;
    }

    // Report identity guesses from search engines
    if (searchResults.identityGuesses.length > 0) {
      findings.push({
        category: "identity",
        severity: "high",
        title: `Face search: identity candidates — ${searchResults.identityGuesses.join(", ")}`,
        description: `Search engines suggest this face belongs to: ${searchResults.identityGuesses.join(", ")}`,
        rawData: {
          identityGuesses: searchResults.identityGuesses,
          type: "identity_candidates",
        },
      });
    }

    // Verify face matches from result images via ArcFace
    const verifiedMatches = [];
    const urlsToVerify = searchResults.results
      .filter(r => r.imageUrl && r.imageUrl.startsWith("http"))
      .slice(0, 20); // Limit to 20 verifications

    for (const result of urlsToVerify) {
      const release3 = await rateLimiter.acquire();
      try {
        const matchData = await faceSearchScraper.verifyFaceMatch(image.file_path, result.imageUrl);
        if (matchData && matchData.similarity >= MATCH_THRESHOLD) {
          verifiedMatches.push({
            sourceUrl: result.sourceUrl,
            imageUrl: result.imageUrl,
            similarity: matchData.similarity,
            engine: result.engine,
            title: result.title,
          });
        }
      } catch (_) {} finally {
        release3();
      }
    }

    // Report verified face matches
    if (verifiedMatches.length > 0) {
      verifiedMatches.sort((a, b) => b.similarity - a.similarity);

      findings.push({
        category: "identity",
        severity: "critical",
        title: `Face search: ${verifiedMatches.length} verified face match(es) found online`,
        description: verifiedMatches.slice(0, 10).map(m =>
          `[${(m.similarity * 100).toFixed(1)}%] ${m.title || m.sourceUrl}\n  Source: ${m.sourceUrl}`
        ).join("\n\n"),
        rawData: {
          verifiedMatches,
          totalSearchResults: searchResults.totalResults,
          engines: searchResults.engines,
          type: "verified_face_matches",
        },
        remediation: "These URLs contain images matching the uploaded face. Review each source for identity information.",
      });

      // Extract social media profiles from verified match URLs
      const socialPatterns = [
        { regex: /instagram\.com\/([^\/\?]+)/, platform: "instagram" },
        { regex: /twitter\.com\/([^\/\?]+)/, platform: "twitter" },
        { regex: /x\.com\/([^\/\?]+)/, platform: "twitter" },
        { regex: /facebook\.com\/([^\/\?]+)/, platform: "facebook" },
        { regex: /linkedin\.com\/in\/([^\/\?]+)/, platform: "linkedin" },
        { regex: /tiktok\.com\/@([^\/\?]+)/, platform: "tiktok" },
        { regex: /youtube\.com\/@([^\/\?]+)/, platform: "youtube" },
        { regex: /youtube\.com\/channel\/([^\/\?]+)/, platform: "youtube" },
        { regex: /reddit\.com\/user\/([^\/\?]+)/, platform: "reddit" },
        { regex: /github\.com\/([^\/\?]+)/, platform: "github" },
        { regex: /t\.me\/([^\/\?]+)/, platform: "telegram" },
      ];

      const discoveredProfiles = new Set();
      for (const match of verifiedMatches) {
        for (const pattern of socialPatterns) {
          const urlMatch = (match.sourceUrl || "").match(pattern.regex);
          if (urlMatch) {
            const username = urlMatch[1].toLowerCase();
            if (!discoveredProfiles.has(`${pattern.platform}:${username}`)) {
              discoveredProfiles.add(`${pattern.platform}:${username}`);
              findings.push({
                category: "identity",
                severity: "high",
                title: `Face search: ${pattern.platform} profile discovered — ${username}`,
                description: `Face match found on ${pattern.platform} profile: ${match.sourceUrl}`,
                sourceUrl: match.sourceUrl,
                rawData: {
                  platform: pattern.platform,
                  username,
                  similarity: match.similarity,
                  type: "discovered_profile",
                  pivotRecommended: true,
                },
              });
            }
          }
        }
      }
    }

    // Report all source URLs (even without face verification)
    const sourceUrls = searchResults.results.map(r => r.sourceUrl).filter(Boolean);
    if (sourceUrls.length > 0 && verifiedMatches.length === 0) {
      findings.push({
        category: "identity",
        severity: "medium",
        title: `Face search: ${sourceUrls.length} potential match pages found`,
        description: `Reverse image search found ${sourceUrls.length} pages that may contain this face.\n${sourceUrls.slice(0, 10).join("\n")}`,
        rawData: {
          sourceUrls: sourceUrls.slice(0, 50),
          engines: searchResults.engines,
          type: "unverified_matches",
          note: "Face verification could not run on these (no direct image URL extracted)",
        },
      });
    }

    return findings;
  },
};
