// dnstwist module — brand protection via typosquatting/phishing domain detection
const cliRunner = require("../osint-cli-runner");

module.exports = {
  name: "dnstwist-scan",
  profileTypes: ["domain"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const domain = profile.value;

    const available = await cliRunner.isToolAvailable("dnstwist");
    if (!available) {
      findings.push({
        category: "infrastructure",
        severity: "info",
        title: "dnstwist scan skipped — tool not available",
        description: "dnstwist is not installed. Install with: pip install dnstwist[full]",
        rawData: { reason: "tool_unavailable", tool: "dnstwist" },
      });
      return findings;
    }

    const release = await rateLimiter.acquire();
    try {
      const result = await cliRunner.runTool("dnstwist", [
        "--format", "json",
        "--registered",
        "--whois",
        domain,
      ], { timeout: 120000, parseJson: true });

      const domains = result.parsed;
      if (!Array.isArray(domains) || domains.length === 0) {
        findings.push({
          category: "infrastructure",
          severity: "info",
          title: `dnstwist: No lookalike domains found for ${domain}`,
          description: "No registered typosquatting or homograph domains detected.",
          rawData: { domain, totalChecked: 0, tool: "dnstwist" },
        });
        return findings;
      }

      // Filter out the original domain
      const lookalikes = domains.filter((d) => d.domain && d.domain !== domain && d.fuzzer !== "*original");

      if (lookalikes.length === 0) {
        findings.push({
          category: "infrastructure",
          severity: "info",
          title: `dnstwist: No registered lookalike domains for ${domain}`,
          description: `Checked ${domains.length} permutations — none are registered.`,
          rawData: { domain, totalPermutations: domains.length, tool: "dnstwist" },
        });
        return findings;
      }

      const now = Date.now();
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
      const critical = [];
      const high = [];
      const medium = [];

      for (const d of lookalikes) {
        const hasContent = d.dns_a || d.dns_aaaa || d.dns_mx;
        const createdDate = d.whois_created ? new Date(d.whois_created).getTime() : null;
        const isRecent = createdDate && createdDate > thirtyDaysAgo;

        if (isRecent) critical.push(d);
        else if (hasContent) high.push(d);
        else medium.push(d);
      }

      if (critical.length > 0) {
        findings.push({
          category: "infrastructure",
          severity: "critical",
          title: `${critical.length} lookalike domain${critical.length > 1 ? "s" : ""} registered in last 30 days`,
          description: critical.slice(0, 10).map((d) =>
            `${d.domain} (${d.fuzzer || "unknown"}) — registered ${d.whois_created || "recently"}`
          ).join("\n"),
          rawData: { domains: critical.slice(0, 20), originalDomain: domain, tool: "dnstwist" },
          remediation: "Recently registered lookalike domains are high-risk for phishing. Report to the registrar via their abuse contact.",
        });
      }

      if (high.length > 0) {
        findings.push({
          category: "infrastructure",
          severity: "high",
          title: `${high.length} active lookalike domain${high.length > 1 ? "s" : ""} with DNS records`,
          description: high.slice(0, 10).map((d) =>
            `${d.domain} (${d.fuzzer || "unknown"})${d.dns_a ? ` → ${d.dns_a.join(", ")}` : ""}${d.dns_mx ? " [MX]" : ""}`
          ).join("\n"),
          rawData: { domains: high.slice(0, 30), originalDomain: domain, tool: "dnstwist" },
          remediation: "Active lookalike domains with web/mail content may be used for phishing. Report to registrar abuse contacts.",
        });
      }

      if (medium.length > 0) {
        findings.push({
          category: "infrastructure",
          severity: "medium",
          title: `${medium.length} registered lookalike domain${medium.length > 1 ? "s" : ""} (inactive)`,
          description: medium.slice(0, 10).map((d) =>
            `${d.domain} (${d.fuzzer || "unknown"})${d.whois_registrar ? ` — ${d.whois_registrar}` : ""}`
          ).join("\n"),
          rawData: { domains: medium.slice(0, 30), originalDomain: domain, tool: "dnstwist" },
        });
      }

      // Summary
      const fuzzerTypes = [...new Set(lookalikes.map((d) => d.fuzzer).filter(Boolean))];
      findings.push({
        category: "infrastructure",
        severity: "info",
        title: `dnstwist summary: ${lookalikes.length} lookalike domains for ${domain}`,
        description: `Permutation types: ${fuzzerTypes.join(", ")}. Critical: ${critical.length}, Active: ${high.length}, Inactive: ${medium.length}.`,
        rawData: { totalLookalikes: lookalikes.length, critical: critical.length, high: high.length, medium: medium.length, fuzzerTypes, originalDomain: domain, tool: "dnstwist" },
      });
    } catch (err) {
      findings.push({
        category: "infrastructure",
        severity: "info",
        title: `dnstwist scan error: ${err.message}`,
        description: `Failed to run dnstwist for "${domain}".`,
        rawData: { error: err.message, tool: "dnstwist" },
      });
    } finally {
      release();
    }

    return findings;
  },
};
