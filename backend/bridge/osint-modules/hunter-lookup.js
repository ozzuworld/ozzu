// Hunter.io Lookup — find emails at a domain, verify email addresses
// Free tier: 25 searches/month
const db = require("../db");

module.exports = {
  name: "hunter-lookup",
  profileTypes: ["domain", "email"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const apiKey = process.env.HUNTER_API_KEY;

    if (!apiKey) {
      findings.push({
        category: "identity",
        severity: "info",
        title: "Hunter.io: API key not configured",
        rawData: { reason: "no_api_key", envVar: "HUNTER_API_KEY" },
      });
      return findings;
    }

    const release = await rateLimiter.acquire();
    try {
      if (profile.profile_type === "domain") {
        // Domain search — find emails at this domain
        const res = await fetch(
          `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(profile.value)}&api_key=${apiKey}&limit=20`,
          { signal: AbortSignal.timeout(15000) }
        );

        if (!res.ok) {
          findings.push({ category: "identity", severity: "info", title: `Hunter.io: API error (${res.status})`, rawData: { status: res.status } });
          return findings;
        }

        const data = await res.json();
        const emails = data.data?.emails || [];

        if (emails.length > 0) {
          findings.push({
            category: "identity",
            severity: "high",
            title: `Hunter.io: ${emails.length} email(s) found at ${profile.value}`,
            description: emails.slice(0, 10).map(e =>
              `${e.value} (${e.type || "unknown"}) — ${e.first_name || ""} ${e.last_name || ""}`.trim()
            ).join("\n"),
            rawData: {
              type: "hunter_domain_search",
              emails: emails.map(e => ({
                email: e.value,
                type: e.type,
                firstName: e.first_name,
                lastName: e.last_name,
                confidence: e.confidence,
                position: e.position,
              })),
              domain: profile.value,
              organization: data.data?.organization,
              pivotRecommended: true,
            },
          });
        } else {
          findings.push({
            category: "identity",
            severity: "info",
            title: `Hunter.io: no emails found at ${profile.value}`,
            rawData: { type: "hunter_no_results" },
          });
        }
      } else if (profile.profile_type === "email") {
        // Email verification
        const res = await fetch(
          `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(profile.value)}&api_key=${apiKey}`,
          { signal: AbortSignal.timeout(15000) }
        );

        if (!res.ok) {
          findings.push({ category: "identity", severity: "info", title: `Hunter.io: API error (${res.status})`, rawData: { status: res.status } });
          return findings;
        }

        const data = await res.json();
        const result = data.data || {};

        findings.push({
          category: "identity",
          severity: result.status === "valid" ? "medium" : "info",
          title: `Hunter.io: email ${result.status || "unknown"} — ${profile.value}`,
          description: `Status: ${result.status}, Score: ${result.score}, Disposable: ${result.disposable ? "yes" : "no"}, Webmail: ${result.webmail ? "yes" : "no"}`,
          rawData: {
            type: "hunter_email_verify",
            ...result,
          },
        });
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        findings.push({ category: "identity", severity: "info", title: "Hunter.io: request failed", rawData: { error: err.message } });
      }
    } finally {
      release();
    }

    return findings;
  },
};
