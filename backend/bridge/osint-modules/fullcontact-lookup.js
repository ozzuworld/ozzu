// FullContact API Lookup — unified person profile from email/phone
// Free tier: 100 lookups/month
const db = require("../db");

module.exports = {
  name: "fullcontact-lookup",
  profileTypes: ["email", "phone"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const apiKey = process.env.FULLCONTACT_API_KEY;

    if (!apiKey) {
      findings.push({
        category: "identity",
        severity: "info",
        title: "FullContact: API key not configured",
        rawData: { reason: "no_api_key", envVar: "FULLCONTACT_API_KEY" },
      });
      return findings;
    }

    const release = await rateLimiter.acquire();
    try {
      const body = profile.profile_type === "email"
        ? { email: profile.value }
        : { phone: profile.value };

      const res = await fetch("https://api.fullcontact.com/v3/person.enrich", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });

      if (res.status === 404 || res.status === 422) {
        findings.push({
          category: "identity",
          severity: "info",
          title: "FullContact: no profile found",
          rawData: { status: res.status },
        });
        return findings;
      }

      if (!res.ok) {
        findings.push({
          category: "identity",
          severity: "info",
          title: `FullContact: API error (${res.status})`,
          rawData: { status: res.status },
        });
        return findings;
      }

      const data = await res.json();

      const parts = [];
      if (data.fullName) parts.push(`Name: ${data.fullName}`);
      if (data.gender) parts.push(`Gender: ${data.gender}`);
      if (data.ageRange) parts.push(`Age range: ${data.ageRange}`);
      if (data.location) parts.push(`Location: ${data.location}`);
      if (data.title) parts.push(`Title: ${data.title}`);
      if (data.organization) parts.push(`Organization: ${data.organization}`);
      if (data.twitter) parts.push(`Twitter: ${data.twitter}`);
      if (data.linkedin) parts.push(`LinkedIn: ${data.linkedin}`);

      const socialProfiles = data.details?.profiles || {};
      for (const [platform, profile_] of Object.entries(socialProfiles)) {
        parts.push(`${platform}: ${profile_.url || profile_.username || "linked"}`);
      }

      findings.push({
        category: "identity",
        severity: parts.length > 2 ? "high" : "medium",
        title: `FullContact: ${data.fullName || "profile"} — ${parts.length} data points`,
        description: parts.join("\n"),
        rawData: {
          type: "fullcontact_enrichment",
          ...data,
          pivotRecommended: !!data.fullName,
        },
      });
    } catch (err) {
      if (err.name !== "AbortError") {
        findings.push({
          category: "identity",
          severity: "info",
          title: "FullContact: request failed",
          rawData: { error: err.message },
        });
      }
    } finally {
      release();
    }

    return findings;
  },
};
