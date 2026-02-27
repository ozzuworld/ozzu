// AlienVault OTX threat intelligence — pulse reports, reputation, passive DNS
// Free tier: 10K req/hour (most generous free threat intel API)
module.exports = {
  name: "otx-intel",
  profileTypes: ["ip", "domain", "email"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const apiKey = process.env.OTX_API_KEY;

    // OTX works without a key but with lower rate limits
    const headers = { Accept: "application/json" };
    if (apiKey) headers["X-OTX-API-KEY"] = apiKey;

    // Map profile type to OTX indicator type
    const typeMap = { ip: "IPv4", domain: "domain", email: "email" };
    const otxType = typeMap[profile.profile_type];
    if (!otxType) return findings;

    const release = await rateLimiter.acquire();
    try {
      const baseUrl = `https://otx.alienvault.com/api/v1/indicators/${otxType}/${encodeURIComponent(profile.value)}`;

      // General info
      const genRes = await fetch(`${baseUrl}/general`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });

      if (!genRes.ok) {
        findings.push({
          category: "metadata",
          severity: "info",
          title: `OTX API error: HTTP ${genRes.status}`,
          rawData: { error: `HTTP ${genRes.status}`, source: "otx" },
        });
        return findings;
      }

      const gen = await genRes.json();
      const pulseCount = gen.pulse_info?.count || 0;
      const reputation = gen.reputation || 0;

      if (pulseCount > 0) {
        const pulses = (gen.pulse_info?.pulses || []).slice(0, 5);
        findings.push({
          category: "exposure",
          severity: pulseCount > 10 ? "high" : pulseCount > 3 ? "medium" : "low",
          title: `OTX: ${pulseCount} threat pulse(s) reference this indicator`,
          description: pulses.map((p) => `  ${p.name} (${p.created || "unknown date"})`).join("\n"),
          rawData: {
            pulseCount,
            pulses: pulses.map((p) => ({ name: p.name, created: p.created, tags: p.tags, adversary: p.adversary })),
            source: "otx",
          },
          remediation: "This indicator appears in threat intelligence reports. Investigate the associated threat pulses.",
        });
      } else {
        findings.push({
          category: "metadata",
          severity: "info",
          title: "OTX: no threat pulses found",
          rawData: { pulseCount: 0, reputation, source: "otx" },
        });
      }

      // Geo data (IP only)
      if (profile.profile_type === "ip" && (gen.country_name || gen.city)) {
        findings.push({
          category: "metadata",
          severity: "info",
          title: `OTX geo: ${[gen.city, gen.region, gen.country_name].filter(Boolean).join(", ")}`,
          rawData: {
            country: gen.country_name,
            city: gen.city,
            region: gen.region,
            latitude: gen.latitude,
            longitude: gen.longitude,
            asn: gen.asn,
            source: "otx",
          },
        });
      }

      // Passive DNS (domain/IP)
      if (profile.profile_type !== "email") {
        try {
          const dnsRes = await fetch(`${baseUrl}/passive_dns`, {
            headers,
            signal: AbortSignal.timeout(10000),
          });
          if (dnsRes.ok) {
            const dns = await dnsRes.json();
            const records = dns.passive_dns || [];
            if (records.length > 0) {
              findings.push({
                category: "metadata",
                severity: "low",
                title: `OTX: ${records.length} passive DNS record(s)`,
                description: records.slice(0, 10).map((r) => `  ${r.hostname || r.address} (${r.record_type || "A"}) — ${r.first || "?"} to ${r.last || "?"}`).join("\n"),
                rawData: {
                  passiveDnsCount: records.length,
                  records: records.slice(0, 20).map((r) => ({ hostname: r.hostname, address: r.address, type: r.record_type, first: r.first, last: r.last })),
                  source: "otx",
                },
              });
            }
          }
        } catch {}
      }

      // Malware samples (IP/domain)
      if (profile.profile_type !== "email") {
        try {
          const malRes = await fetch(`${baseUrl}/malware`, {
            headers,
            signal: AbortSignal.timeout(10000),
          });
          if (malRes.ok) {
            const mal = await malRes.json();
            const samples = mal.data || [];
            if (samples.length > 0) {
              findings.push({
                category: "exposure",
                severity: "high",
                title: `OTX: ${samples.length} malware sample(s) associated`,
                description: samples.slice(0, 5).map((s) => `  ${s.hash || "unknown"} — ${s.datetime_int || "?"}`).join("\n"),
                rawData: {
                  malwareSamples: samples.length,
                  samples: samples.slice(0, 10).map((s) => ({ hash: s.hash, date: s.datetime_int })),
                  source: "otx",
                },
                remediation: "Malware samples associated with this indicator. Scan for infections.",
              });
            }
          }
        } catch {}
      }
    } catch (err) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "OTX request failed",
        description: err.message,
        rawData: { error: err.message, source: "otx" },
      });
    } finally {
      release();
    }

    return findings;
  },
};
