// URLhaus malicious URL database — malware downloads, phishing
// Free, no auth required for basic queries
module.exports = {
  name: "urlhaus-check",
  profileTypes: ["domain"],

  async scan(profile, rateLimiter) {
    const findings = [];

    const release = await rateLimiter.acquire();
    try {
      const res = await fetch("https://urlhaus-api.abuse.ch/v1/host/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `host=${encodeURIComponent(profile.value)}`,
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        findings.push({
          category: "metadata",
          severity: "info",
          title: `URLhaus error: HTTP ${res.status}`,
          rawData: { error: `HTTP ${res.status}`, source: "urlhaus" },
        });
        return findings;
      }

      const data = await res.json();

      if (data.query_status === "no_results" || !data.urls || data.urls.length === 0) {
        findings.push({
          category: "metadata",
          severity: "info",
          title: "URLhaus: no malicious URLs found for this domain",
          rawData: { source: "urlhaus", queryStatus: data.query_status },
        });
        return findings;
      }

      const urlsOnline = data.urls_online || 0;
      const totalUrls = data.urls?.length || 0;

      // Active malicious URLs
      if (urlsOnline > 0) {
        const activeUrls = data.urls.filter((u) => u.url_status === "online").slice(0, 10);
        findings.push({
          category: "exposure",
          severity: "critical",
          title: `URLhaus: ${urlsOnline} ACTIVE malicious URL(s) on this domain`,
          description: activeUrls.map((u) => `  ${u.url} — ${u.threat || "unknown"} (${u.tags?.join(", ") || "no tags"})`).join("\n"),
          rawData: {
            urlsOnline,
            activeUrls: activeUrls.map((u) => ({ url: u.url, threat: u.threat, tags: u.tags, dateAdded: u.date_added })),
            source: "urlhaus",
          },
          remediation: "Active malicious URLs detected on this domain. This domain may be compromised or used for malware distribution.",
        });
      }

      // Historical malicious URLs
      if (totalUrls > urlsOnline) {
        const offlineCount = totalUrls - urlsOnline;
        findings.push({
          category: "exposure",
          severity: "medium",
          title: `URLhaus: ${offlineCount} historical malicious URL(s) (now offline)`,
          description: `${totalUrls} total URLs tracked, ${urlsOnline} currently online`,
          rawData: {
            totalUrls,
            urlsOnline,
            urlsOffline: offlineCount,
            source: "urlhaus",
          },
        });
      }

      // Threat types
      const threats = new Set(data.urls.map((u) => u.threat).filter(Boolean));
      if (threats.size > 0) {
        findings.push({
          category: "metadata",
          severity: "low",
          title: `URLhaus threat types: ${[...threats].join(", ")}`,
          rawData: { threats: [...threats], source: "urlhaus" },
        });
      }
    } catch (err) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "URLhaus request failed",
        description: err.message,
        rawData: { error: err.message, source: "urlhaus" },
      });
    } finally {
      release();
    }

    return findings;
  },
};
