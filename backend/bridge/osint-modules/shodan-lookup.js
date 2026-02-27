// Shodan integration module — exposed servers, open ports, CVEs, SSL certs
// Requires SHODAN_API_KEY env var (free tier: 1 query/second)
// API docs: https://developer.shodan.io/api

const dns = require("dns").promises;

const SHODAN_API = "https://api.shodan.io";

// Ports that indicate elevated risk when publicly exposed
const HIGH_RISK_PORTS = new Set([
  22, 23, 25, 135, 137, 139, 445, 1433, 1521, 2049, 3306, 3389, 5432, 5900,
  5901, 6379, 8080, 8443, 9200, 9300, 11211, 27017, 50070,
]);

const PORT_SERVICES = {
  21: "FTP", 22: "SSH", 23: "Telnet", 25: "SMTP", 53: "DNS", 80: "HTTP",
  110: "POP3", 135: "RPC", 139: "NetBIOS", 143: "IMAP", 443: "HTTPS",
  445: "SMB", 993: "IMAPS", 995: "POP3S", 1433: "MSSQL", 1521: "Oracle",
  2049: "NFS", 3306: "MySQL", 3389: "RDP", 5432: "PostgreSQL", 5900: "VNC",
  6379: "Redis", 8080: "HTTP-Alt", 8443: "HTTPS-Alt", 9200: "Elasticsearch",
  11211: "Memcached", 27017: "MongoDB", 50070: "Hadoop",
};

async function shodanFetch(path, apiKey, rateLimiter) {
  const release = await rateLimiter.acquire();
  try {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${SHODAN_API}${path}${sep}key=${apiKey}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "OSINT-Scanner/1.0" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      if (res.status === 401) throw new Error("Invalid Shodan API key");
      if (res.status === 429) throw new Error("Shodan rate limit exceeded");
      return null;
    }
    return await res.json();
  } finally {
    release();
  }
}

module.exports = {
  name: "shodan-lookup",
  profileTypes: ["domain"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const apiKey = process.env.SHODAN_API_KEY;

    if (!apiKey) {
      findings.push({
        category: "infrastructure",
        severity: "info",
        title: "Shodan scan skipped — no API key",
        description: "Set SHODAN_API_KEY for exposed server/port/vulnerability scanning. Free tier available at shodan.io.",
        rawData: { reason: "no_shodan_api_key" },
      });
      return findings;
    }

    const domain = profile.value;

    // Step 1: Resolve domain to IPs
    let ips = [];
    try {
      const data = await shodanFetch(`/dns/resolve?hostnames=${domain}`, apiKey, rateLimiter);
      if (data && data[domain]) {
        ips.push(data[domain]);
      }
    } catch {
      // Fallback to Node DNS
      try {
        const addresses = await dns.resolve4(domain);
        ips = addresses;
      } catch { /* no resolution */ }
    }

    if (ips.length === 0) {
      findings.push({
        category: "infrastructure",
        severity: "info",
        title: `No IP addresses resolved for ${domain}`,
        description: "Could not resolve domain to an IP address for Shodan lookup.",
        rawData: { domain },
      });
      return findings;
    }

    // Step 2: Query each IP for host details
    for (const ip of ips.slice(0, 3)) {
      let hostData;
      try {
        hostData = await shodanFetch(`/shodan/host/${ip}`, apiKey, rateLimiter);
      } catch (err) {
        findings.push({
          category: "infrastructure",
          severity: "info",
          title: `Shodan lookup failed for ${ip}`,
          description: err.message,
          rawData: { ip, error: err.message },
        });
        continue;
      }

      if (!hostData || !hostData.ports) continue;

      const openPorts = hostData.ports || [];
      const org = hostData.org || "Unknown";
      const os = hostData.os || "Unknown";
      const lastUpdate = hostData.last_update || "Unknown";

      // Finding: Host overview
      findings.push({
        category: "infrastructure",
        severity: openPorts.length > 10 ? "high" : "medium",
        title: `${openPorts.length} open port(s) on ${ip} (${domain})`,
        description: `Organization: ${org}\nOS: ${os}\nLast scanned: ${lastUpdate}\nOpen ports: ${openPorts.join(", ")}`,
        rawData: {
          ip, domain, org, os, lastUpdate,
          ports: openPorts,
          hostnames: hostData.hostnames || [],
        },
        remediation: "Review all open ports. Close any that are not needed for public services. Use firewalls to restrict access.",
      });

      // Finding: High-risk ports
      const riskyPorts = openPorts.filter((p) => HIGH_RISK_PORTS.has(p));
      if (riskyPorts.length > 0) {
        findings.push({
          category: "infrastructure",
          severity: "high",
          title: `${riskyPorts.length} high-risk port(s) exposed on ${ip}`,
          description: riskyPorts.map((p) => `  Port ${p} (${PORT_SERVICES[p] || "unknown"}) — should not be publicly accessible`).join("\n"),
          rawData: { ip, riskyPorts: riskyPorts.map((p) => ({ port: p, service: PORT_SERVICES[p] || "unknown" })) },
          remediation: "These ports expose administrative or database services. Restrict them with firewall rules or VPN access.",
        });
      }

      // Finding: Vulnerabilities (CVEs)
      if (hostData.vulns && hostData.vulns.length > 0) {
        findings.push({
          category: "infrastructure",
          severity: "critical",
          title: `${hostData.vulns.length} known vulnerability(ies) on ${ip}`,
          description: hostData.vulns.slice(0, 20).map((v) => `  ${v}`).join("\n"),
          rawData: { ip, vulns: hostData.vulns },
          remediation: "Patch or update affected services immediately. Check each CVE for severity and available fixes.",
        });
      }

      // Finding: SSL certificate info from services
      for (const service of (hostData.data || []).slice(0, 10)) {
        if (service.ssl && service.ssl.cert) {
          const cert = service.ssl.cert;
          const subject = cert.subject && cert.subject.CN ? cert.subject.CN : "Unknown";
          const issuer = cert.issuer && cert.issuer.O ? cert.issuer.O : "Unknown";
          const expires = cert.expires || "Unknown";

          // Check if cert is expired
          const isExpired = new Date(expires) < new Date();

          findings.push({
            category: "infrastructure",
            severity: isExpired ? "high" : "info",
            title: `SSL certificate on port ${service.port}: ${subject}`,
            description: `Issuer: ${issuer}\nExpires: ${expires}${isExpired ? " (EXPIRED)" : ""}\nSANs: ${(cert.extensions && cert.extensions.subjectAltName ? cert.extensions.subjectAltName : "N/A")}`,
            rawData: { ip, port: service.port, subject, issuer, expires, isExpired, sans: cert.extensions?.subjectAltName },
            remediation: isExpired ? "SSL certificate has expired. Renew immediately to avoid security warnings and MITM attacks." : null,
          });
          break; // Only report first SSL cert per host
        }
      }

      // Finding: Technology stack
      const technologies = new Set();
      for (const service of (hostData.data || [])) {
        if (service.product) technologies.add(service.product);
        if (service.http && service.http.server) technologies.add(service.http.server);
      }
      if (technologies.size > 0) {
        findings.push({
          category: "infrastructure",
          severity: "low",
          title: `Technology stack detected on ${ip}`,
          description: [...technologies].join(", "),
          rawData: { ip, technologies: [...technologies] },
          remediation: "Remove server version headers to reduce information disclosure. Use generic server names.",
        });
      }
    }

    // Step 3: Search for domain across all Shodan
    try {
      const searchData = await shodanFetch(`/shodan/host/search?query=hostname:${domain}`, apiKey, rateLimiter);
      if (searchData && searchData.total > ips.length) {
        findings.push({
          category: "infrastructure",
          severity: "medium",
          title: `${searchData.total} total host(s) found for ${domain} on Shodan`,
          description: `Shodan indexes ${searchData.total} hosts associated with this domain. ${searchData.total - ips.length} additional hosts beyond the primary IP(s).`,
          rawData: { domain, totalHosts: searchData.total, primaryIps: ips },
        });
      }
    } catch {
      // Search may not be available on free tier
    }

    return findings;
  },
};
