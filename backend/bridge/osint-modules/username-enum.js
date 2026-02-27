// Username enumeration module — Sherlock-style HTTP checks
// 350+ platforms loaded from external JSON (username-platforms.json)
// Supports 3 detection modes: status_code, redirect, response_url
// No API keys needed, just HTTP requests to public profile URLs

const path = require("path");

// Load platforms from external JSON
const PLATFORMS = require(path.join(__dirname, "username-platforms.json"));

// Batch size for parallel checks — groups of 20 to avoid IP blocks
const BATCH_SIZE = 20;

module.exports = {
  name: "username-enum",
  profileTypes: ["username"],

  async scan(profile, rateLimiter) {
    const username = profile.value;
    const findings = [];

    const checkPlatform = async (platform) => {
      const release = await rateLimiter.acquire();
      try {
        const profileUrl = platform.url.replace("{}", username);
        const controller = new AbortController();
        const siteTimeout = platform.timeout || 8000;
        const timer = setTimeout(() => controller.abort(), siteTimeout);

        try {
          const res = await fetch(profileUrl, {
            method: "HEAD",
            signal: controller.signal,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
            redirect: "manual",
          });
          clearTimeout(timer);

          let found = false;
          const errorType = platform.errorType || "status_code";

          if (errorType === "status_code") {
            // Default: HTTP 200 or 3xx redirect = account exists
            found = res.status === 200 || (res.status >= 300 && res.status < 400);
          } else if (errorType === "redirect") {
            // Redirect-based: if redirect goes to errorUrl, account doesn't exist
            if (res.status >= 300 && res.status < 400) {
              const location = res.headers.get("location") || "";
              found = !platform.errorUrl || !location.includes(platform.errorUrl);
            } else {
              found = res.status === 200;
            }
          } else if (errorType === "response_url") {
            // Response URL check
            found = res.status === 200;
          }

          if (found) {
            return {
              category: "account_found",
              severity: "medium",
              title: `Account found on ${platform.name}`,
              description: `Username "${username}" has an active profile on ${platform.name}. This publicly associates this username with the platform.`,
              sourceUrl: profileUrl,
              rawData: { platform: platform.name, status: res.status, category: platform.category, found: true },
              remediation: `Review your ${platform.name} profile privacy settings. Consider removing or anonymizing the account if it's not needed.`,
            };
          }
        } catch (err) {
          clearTimeout(timer);
          // Timeout or network error — skip silently
        }
        return null;
      } finally {
        release();
      }
    };

    // Run in batches to avoid overwhelming targets
    for (let i = 0; i < PLATFORMS.length; i += BATCH_SIZE) {
      const batch = PLATFORMS.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(checkPlatform));
      for (const result of results) {
        if (result) findings.push(result);
      }
    }

    // If no accounts found, add info-level finding
    if (findings.length === 0) {
      findings.push({
        category: "account_found",
        severity: "info",
        title: "No accounts found across checked platforms",
        description: `Username "${username}" was not found on any of the ${PLATFORMS.length} platforms checked. This is a good sign for username privacy.`,
        rawData: { platformsChecked: PLATFORMS.length },
        remediation: null,
      });
    }

    return findings;
  },
};
