// AlienVault OTX lookup module — threat intelligence indicators, pulses, IOCs
// Free tier: unlimited with API key (10K req/hour)
// API docs: https://otx.alienvault.com/api

const OTX_API = "https://otx.alienvault.com/api/v1";

module.exports = {
  name: "otx-lookup",
  profileTypes: ["domain", "ip", "email"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const apiKey = process.env.OTX_API_KEY;

    if (!apiKey) {
      findings.push({
        category: "infrastructure",
        severity: "info",
        title: "OTX scan skipped — no API key",
        description: "Set OTX_API_KEY for AlienVault threat intelligence. Free and unlimited at otx.alienvault.com.",
        rawData: { reason: "no_otx_api_key" },
      });
      return findings;
    }

    const target = profile.value;

    // Determine indicator type and sections
    let indicatorType, indicatorValue;
    if (profile.profile_type === "domain") {
      indicatorType = "domain";
      indicatorValue = target;
    } else if (profile.profile_type === "ip") {
      indicatorType = "IPv4";
      indicatorValue = target;
    } else if (profile.profile_type === "email") {
      indicatorType = "email";
      indicatorValue = target;
    }

    const release = await rateLimiter.acquire();
    try {
      // General indicator info
      const url = `${OTX_API}/indicators/${indicatorType}/${indicatorValue}/general`;
      const res = await fetch(url, {
        headers: {
          "X-OTX-API-KEY": apiKey,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        if (res.status === 401) throw new Error("Invalid OTX API key");
        if (res.status === 404) {
          findings.push({
            category: "infrastructure",
            severity: "info",
            title: `OTX: No threat data for ${target}`,
            description: "Not found in AlienVault OTX threat intelligence database.",
            rawData: { target, indicatorType },
          });
          return findings;
        }
        throw new Error(`OTX API error: ${res.status}`);
      }

      const data = await res.json();

      // Pulse count (threat reports)
      const pulseCount = data.pulse_info && data.pulse_info.count || 0;
      const pulses = data.pulse_info && data.pulse_info.pulses || [];

      if (pulseCount > 0) {
        findings.push({
          category: "infrastructure",
          severity: pulseCount > 5 ? "high" : "medium",
          title: `OTX: ${pulseCount} threat pulse(s) reference ${target}`,
          description: pulses.slice(0, 5).map((p) =>
            `${p.name} (${p.created || "unknown date"}) — ${p.tags ? p.tags.slice(0, 5).join(", ") : "no tags"}`
          ).join("\n"),
          sourceUrl: `https://otx.alienvault.com/indicator/${indicatorType}/${indicatorValue}`,
          rawData: {
            target,
            pulseCount,
            pulses: pulses.slice(0, 20).map((p) => ({
              name: p.name,
              created: p.created,
              tags: p.tags,
              references: p.references,
              adversary: p.adversary,
            })),
          },
          remediation: "This indicator appears in threat intelligence feeds. Investigate if this is an owned asset — it may be compromised or associated with malicious activity.",
        });

        // Check for known adversaries
        const adversaries = pulses.filter((p) => p.adversary).map((p) => p.adversary);
        if (adversaries.length > 0) {
          const uniqueAdversaries = [...new Set(adversaries)];
          findings.push({
            category: "infrastructure",
            severity: "critical",
            title: `OTX: Linked to ${uniqueAdversaries.length} known threat actor(s)`,
            description: uniqueAdversaries.join(", "),
            rawData: { adversaries: uniqueAdversaries },
            remediation: "URGENT: This indicator is associated with known threat actors. Immediate investigation required.",
          });
        }
      } else {
        findings.push({
          category: "infrastructure",
          severity: "info",
          title: `OTX: No threat pulses for ${target}`,
          description: "Not referenced in any AlienVault OTX threat intelligence reports.",
          sourceUrl: `https://otx.alienvault.com/indicator/${indicatorType}/${indicatorValue}`,
          rawData: { target, pulseCount: 0 },
        });
      }

      // Reputation
      if (data.reputation !== undefined && data.reputation !== null) {
        findings.push({
          category: "infrastructure",
          severity: data.reputation < -2 ? "high" : data.reputation < 0 ? "medium" : "info",
          title: `OTX reputation score: ${data.reputation}`,
          description: `Reputation: ${data.reputation} (negative = suspicious, positive = benign)`,
          rawData: { reputation: data.reputation },
        });
      }

      // Geo info for IPs
      if (profile.profile_type === "ip" && (data.country_name || data.city)) {
        findings.push({
          category: "infrastructure",
          severity: "info",
          title: `OTX Geo: ${[data.city, data.country_name].filter(Boolean).join(", ")}`,
          description: `Country: ${data.country_name || "N/A"}\nCity: ${data.city || "N/A"}\nASN: ${data.asn || "N/A"}`,
          rawData: { country: data.country_name, city: data.city, asn: data.asn, latitude: data.latitude, longitude: data.longitude },
        });
      }
    } catch (err) {
      findings.push({
        category: "infrastructure",
        severity: "info",
        title: `OTX error: ${err.message}`,
        rawData: { error: err.message },
      });
    } finally {
      release();
    }

    // Fetch passive DNS for domains/IPs (separate API call)
    if (profile.profile_type === "domain" || profile.profile_type === "ip") {
      const release2 = await rateLimiter.acquire();
      try {
        const pdnsUrl = `${OTX_API}/indicators/${indicatorType}/${indicatorValue}/passive_dns`;
        const pdnsRes = await fetch(pdnsUrl, {
          headers: { "X-OTX-API-KEY": apiKey, "Accept": "application/json" },
          signal: AbortSignal.timeout(15000),
        });

        if (pdnsRes.ok) {
          const pdnsData = await pdnsRes.json();
          const records = pdnsData.passive_dns || [];

          if (records.length > 0) {
            findings.push({
              category: "infrastructure",
              severity: records.length > 20 ? "medium" : "low",
              title: `OTX Passive DNS: ${records.length} historical record(s)`,
              description: records.slice(0, 10).map((r) =>
                `${r.hostname || r.address} → ${r.address || r.hostname} (${r.record_type}, ${r.first || "?"} - ${r.last || "?"})`
              ).join("\n"),
              rawData: { passiveDnsCount: records.length, records: records.slice(0, 50) },
            });
          }
        }
      } catch { /* skip passive DNS errors */ }
      finally { release2(); }
    }

    return findings;
  },
};
