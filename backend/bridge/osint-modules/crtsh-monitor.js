// crt.sh Certificate Transparency monitor — detects new/unexpected certificates
const https = require("https");

module.exports = {
  name: "crtsh-monitor",
  profileTypes: ["domain"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const domain = profile.value;

    const release = await rateLimiter.acquire();
    try {
      const url = `https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`;
      const data = await fetchJson(url, 15000);

      if (!Array.isArray(data) || data.length === 0) {
        findings.push({
          category: "infrastructure",
          severity: "info",
          title: `crt.sh: No certificates found for ${domain}`,
          description: "No certificate transparency records found.",
          rawData: { domain, totalCerts: 0, tool: "crtsh" },
        });
        return findings;
      }

      // Deduplicate by common_name + issuer + not_before
      const seen = new Set();
      const unique = [];
      for (const cert of data) {
        const key = `${cert.common_name}|${cert.issuer_name}|${cert.not_before}`;
        if (!seen.has(key)) { seen.add(key); unique.push(cert); }
      }

      // Extract unique subdomains
      const subdomains = new Set();
      for (const cert of unique) {
        const name = cert.common_name || "";
        if (name.endsWith(`.${domain}`) || name === domain) subdomains.add(name);
        if (cert.name_value) {
          for (const san of cert.name_value.split("\n")) {
            const trimmed = san.trim();
            if (trimmed.endsWith(`.${domain}`) || trimmed === domain) subdomains.add(trimmed);
          }
        }
      }

      // Extract unique CAs
      const cas = {};
      for (const cert of unique) {
        const issuer = cert.issuer_name || "Unknown CA";
        const caMatch = issuer.match(/O=([^,]+)/);
        const caName = caMatch ? caMatch[1].trim() : issuer.slice(0, 50);
        cas[caName] = (cas[caName] || 0) + 1;
      }

      // Check for unknown subdomains
      const knownPrefixes = ["www", "mail", "smtp", "imap", "pop", "ftp", "ns1", "ns2", "autodiscover"];
      const unknownSubdomains = [...subdomains].filter((s) => {
        if (s === domain) return false;
        const prefix = s.replace(`.${domain}`, "");
        return !knownPrefixes.includes(prefix) && !prefix.startsWith("*");
      });

      if (unknownSubdomains.length > 0) {
        findings.push({
          category: "infrastructure",
          severity: "high",
          title: `${unknownSubdomains.length} unexpected subdomain${unknownSubdomains.length > 1 ? "s" : ""} in certificate logs`,
          description: unknownSubdomains.slice(0, 15).join("\n"),
          rawData: { subdomains: unknownSubdomains, domain, tool: "crtsh" },
          remediation: "Unknown subdomains in cert transparency logs may indicate shadow IT or subdomain takeover risk.",
        });
      }

      // Check for unexpected CAs
      const caEntries = Object.entries(cas).sort((a, b) => b[1] - a[1]);
      if (caEntries.length > 1) {
        const dominantCA = caEntries[0];
        const unusualCAs = caEntries.filter(([, count]) => count < dominantCA[1] * 0.1);
        if (unusualCAs.length > 0) {
          findings.push({
            category: "infrastructure",
            severity: "medium",
            title: `Certificates issued by ${unusualCAs.length} unusual CA${unusualCAs.length > 1 ? "s" : ""}`,
            description: `Primary CA: ${dominantCA[0]} (${dominantCA[1]} certs). Unusual: ${unusualCAs.map(([ca, n]) => `${ca} (${n})`).join(", ")}`,
            rawData: { cas: Object.fromEntries(caEntries), unusualCAs: unusualCAs.map(([ca]) => ca), domain, tool: "crtsh" },
            remediation: "Implement CAA DNS records to restrict allowed Certificate Authorities.",
          });
        }
      }

      // Recent certs (last 30 days)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const recentCerts = unique.filter((c) => c.not_before && new Date(c.not_before) > thirtyDaysAgo);
      if (recentCerts.length > 0) {
        findings.push({
          category: "infrastructure",
          severity: "info",
          title: `${recentCerts.length} certificate${recentCerts.length > 1 ? "s" : ""} issued in last 30 days`,
          description: recentCerts.slice(0, 10).map((c) =>
            `${c.common_name} — ${c.not_before} (${(c.issuer_name || "").match(/O=([^,]+)/)?.[1] || "Unknown CA"})`
          ).join("\n"),
          rawData: { recentCerts: recentCerts.slice(0, 20).map((c) => ({ commonName: c.common_name, issuer: c.issuer_name, notBefore: c.not_before, notAfter: c.not_after })), domain, tool: "crtsh" },
        });
      }

      // Summary
      const dateRange = unique.reduce((acc, c) => {
        if (c.not_before) {
          const d = new Date(c.not_before);
          if (!acc.earliest || d < acc.earliest) acc.earliest = d;
          if (!acc.latest || d > acc.latest) acc.latest = d;
        }
        return acc;
      }, { earliest: null, latest: null });

      findings.push({
        category: "infrastructure",
        severity: "info",
        title: `crt.sh: ${unique.length} certificates, ${subdomains.size} subdomains for ${domain}`,
        description: `CAs: ${caEntries.map(([ca, n]) => `${ca} (${n})`).join(", ")}`,
        rawData: { totalCerts: unique.length, subdomains: [...subdomains], cas: Object.fromEntries(caEntries), dateRange: { earliest: dateRange.earliest?.toISOString(), latest: dateRange.latest?.toISOString() }, domain, tool: "crtsh" },
      });
    } catch (err) {
      findings.push({
        category: "infrastructure",
        severity: "info",
        title: `crt.sh scan error: ${err.message}`,
        description: `Failed to query certificate transparency for "${domain}".`,
        rawData: { error: err.message, domain, tool: "crtsh" },
      });
    } finally {
      release();
    }

    return findings;
  },
};

function fetchJson(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid JSON from crt.sh")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("crt.sh request timed out")); });
  });
}
