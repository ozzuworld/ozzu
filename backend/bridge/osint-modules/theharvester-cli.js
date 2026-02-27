// theHarvester CLI module — email, subdomain, and host discovery from public sources
// Uses theHarvester via docker exec osint-tools
const cliRunner = require("../osint-cli-runner");

module.exports = {
  name: "theharvester-cli",
  profileTypes: ["domain", "email"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const target = profile.value;

    const available = await cliRunner.isToolAvailable("theHarvester");
    if (!available) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "theHarvester scan skipped — tool not available",
        description: "theHarvester CLI is not installed in the osint-tools container.",
        rawData: { reason: "tool_unavailable", tool: "theHarvester" },
      });
      return findings;
    }

    // For email profiles, extract domain
    const domain = profile.profile_type === "email" ? target.split("@")[1] : target;

    try {
      const result = await cliRunner.runTool("theHarvester", [
        "-d", domain,
        "-b", "anubis,crtsh,dnsdumpster,duckduckgo,hackertarget,rapiddns,sublist3r,urlscan",
        "-l", "200",
      ], { timeout: 180000, parseJson: false });

      const stdout = result.stdout || "";

      // Parse sections from theHarvester output
      const emails = [];
      const hosts = [];
      const ips = [];
      let currentSection = null;

      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.includes("Emails found:") || trimmed.includes("[*] Emails found:")) {
          currentSection = "emails";
          continue;
        }
        if (trimmed.includes("Hosts found:") || trimmed.includes("[*] Hosts found:")) {
          currentSection = "hosts";
          continue;
        }
        if (trimmed.includes("IPs found:") || trimmed.includes("[*] IPs found:")) {
          currentSection = "ips";
          continue;
        }
        if (trimmed.startsWith("[*]") || trimmed.startsWith("---") || trimmed.length === 0) {
          if (trimmed.startsWith("[*]")) currentSection = null;
          continue;
        }

        if (currentSection === "emails" && trimmed.includes("@")) {
          emails.push(trimmed);
        } else if (currentSection === "hosts" && trimmed.includes(domain)) {
          hosts.push(trimmed);
        } else if (currentSection === "ips" && /\d+\.\d+\.\d+\.\d+/.test(trimmed)) {
          ips.push(trimmed);
        }
      }

      // Email findings
      if (emails.length > 0) {
        findings.push({
          category: "exposure",
          severity: emails.length > 10 ? "high" : "medium",
          title: `theHarvester: ${emails.length} email(s) found for ${domain}`,
          description: emails.slice(0, 20).join("\n"),
          rawData: { domain, emails: emails.slice(0, 100) },
          remediation: "Email addresses gathered from public sources. Review if any should not be publicly indexed.",
        });
      }

      // Host/subdomain findings
      if (hosts.length > 0) {
        findings.push({
          category: "infrastructure",
          severity: hosts.length > 20 ? "high" : "medium",
          title: `theHarvester: ${hosts.length} host(s)/subdomain(s) for ${domain}`,
          description: hosts.slice(0, 20).join("\n"),
          rawData: { domain, hosts: hosts.slice(0, 100) },
          remediation: "Review discovered hosts for unused or misconfigured services.",
        });
      }

      // IP findings
      if (ips.length > 0) {
        findings.push({
          category: "infrastructure",
          severity: "low",
          title: `theHarvester: ${ips.length} IP(s) associated with ${domain}`,
          description: ips.slice(0, 15).join(", "),
          rawData: { domain, ips: ips.slice(0, 50) },
        });
      }

      if (findings.length === 0) {
        findings.push({
          category: "exposure",
          severity: "info",
          title: `theHarvester: No public data found for ${domain}`,
          description: "Searched across multiple public data sources with no significant findings.",
          rawData: { domain },
        });
      }
    } catch (err) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: `theHarvester scan error: ${err.message}`,
        description: `Failed to harvest data for "${domain}".`,
        rawData: { error: err.message, tool: "theHarvester" },
      });
    }

    return findings;
  },
};
