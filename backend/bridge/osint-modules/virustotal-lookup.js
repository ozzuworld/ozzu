// VirusTotal domain/IP reputation — 70+ AV engines, DNS, WHOIS
// Free tier: 4 req/min, 500 req/day
module.exports = {
  name: "virustotal-lookup",
  profileTypes: ["domain", "ip"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const apiKey = process.env.VIRUSTOTAL_API_KEY;

    if (!apiKey) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "VirusTotal skipped — no API key",
        description: "Set VIRUSTOTAL_API_KEY for domain/IP reputation scanning (free: 500 req/day).",
        rawData: { reason: "no_api_key" },
      });
      return findings;
    }

    const release = await rateLimiter.acquire();
    try {
      const endpoint = profile.profile_type === "ip"
        ? `https://www.virustotal.com/api/v3/ip_addresses/${profile.value}`
        : `https://www.virustotal.com/api/v3/domains/${profile.value}`;

      const res = await fetch(endpoint, {
        headers: { "x-apikey": apiKey },
        signal: AbortSignal.timeout(15000),
      });

      if (res.status === 429) {
        findings.push({
          category: "metadata",
          severity: "info",
          title: "VirusTotal rate limited",
          rawData: { reason: "rate_limited", source: "virustotal" },
        });
        return findings;
      }

      if (!res.ok) {
        findings.push({
          category: "metadata",
          severity: "info",
          title: `VirusTotal API error: HTTP ${res.status}`,
          rawData: { error: `HTTP ${res.status}`, source: "virustotal" },
        });
        return findings;
      }

      const data = await res.json();
      const attrs = data.data?.attributes || {};
      const stats = attrs.last_analysis_stats || {};
      const malicious = stats.malicious || 0;
      const suspicious = stats.suspicious || 0;
      const harmless = stats.harmless || 0;
      const undetected = stats.undetected || 0;

      // Detection results
      if (malicious > 0 || suspicious > 0) {
        findings.push({
          category: "exposure",
          severity: malicious > 5 ? "critical" : malicious > 0 ? "high" : "medium",
          title: `VirusTotal: ${malicious} malicious, ${suspicious} suspicious detection(s)`,
          description: `${malicious} engine(s) flag as malicious, ${suspicious} suspicious, ${harmless} clean, ${undetected} undetected`,
          rawData: {
            stats,
            reputation: attrs.reputation,
            source: "virustotal",
          },
          remediation: malicious > 0
            ? "This domain/IP is flagged as malicious by multiple security vendors. Investigate immediately."
            : "Some security vendors flag this as suspicious. Monitor for changes.",
        });
      } else {
        findings.push({
          category: "metadata",
          severity: "info",
          title: `VirusTotal: clean (${harmless} engines, 0 detections)`,
          rawData: { stats, reputation: attrs.reputation, source: "virustotal" },
        });
      }

      // WHOIS data (domains)
      if (attrs.whois) {
        findings.push({
          category: "metadata",
          severity: "low",
          title: "VirusTotal WHOIS data available",
          description: attrs.whois.slice(0, 500),
          rawData: { whois: attrs.whois.slice(0, 2000), source: "virustotal" },
        });
      }

      // Popularity ranks
      if (attrs.popularity_ranks && Object.keys(attrs.popularity_ranks).length > 0) {
        const ranks = Object.entries(attrs.popularity_ranks).map(([k, v]) => `${k}: #${v.rank}`).join(", ");
        findings.push({
          category: "metadata",
          severity: "info",
          title: `VirusTotal popularity: ${ranks}`,
          rawData: { popularityRanks: attrs.popularity_ranks, source: "virustotal" },
        });
      }

      // DNS records
      if (attrs.last_dns_records && attrs.last_dns_records.length > 0) {
        findings.push({
          category: "metadata",
          severity: "info",
          title: `VirusTotal: ${attrs.last_dns_records.length} DNS record(s)`,
          rawData: { dnsRecords: attrs.last_dns_records.slice(0, 20), source: "virustotal" },
        });
      }
    } catch (err) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "VirusTotal request failed",
        description: err.message,
        rawData: { error: err.message, source: "virustotal" },
      });
    } finally {
      release();
    }

    return findings;
  },
};
