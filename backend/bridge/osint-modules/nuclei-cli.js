// Nuclei CLI module — template-based vulnerability scanning
// Uses nuclei binary via docker exec osint-tools
const cliRunner = require("../osint-cli-runner");

module.exports = {
  name: "nuclei-cli",
  profileTypes: ["domain", "ip"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const target = profile.value;

    const available = await cliRunner.isToolAvailable("nuclei");
    if (!available) {
      findings.push({
        category: "vulnerability",
        severity: "info",
        title: "Nuclei scan skipped — tool not available",
        description: "Nuclei binary is not installed in the osint-tools container.",
        rawData: { reason: "tool_unavailable", tool: "nuclei" },
      });
      return findings;
    }

    try {
      // Build target URL for domains
      const targetUrl = profile.profile_type === "domain"
        ? (target.startsWith("http") ? target : `https://${target}`)
        : target;

      const result = await cliRunner.runTool("nuclei", [
        "-u", targetUrl,
        "-jsonl",
        "-severity", "medium,high,critical",
        "-silent",
        "-timeout", "10",
        "-retries", "1",
        "-rate-limit", "50",
      ], { timeout: 300000 }); // 5 minutes

      const entries = result.parsed;

      if (entries && Array.isArray(entries) && entries.length > 0) {
        // Group by severity
        const bySeverity = { critical: [], high: [], medium: [] };
        for (const e of entries) {
          const sev = (e.info && e.info.severity) || "medium";
          if (bySeverity[sev]) bySeverity[sev].push(e);
        }

        // Summary finding
        findings.push({
          category: "vulnerability",
          severity: bySeverity.critical.length > 0 ? "critical" : bySeverity.high.length > 0 ? "high" : "medium",
          title: `Nuclei: ${entries.length} vulnerability(ies) found on ${target}`,
          description: `Critical: ${bySeverity.critical.length}, High: ${bySeverity.high.length}, Medium: ${bySeverity.medium.length}`,
          rawData: {
            target,
            total: entries.length,
            bySeverity: {
              critical: bySeverity.critical.length,
              high: bySeverity.high.length,
              medium: bySeverity.medium.length,
            },
          },
          remediation: "Review each vulnerability and apply patches or configuration fixes. Critical issues should be addressed immediately.",
        });

        // Individual findings for critical/high
        for (const entry of [...bySeverity.critical, ...bySeverity.high].slice(0, 10)) {
          const info = entry.info || {};
          findings.push({
            category: "vulnerability",
            severity: info.severity || "high",
            title: `${info.name || entry["template-id"] || "Unknown"} (${info.severity || "unknown"})`,
            description: `Template: ${entry["template-id"] || "N/A"}\nMatched: ${entry["matched-at"] || entry.host || "N/A"}\n${info.description || ""}`.trim(),
            sourceUrl: (info.reference && info.reference[0]) || null,
            rawData: { nuclei: entry },
            remediation: info.remediation || "Apply security patches and review server configuration.",
          });
        }
      } else {
        findings.push({
          category: "vulnerability",
          severity: "info",
          title: `Nuclei: No medium+ vulnerabilities found on ${target}`,
          description: "Scanned with community templates. No medium, high, or critical issues detected.",
          rawData: { target },
        });
      }
    } catch (err) {
      findings.push({
        category: "vulnerability",
        severity: "info",
        title: `Nuclei scan error: ${err.message}`,
        description: `Failed to scan "${target}" for vulnerabilities.`,
        rawData: { error: err.message, tool: "nuclei" },
      });
    }

    return findings;
  },
};
