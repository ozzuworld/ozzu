// h8mail CLI module — breach data aggregation from multiple free sources
// Uses h8mail via docker exec osint-tools
const cliRunner = require("../osint-cli-runner");
const crypto = require("crypto");

module.exports = {
  name: "h8mail-cli",
  profileTypes: ["email"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const email = profile.value;

    const available = await cliRunner.isToolAvailable("h8mail");
    if (!available) {
      findings.push({
        category: "breach",
        severity: "info",
        title: "h8mail scan skipped — tool not available",
        description: "h8mail CLI is not installed in the osint-tools container.",
        rawData: { reason: "tool_unavailable", tool: "h8mail" },
      });
      return findings;
    }

    const outputId = crypto.randomBytes(4).toString("hex");
    const outputFile = `/tmp/osint-data/h8mail-${outputId}.json`;

    try {
      const result = await cliRunner.runTool("h8mail", [
        "-t", email,
        "-j", outputFile,
      ], { timeout: 90000 });

      // Read JSON output
      let output = null;
      try {
        const fileResult = await cliRunner.runTool("cat", [outputFile], { timeout: 5000 });
        output = fileResult.parsed;
      } catch { /* file may not exist */ }

      // Clean up
      cliRunner.runTool("rm", ["-f", outputFile], { timeout: 5000 }).catch(() => {});

      if (output) {
        const targets = Array.isArray(output) ? output : (output.targets || [output]);

        for (const target of targets) {
          const breaches = target.data || target.breaches || [];
          const passwords = target.passwords || [];

          if (breaches.length > 0) {
            findings.push({
              category: "breach",
              severity: breaches.length > 5 ? "critical" : "high",
              title: `h8mail: ${breaches.length} breach source(s) found for "${email}"`,
              description: breaches.slice(0, 10).map((b) => {
                if (typeof b === "string") return b;
                return `${b.source || b.name || "Unknown"}: ${b.info || b.data || ""}`;
              }).join("\n"),
              rawData: { email, breaches: breaches.slice(0, 50) },
              remediation: "Change passwords for all compromised accounts. Enable 2FA. Check if breached data includes sensitive information.",
            });
          }

          if (passwords.length > 0) {
            findings.push({
              category: "breach",
              severity: "critical",
              title: `h8mail: ${passwords.length} password(s) found in breaches`,
              description: "Cleartext or hashed passwords were found in breach databases. Immediate password change required.",
              rawData: { email, passwordCount: passwords.length, hashed: passwords.map((p) => p.substring(0, 4) + "***") },
              remediation: "URGENT: Change this password everywhere it's used. Enable 2FA on all accounts. Use a password manager with unique passwords.",
            });
          }
        }
      }

      // Parse stdout as fallback
      if (findings.length === 0) {
        const stdout = result.stdout || "";
        // Strip ANSI color codes before parsing — h8mail uses heavy terminal formatting
        // that causes false positives (e.g. "[01m[94m[~]" matches as "[" + "found")
        const clean = stdout.replace(/\x1b\[[0-9;]*m/g, "").replace(/\[0m/g, "");
        const breachLines = clean.split("\n").filter((l) => {
          const lower = l.toLowerCase();
          // Must contain actual breach indicators, not just status messages
          return (lower.includes("breach") || lower.includes("leak") || lower.includes("dump")) &&
            !lower.includes("no results") && !lower.includes("not found") && !lower.includes("0 results") &&
            l.trim().length > 10;
        });

        if (breachLines.length > 0) {
          findings.push({
            category: "breach",
            severity: "high",
            title: `h8mail: Breach data found for "${email}"`,
            description: breachLines.slice(0, 10).join("\n"),
            rawData: { email, output: breachLines },
            remediation: "Review breach data and change associated passwords.",
          });
        } else {
          findings.push({
            category: "breach",
            severity: "info",
            title: `h8mail: No breach data found for "${email}"`,
            description: "Checked free breach databases. No matches found.",
            rawData: { email },
          });
        }
      }
    } catch (err) {
      findings.push({
        category: "breach",
        severity: "info",
        title: `h8mail scan error: ${err.message}`,
        description: `Failed to check breach data for "${email}".`,
        rawData: { error: err.message, tool: "h8mail" },
      });
    }

    return findings;
  },
};
