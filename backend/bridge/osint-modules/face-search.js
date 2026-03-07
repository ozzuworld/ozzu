// Face Search Module — biometric face identification via ArcFace + Qdrant
// Replaces broken reverse-image-search approach with proper embedding-based matching
const fs = require("fs");
const db = require("../db");
const faceEngine = require("../face-engine");

const FACE_API = "http://127.0.0.1:5555";

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
      const health = await healthRes.json();
      if (!health.qdrant) {
        findings.push({
          category: "identity",
          severity: "info",
          title: "Face search: Qdrant vector DB not available",
          rawData: { reason: "qdrant_down" },
        });
        return findings;
      }
    } catch {
      findings.push({
        category: "identity",
        severity: "info",
        title: "Face search: face recognition service unavailable",
        rawData: { reason: "service_down" },
      });
      return findings;
    }

    // Run the face search pipeline
    const release = await rateLimiter.acquire();
    let result;
    try {
      result = await faceEngine.runFaceSearch(image.file_path, profile.id, {
        label: profile.label || profile.value || "",
      });
    } finally {
      release();
    }

    if (result.error) {
      findings.push({
        category: "identity",
        severity: "info",
        title: `Face search: ${result.error}`,
        rawData: { reason: "pipeline_error", error: result.error },
      });
      return findings;
    }

    // Report identity guesses from search engines
    if (result.identityGuesses?.length > 0) {
      findings.push({
        category: "identity",
        severity: "high",
        title: `Face search: identity candidates — ${result.identityGuesses.join(", ")}`,
        description: `Search engines suggest this face belongs to: ${result.identityGuesses.join(", ")}`,
        rawData: {
          identityGuesses: result.identityGuesses,
          type: "identity_candidates",
        },
      });
    }

    // Report verified face matches (biometric, not visual similarity)
    if (result.matches?.length > 0) {
      findings.push({
        category: "identity",
        severity: "critical",
        title: `Face match: ${result.matches.length} biometric match(es) confirmed`,
        description: result.matches.slice(0, 10).map(m =>
          `[${(m.similarity * 100).toFixed(1)}% match] ${m.label || m.sourceUrl || m.imageUrl}\n  Source: ${m.sourceUrl || m.imageUrl}\n  Engine: ${m.engine}`
        ).join("\n\n"),
        rawData: {
          verifiedMatches: result.matches,
          totalProcessed: result.totalProcessed,
          totalIndexed: result.totalIndexed,
          engines: result.engines,
          type: "biometric_face_matches",
        },
        remediation: "These matches are biometric — ArcFace confirmed the same person appears in these images.",
      });

      // Extract social media profiles from match URLs
      const socialPatterns = [
        { regex: /instagram\.com\/([^\/\?]+)/, platform: "instagram" },
        { regex: /twitter\.com\/([^\/\?]+)/, platform: "twitter" },
        { regex: /x\.com\/([^\/\?]+)/, platform: "twitter" },
        { regex: /facebook\.com\/([^\/\?]+)/, platform: "facebook" },
        { regex: /linkedin\.com\/in\/([^\/\?]+)/, platform: "linkedin" },
        { regex: /tiktok\.com\/@([^\/\?]+)/, platform: "tiktok" },
        { regex: /youtube\.com\/@([^\/\?]+)/, platform: "youtube" },
        { regex: /reddit\.com\/user\/([^\/\?]+)/, platform: "reddit" },
        { regex: /github\.com\/([^\/\?]+)/, platform: "github" },
        { regex: /t\.me\/([^\/\?]+)/, platform: "telegram" },
        { regex: /vk\.com\/([^\/\?]+)/, platform: "vk" },
      ];

      const discoveredProfiles = new Set();
      for (const match of result.matches) {
        const urls = [match.sourceUrl, match.imageUrl].filter(Boolean);
        for (const url of urls) {
          for (const pattern of socialPatterns) {
            const urlMatch = url.match(pattern.regex);
            if (urlMatch) {
              const username = urlMatch[1].toLowerCase();
              const key = `${pattern.platform}:${username}`;
              if (!discoveredProfiles.has(key)) {
                discoveredProfiles.add(key);
                findings.push({
                  category: "identity",
                  severity: "high",
                  title: `Face match: ${pattern.platform} profile — ${username}`,
                  description: `Biometric face match found on ${pattern.platform}: ${url} (${(match.similarity * 100).toFixed(1)}% similarity)`,
                  sourceUrl: url,
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
    }

    // Report pipeline stats
    const stats = await faceEngine.getStats();
    findings.push({
      category: "identity",
      severity: "info",
      title: `Face search stats: ${result.totalProcessed} candidates processed, ${result.matches?.length || 0} confirmed matches`,
      rawData: {
        type: "search_stats",
        totalProcessed: result.totalProcessed,
        totalScraped: result.totalScraped,
        totalIndexed: result.totalIndexed,
        matchCount: result.matches?.length || 0,
        engines: result.engines,
        qdrantStats: stats,
      },
    });

    return findings;
  },
};
