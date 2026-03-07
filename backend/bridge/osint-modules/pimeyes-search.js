// PimEyes Face Search — production face recognition API
// Requires $30/mo Pro subscription. Deferred to production use.
const db = require("../db");

module.exports = {
  name: "pimeyes-search",
  profileTypes: ["image"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const apiKey = process.env.PIMEYES_API_KEY;

    if (!apiKey) {
      findings.push({
        category: "identity",
        severity: "info",
        title: "PimEyes: API key not configured (deferred to production)",
        description: "PimEyes Pro ($30/mo) provides the most comprehensive face search with 900M+ indexed faces. Configure PIMEYES_API_KEY when ready for production.",
        rawData: {
          reason: "no_api_key",
          envVar: "PIMEYES_API_KEY",
          note: "Using in-house face search (Google Lens/Yandex/Bing + ArcFace) in the meantime",
        },
      });
      return findings;
    }

    // When API key is configured, use PimEyes API
    const image = await db.getOsintImageByProfile(profile.id);
    if (!image) {
      findings.push({ category: "identity", severity: "info", title: "PimEyes: no image available", rawData: { reason: "no_image" } });
      return findings;
    }

    const fs = require("fs");
    if (!fs.existsSync(image.file_path)) {
      findings.push({ category: "identity", severity: "info", title: "PimEyes: image file missing", rawData: { reason: "file_missing" } });
      return findings;
    }

    const release = await rateLimiter.acquire();
    try {
      const imageBuffer = fs.readFileSync(image.file_path);
      const base64 = imageBuffer.toString("base64");

      const res = await fetch("https://pimeyes.com/api/search/new", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          image: `data:${image.mime_type || "image/jpeg"};base64,${base64}`,
          search_type: "SEARCH_BY_FACE",
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        findings.push({ category: "identity", severity: "info", title: `PimEyes: API error (${res.status})`, rawData: { status: res.status } });
        return findings;
      }

      const data = await res.json();
      const results = data.results || [];

      if (results.length > 0) {
        findings.push({
          category: "identity",
          severity: "critical",
          title: `PimEyes: ${results.length} face match(es) found`,
          description: results.slice(0, 10).map(r =>
            `[${(r.score * 100).toFixed(1)}%] ${r.url}`
          ).join("\n"),
          rawData: {
            type: "pimeyes_matches",
            results: results.slice(0, 50),
            totalResults: results.length,
            pivotRecommended: true,
          },
        });
      } else {
        findings.push({
          category: "identity",
          severity: "info",
          title: "PimEyes: no face matches found",
          rawData: { type: "pimeyes_no_results" },
        });
      }
    } catch (err) {
      findings.push({ category: "identity", severity: "info", title: "PimEyes: request failed", rawData: { error: err.message } });
    } finally {
      release();
    }

    return findings;
  },
};
