// AbuseIPDB lookup module — IP reputation and abuse history
// Free tier: 1000 checks/day
// API docs: https://docs.abuseipdb.com/

module.exports = {
  name: "abuseipdb-lookup",
  profileTypes: ["ip"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const apiKey = process.env.ABUSEIPDB_API_KEY;

    if (!apiKey) {
      findings.push({
        category: "infrastructure",
        severity: "info",
        title: "AbuseIPDB scan skipped — no API key",
        description: "Set ABUSEIPDB_API_KEY for IP reputation checks. Free tier: 1000 checks/day at abuseipdb.com.",
        rawData: { reason: "no_abuseipdb_api_key" },
      });
      return findings;
    }

    const ip = profile.value;

    const release = await rateLimiter.acquire();
    try {
      const url = `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90&verbose`;
      const res = await fetch(url, {
        headers: {
          "Key": apiKey,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        if (res.status === 401) throw new Error("Invalid AbuseIPDB API key");
        if (res.status === 429) throw new Error("AbuseIPDB rate limit exceeded");
        throw new Error(`AbuseIPDB API error: ${res.status}`);
      }

      const json = await res.json();
      const data = json.data;

      if (!data) {
        findings.push({
          category: "infrastructure",
          severity: "info",
          title: `AbuseIPDB: No data for ${ip}`,
          rawData: { ip },
        });
        return findings;
      }

      const confidence = data.abuseConfidenceScore || 0;
      const totalReports = data.totalReports || 0;

      // Determine severity based on abuse confidence
      let severity = "info";
      if (confidence > 80) severity = "critical";
      else if (confidence > 50) severity = "high";
      else if (confidence > 20) severity = "medium";
      else if (totalReports > 0) severity = "low";

      findings.push({
        category: "infrastructure",
        severity,
        title: `AbuseIPDB: ${confidence}% abuse confidence for ${ip}`,
        description: [
          `Abuse Confidence: ${confidence}%`,
          `Total Reports: ${totalReports}`,
          `ISP: ${data.isp || "N/A"}`,
          `Usage Type: ${data.usageType || "N/A"}`,
          `Domain: ${data.domain || "N/A"}`,
          `Country: ${data.countryCode || "N/A"}`,
          `Whitelisted: ${data.isWhitelisted ? "Yes" : "No"}`,
        ].join("\n"),
        sourceUrl: `https://www.abuseipdb.com/check/${ip}`,
        rawData: {
          ip,
          abuseConfidenceScore: confidence,
          totalReports,
          isp: data.isp,
          usageType: data.usageType,
          domain: data.domain,
          countryCode: data.countryCode,
          isWhitelisted: data.isWhitelisted,
          lastReportedAt: data.lastReportedAt,
        },
        remediation: confidence > 50
          ? "This IP has been reported for abuse. If this is your IP, check for compromise. If external, consider blocking."
          : null,
      });

      // Recent reports
      if (data.reports && data.reports.length > 0) {
        const categories = {};
        for (const report of data.reports) {
          for (const cat of (report.categories || [])) {
            categories[cat] = (categories[cat] || 0) + 1;
          }
        }

        const catLabels = {
          1: "DNS Compromise", 2: "DNS Poisoning", 3: "Fraud Orders",
          4: "DDoS Attack", 5: "FTP Brute-Force", 6: "Ping of Death",
          7: "Phishing", 8: "Fraud VoIP", 9: "Open Proxy", 10: "Web Spam",
          11: "Email Spam", 12: "Blog Spam", 14: "Port Scan", 15: "Hacking",
          16: "SQL Injection", 17: "Spoofing", 18: "Brute-Force",
          19: "Bad Web Bot", 20: "Exploited Host", 21: "Web App Attack",
          22: "SSH", 23: "IoT Targeted",
        };

        const catSummary = Object.entries(categories)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 5)
          .map(([cat, count]) => `${catLabels[cat] || `Category ${cat}`}: ${count}`)
          .join(", ");

        findings.push({
          category: "infrastructure",
          severity: totalReports > 10 ? "high" : "medium",
          title: `AbuseIPDB: ${totalReports} abuse report(s) — ${catSummary}`,
          description: `Most recent report: ${data.lastReportedAt || "N/A"}\nDistinct reporters: ${data.numDistinctUsers || "N/A"}`,
          rawData: { categories, reportCount: totalReports, lastReported: data.lastReportedAt },
          remediation: "Review the types of abuse reported. If this is an owned IP, investigate for compromise or misconfiguration.",
        });
      }
    } catch (err) {
      findings.push({
        category: "infrastructure",
        severity: "info",
        title: `AbuseIPDB error: ${err.message}`,
        rawData: { error: err.message },
      });
    } finally {
      release();
    }

    return findings;
  },
};
