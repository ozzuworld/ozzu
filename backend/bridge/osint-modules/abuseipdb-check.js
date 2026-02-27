// AbuseIPDB IP reputation — abuse reports, confidence scoring
// Free tier: 1000 checks/day
module.exports = {
  name: "abuseipdb-check",
  profileTypes: ["ip"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const apiKey = process.env.ABUSEIPDB_API_KEY;

    if (!apiKey) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "AbuseIPDB skipped — no API key",
        description: "Set ABUSEIPDB_API_KEY for IP abuse reputation (free: 1000 checks/day).",
        rawData: { reason: "no_api_key" },
      });
      return findings;
    }

    const release = await rateLimiter.acquire();
    try {
      const res = await fetch(
        `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(profile.value)}&maxAgeInDays=90&verbose`,
        {
          headers: { Key: apiKey, Accept: "application/json" },
          signal: AbortSignal.timeout(15000),
        }
      );

      if (!res.ok) {
        findings.push({
          category: "metadata",
          severity: "info",
          title: `AbuseIPDB error: HTTP ${res.status}`,
          rawData: { error: `HTTP ${res.status}`, source: "abuseipdb" },
        });
        return findings;
      }

      const json = await res.json();
      const d = json.data || {};

      const score = d.abuseConfidenceScore || 0;
      const reports = d.totalReports || 0;

      if (score > 50 || reports > 10) {
        findings.push({
          category: "exposure",
          severity: score > 75 ? "critical" : score > 50 ? "high" : "medium",
          title: `AbuseIPDB: ${score}% abuse confidence, ${reports} report(s)`,
          description: [
            `Abuse confidence: ${score}%`,
            `Total reports: ${reports}`,
            `ISP: ${d.isp || "unknown"}`,
            `Usage: ${d.usageType || "unknown"}`,
            `Country: ${d.countryCode || "unknown"}`,
            d.domain ? `Domain: ${d.domain}` : null,
          ].filter(Boolean).join("\n"),
          rawData: {
            abuseConfidenceScore: score,
            totalReports: reports,
            isp: d.isp,
            usageType: d.usageType,
            countryCode: d.countryCode,
            domain: d.domain,
            isWhitelisted: d.isWhitelisted,
            source: "abuseipdb",
          },
          remediation: score > 75
            ? "This IP has a very high abuse score. It may be compromised or part of a botnet."
            : "This IP has been reported for abuse. Monitor for suspicious activity.",
        });
      } else {
        findings.push({
          category: "metadata",
          severity: "info",
          title: `AbuseIPDB: clean (${score}% abuse, ${reports} reports)`,
          description: `ISP: ${d.isp || "unknown"} | Usage: ${d.usageType || "unknown"} | Country: ${d.countryCode || "unknown"}`,
          rawData: {
            abuseConfidenceScore: score,
            totalReports: reports,
            isp: d.isp,
            usageType: d.usageType,
            countryCode: d.countryCode,
            source: "abuseipdb",
          },
        });
      }
    } catch (err) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "AbuseIPDB request failed",
        description: err.message,
        rawData: { error: err.message, source: "abuseipdb" },
      });
    } finally {
      release();
    }

    return findings;
  },
};
