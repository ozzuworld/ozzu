// Amass CLI module — passive subdomain enumeration (DNS, cert transparency, web archives)
// Uses amass binary via docker exec osint-tools
const cliRunner = require("../osint-cli-runner");
const crypto = require("crypto");

module.exports = {
  name: "amass-cli",
  profileTypes: ["domain"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const domain = profile.value;

    const available = await cliRunner.isToolAvailable("amass");
    if (!available) {
      findings.push({
        category: "infrastructure",
        severity: "info",
        title: "Amass scan skipped — tool not available",
        description: "Amass binary is not installed in the osint-tools container.",
        rawData: { reason: "tool_unavailable", tool: "amass" },
      });
      return findings;
    }

    const outputId = crypto.randomBytes(4).toString("hex");
    const outputFile = `/tmp/osint-data/amass-${outputId}.json`;

    try {
      const result = await cliRunner.runTool("amass", [
        "enum",
        "-passive",
        "-d", domain,
        "-json", outputFile,
        "-timeout", "5",
      ], { timeout: 360000 }); // 6 minutes — amass can be slow

      // Read JSON output
      let entries = [];
      try {
        const fileResult = await cliRunner.runTool("cat", [outputFile], { timeout: 5000 });
        if (fileResult.parsed) {
          entries = Array.isArray(fileResult.parsed) ? fileResult.parsed : [fileResult.parsed];
        }
      } catch { /* file may not exist */ }

      // Clean up
      cliRunner.runTool("rm", ["-f", outputFile], { timeout: 5000 }).catch(() => {});

      if (entries.length > 0) {
        // Extract unique subdomains
        const subdomains = new Set();
        const sources = new Set();
        const addresses = new Set();

        for (const entry of entries) {
          if (entry.name) subdomains.add(entry.name);
          if (entry.source) sources.add(entry.source);
          if (entry.addresses) {
            for (const addr of entry.addresses) {
              if (addr.ip) addresses.add(addr.ip);
            }
          }
        }

        findings.push({
          category: "infrastructure",
          severity: subdomains.size > 50 ? "high" : subdomains.size > 10 ? "medium" : "low",
          title: `Amass: ${subdomains.size} subdomain(s) discovered for ${domain}`,
          description: `Sources: ${[...sources].join(", ")}\nSubdomains: ${[...subdomains].slice(0, 20).join(", ")}${subdomains.size > 20 ? ` (+${subdomains.size - 20} more)` : ""}\nUnique IPs: ${addresses.size}`,
          rawData: {
            domain,
            totalSubdomains: subdomains.size,
            subdomains: [...subdomains].slice(0, 100),
            sources: [...sources],
            addresses: [...addresses].slice(0, 50),
          },
          remediation: "Review all subdomains for unused or forgotten services. Unused subdomains can be vulnerable to takeover.",
        });

        // Flag wildcard DNS or excessive subdomains
        if (subdomains.size > 100) {
          findings.push({
            category: "infrastructure",
            severity: "medium",
            title: `Large attack surface: ${subdomains.size} subdomains`,
            description: "A large number of subdomains increases the attack surface. Some may be forgotten, misconfigured, or vulnerable to takeover.",
            rawData: { subdomainCount: subdomains.size },
            remediation: "Audit all subdomains. Remove DNS entries for decommissioned services. Monitor for subdomain takeover.",
          });
        }
      } else {
        // Fall back to stdout parsing
        const stdout = result.stdout || "";
        const subdomainLines = stdout.split("\n").filter((l) => l.includes(domain) && !l.startsWith("[") && l.trim().length > 0);

        if (subdomainLines.length > 0) {
          findings.push({
            category: "infrastructure",
            severity: subdomainLines.length > 10 ? "medium" : "low",
            title: `Amass: ${subdomainLines.length} subdomain(s) for ${domain}`,
            description: subdomainLines.slice(0, 15).join("\n"),
            rawData: { domain, subdomains: subdomainLines.slice(0, 100) },
            remediation: "Review discovered subdomains for forgotten or vulnerable services.",
          });
        } else {
          findings.push({
            category: "infrastructure",
            severity: "info",
            title: `Amass: No subdomains found for ${domain}`,
            description: "Passive enumeration returned no results. The domain may have limited DNS exposure.",
            rawData: { domain },
          });
        }
      }
    } catch (err) {
      findings.push({
        category: "infrastructure",
        severity: "info",
        title: `Amass scan error: ${err.message}`,
        description: `Failed to enumerate subdomains for "${domain}".`,
        rawData: { error: err.message, tool: "amass" },
      });
    }

    return findings;
  },
};
