// Domain/IP reconnaissance module — DNS enum, WHOIS/RDAP, cert transparency, subdomain discovery, IP geolocation
// Uses Node.js built-in dns module + free APIs (rdap.org, crt.sh, ipinfo.io)
const dns = require("dns").promises;

// Common subdomains to brute-force
const COMMON_SUBDOMAINS = [
  "www", "mail", "ftp", "admin", "api", "dev", "staging", "test",
  "blog", "shop", "store", "app", "portal", "vpn", "remote", "webmail",
  "cdn", "media", "static", "img", "images", "assets", "docs",
  "git", "gitlab", "jenkins", "ci", "jira", "confluence", "wiki",
  "monitor", "grafana", "prometheus", "kibana", "elastic",
  "db", "database", "mysql", "postgres", "redis", "mongo",
  "mx", "ns1", "ns2", "dns", "ns",
  "backup", "old", "new", "beta", "alpha", "demo", "sandbox",
  "intranet", "internal", "corp", "office",
];

module.exports = {
  name: "domain-recon",
  profileTypes: ["domain"],

  async scan(profile, rateLimiter) {
    const domain = profile.value.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const findings = [];

    // 1. DNS enumeration — A, AAAA, MX, NS, TXT, SOA, CNAME
    const recordTypes = ["A", "AAAA", "MX", "NS", "TXT", "SOA", "CNAME"];
    for (const type of recordTypes) {
      try {
        let records;
        switch (type) {
          case "A": records = await dns.resolve4(domain); break;
          case "AAAA": records = await dns.resolve6(domain).catch(() => []); break;
          case "MX": records = (await dns.resolveMx(domain)).map((r) => `${r.priority} ${r.exchange}`); break;
          case "NS": records = await dns.resolveNs(domain); break;
          case "TXT": records = (await dns.resolveTxt(domain)).map((r) => r.join("")); break;
          case "SOA": {
            const soa = await dns.resolveSoa(domain);
            records = [`${soa.nsname} ${soa.hostmaster} serial:${soa.serial}`];
            break;
          }
          case "CNAME": records = await dns.resolveCname(domain).catch(() => []); break;
        }

        if (records && records.length > 0) {
          // Check TXT records for sensitive info
          let severity = "info";
          if (type === "TXT") {
            const sensitive = records.some((r) =>
              r.includes("v=spf1") || r.includes("v=DMARC") || r.includes("google-site-verification")
            );
            if (!records.some((r) => r.includes("v=spf1"))) {
              findings.push({
                category: "exposure",
                severity: "medium",
                title: `Missing SPF record for ${domain}`,
                description: "No SPF (Sender Policy Framework) TXT record found. This allows email spoofing from this domain.",
                rawData: { recordType: type, records, missingSpf: true },
                remediation: "Add a TXT record with SPF policy (e.g., 'v=spf1 include:_spf.google.com ~all') to prevent email spoofing.",
              });
            }
            if (!records.some((r) => r.includes("v=DMARC"))) {
              findings.push({
                category: "exposure",
                severity: "medium",
                title: `Missing DMARC record for ${domain}`,
                description: "No DMARC policy found. Email authentication is incomplete without DMARC.",
                rawData: { recordType: type, records, missingDmarc: true },
                remediation: "Add a TXT record at _dmarc.{domain} with DMARC policy (e.g., 'v=DMARC1; p=quarantine').",
              });
            }
          }

          findings.push({
            category: "exposure",
            severity,
            title: `DNS ${type} records for ${domain} (${records.length})`,
            description: `${type} records:\n${records.slice(0, 10).map((r) => `  ${r}`).join("\n")}${records.length > 10 ? `\n  ... and ${records.length - 10} more` : ""}`,
            rawData: { recordType: type, records, domain },
          });
        }
      } catch (_) {
        // No records for this type — skip
      }
    }

    // 2. WHOIS via RDAP — free JSON API
    const release1 = await rateLimiter.acquire();
    try {
      const rdapUrl = `https://rdap.org/domain/${domain}`;
      const res = await fetch(rdapUrl, {
        signal: AbortSignal.timeout(15000),
        headers: { "Accept": "application/rdap+json" },
      });

      if (res.ok) {
        const data = await res.json();
        const registrant = {};
        const events = {};

        // Extract key RDAP fields
        if (data.entities) {
          for (const entity of data.entities) {
            if (entity.roles?.includes("registrant") && entity.vcardArray) {
              const vcard = entity.vcardArray[1] || [];
              for (const field of vcard) {
                if (field[0] === "fn") registrant.name = field[3];
                if (field[0] === "org") registrant.organization = field[3];
                if (field[0] === "email") registrant.email = field[3];
              }
            }
          }
        }

        if (data.events) {
          for (const event of data.events) {
            events[event.eventAction] = event.eventDate;
          }
        }

        const nameservers = (data.nameservers || []).map((ns) => ns.ldhName || ns.objectClassName).filter(Boolean);

        const hasPersonalInfo = registrant.name || registrant.email;
        findings.push({
          category: "exposure",
          severity: hasPersonalInfo ? "high" : "info",
          title: hasPersonalInfo ? `WHOIS exposes personal info for ${domain}` : `WHOIS data for ${domain}`,
          description: [
            registrant.name && `Registrant: ${registrant.name}`,
            registrant.organization && `Organization: ${registrant.organization}`,
            registrant.email && `Email: ${registrant.email}`,
            events.registration && `Registered: ${events.registration}`,
            events.expiration && `Expires: ${events.expiration}`,
            nameservers.length && `Nameservers: ${nameservers.join(", ")}`,
          ].filter(Boolean).join("\n") || "WHOIS data retrieved but no registrant information exposed (privacy protection active).",
          rawData: { whois: { registrant, events, nameservers, status: data.status }, domain },
          remediation: hasPersonalInfo ? "Enable WHOIS privacy protection through your domain registrar to hide personal information." : null,
        });
      }
    } catch (_) {
      // RDAP failed — non-critical
    } finally {
      release1();
    }

    // 3. Certificate Transparency — crt.sh
    const release2 = await rateLimiter.acquire();
    try {
      const crtUrl = `https://crt.sh/?q=%.${domain}&output=json`;
      const res = await fetch(crtUrl, { signal: AbortSignal.timeout(20000) });

      if (res.ok) {
        const certs = await res.json();
        // Deduplicate by common_name
        const uniqueNames = [...new Set(certs.map((c) => c.common_name || c.name_value).filter(Boolean))];
        const subdomains = uniqueNames.filter((name) => name.endsWith(`.${domain}`) && name !== `*.${domain}`);

        if (subdomains.length > 0) {
          // Check for sensitive subdomains
          const sensitiveKeywords = ["admin", "internal", "dev", "staging", "test", "vpn", "intranet", "jenkins", "gitlab", "jira"];
          const sensitiveHits = subdomains.filter((s) => sensitiveKeywords.some((kw) => s.includes(kw)));

          if (sensitiveHits.length > 0) {
            findings.push({
              category: "exposure",
              severity: "high",
              title: `${sensitiveHits.length} sensitive subdomains found via cert transparency`,
              description: `Internal/admin subdomains discovered:\n${sensitiveHits.slice(0, 10).map((s) => `  ${s}`).join("\n")}`,
              rawData: { subdomains: sensitiveHits, source: "crt.sh", sensitive: true },
              remediation: "Use wildcard certificates or internal CAs for non-public services. Sensitive subdomains in CT logs expose your infrastructure.",
            });
          }

          findings.push({
            category: "exposure",
            severity: "medium",
            title: `${subdomains.length} subdomains found via certificate transparency`,
            description: `crt.sh reveals ${subdomains.length} subdomains:\n${subdomains.slice(0, 15).map((s) => `  ${s}`).join("\n")}${subdomains.length > 15 ? `\n  ... and ${subdomains.length - 15} more` : ""}`,
            rawData: { subdomains: subdomains.slice(0, 100), source: "crt.sh", totalCerts: certs.length },
            remediation: "Review exposed subdomains. Decommission unused services and restrict access to internal resources.",
          });
        }
      }
    } catch (_) {
      // crt.sh timeout — common
    } finally {
      release2();
    }

    // 4. Subdomain brute-force via DNS resolution
    const discoveredSubs = [];
    const subChecks = COMMON_SUBDOMAINS.map(async (sub) => {
      try {
        const fqdn = `${sub}.${domain}`;
        const ips = await dns.resolve4(fqdn);
        if (ips && ips.length > 0) {
          discoveredSubs.push({ subdomain: fqdn, ips });
        }
      } catch (_) {
        // NXDOMAIN or timeout — expected for most
      }
    });
    await Promise.all(subChecks);

    if (discoveredSubs.length > 0) {
      const sensitiveKeywords = ["admin", "internal", "dev", "staging", "test", "vpn", "intranet"];
      const sensitiveSubs = discoveredSubs.filter((s) => sensitiveKeywords.some((kw) => s.subdomain.includes(kw)));

      if (sensitiveSubs.length > 0) {
        findings.push({
          category: "exposure",
          severity: "high",
          title: `${sensitiveSubs.length} sensitive subdomains resolve via DNS`,
          description: sensitiveSubs.map((s) => `${s.subdomain} → ${s.ips.join(", ")}`).join("\n"),
          rawData: { subdomains: sensitiveSubs, source: "dns_bruteforce", sensitive: true },
          remediation: "Admin/dev/staging subdomains should not be publicly resolvable. Use split-horizon DNS or VPN-only access.",
        });
      }

      findings.push({
        category: "exposure",
        severity: "info",
        title: `${discoveredSubs.length} active subdomains found via DNS`,
        description: discoveredSubs.slice(0, 20).map((s) => `${s.subdomain} → ${s.ips.join(", ")}`).join("\n"),
        rawData: { subdomains: discoveredSubs, source: "dns_bruteforce" },
      });
    }

    // 5. IP Geolocation — ipinfo.io (50k free/mo, no key needed)
    // Resolve main domain A records first
    try {
      const ips = await dns.resolve4(domain);
      for (const ip of ips.slice(0, 3)) {
        const release = await rateLimiter.acquire();
        try {
          const res = await fetch(`https://ipinfo.io/${ip}/json`, {
            signal: AbortSignal.timeout(10000),
          });
          if (res.ok) {
            const geo = await res.json();
            findings.push({
              category: "exposure",
              severity: "info",
              title: `IP geolocation: ${ip} (${geo.org || "Unknown"})`,
              description: [
                `IP: ${ip}`,
                geo.city && `City: ${geo.city}`,
                geo.region && `Region: ${geo.region}`,
                geo.country && `Country: ${geo.country}`,
                geo.org && `ISP/Org: ${geo.org}`,
                geo.loc && `Coordinates: ${geo.loc}`,
              ].filter(Boolean).join("\n"),
              rawData: { ip, geolocation: geo, recordType: "A", records: [ip] },
            });
          }
        } catch (_) {
          // Skip
        } finally {
          release();
        }
      }
    } catch (_) {
      // No A records
    }

    // 6. SecurityTrails (optional) — historical DNS + subdomains
    const securityTrailsKey = process.env.SECURITYTRAILS_API_KEY;
    if (securityTrailsKey) {
      const release = await rateLimiter.acquire();
      try {
        const res = await fetch(`https://api.securitytrails.com/v1/domain/${domain}/subdomains`, {
          headers: { "APIKEY": securityTrailsKey },
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const data = await res.json();
          const subdomains = (data.subdomains || []).map((s) => `${s}.${domain}`);
          if (subdomains.length > 0) {
            findings.push({
              category: "exposure",
              severity: "medium",
              title: `${subdomains.length} subdomains from SecurityTrails`,
              description: `Historical + active subdomains:\n${subdomains.slice(0, 20).map((s) => `  ${s}`).join("\n")}`,
              rawData: { subdomains: subdomains.slice(0, 200), source: "securitytrails" },
              remediation: "Review all discovered subdomains. Decommission unused services.",
            });
          }
        }
      } catch (_) {
        // Skip
      } finally {
        release();
      }
    } else {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "SecurityTrails lookup skipped — no API key",
        description: "Set SECURITYTRAILS_API_KEY for historical DNS data and comprehensive subdomain enumeration (50 free queries/month).",
        rawData: { reason: "no_securitytrails_api_key" },
      });
    }

    if (findings.length === 0) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "No domain reconnaissance data found",
        description: `Domain ${domain} could not be resolved or has no public DNS records.`,
        rawData: { domain, found: false },
      });
    }

    return findings;
  },
};
