// Maigret CLI module — username search across 2500+ sites with PII extraction
// Uses maigret via docker exec osint-tools
const cliRunner = require("../osint-cli-runner");
const crypto = require("crypto");

module.exports = {
  name: "maigret-cli",
  profileTypes: ["username"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const username = profile.value;

    const available = await cliRunner.isToolAvailable("maigret");
    if (!available) {
      findings.push({
        category: "account_found",
        severity: "info",
        title: "Maigret scan skipped — tool not available",
        description: "Maigret CLI is not installed in the osint-tools container.",
        rawData: { reason: "tool_unavailable", tool: "maigret" },
      });
      return findings;
    }

    const outputId = crypto.randomBytes(4).toString("hex");
    const outputPath = `/tmp/osint-data/maigret-${outputId}`;

    try {
      const result = await cliRunner.runTool("maigret", [
        username,
        "--timeout", "10",
        "--top-sites", "500",
        "--json", "ndjson",
        "-o", outputPath,
      ], { timeout: 180000 });

      // Try to read ndjson output
      let entries = [];
      try {
        const fileResult = await cliRunner.runTool("cat", [`${outputPath}.ndjson`], {
          timeout: 5000,
        });
        if (fileResult.parsed && Array.isArray(fileResult.parsed)) {
          entries = fileResult.parsed;
        }
      } catch {
        // Fall back to stdout parsing
        if (result.parsed && Array.isArray(result.parsed)) {
          entries = result.parsed;
        }
      }

      // Clean up output files
      cliRunner.runTool("sh", ["-c", `rm -f ${outputPath}*`], { timeout: 5000 }).catch(() => {});

      if (entries.length > 0) {
        const claimed = entries.filter((e) => e.status === "Claimed" || e.is_similar === false);

        if (claimed.length > 0) {
          findings.push({
            category: "account_found",
            severity: claimed.length > 30 ? "high" : "medium",
            title: `Maigret: ${claimed.length} accounts found for "${username}" (2500+ sites)`,
            description: `Platforms: ${claimed.slice(0, 20).map((e) => e.sitename || e.site_name || "unknown").join(", ")}${claimed.length > 20 ? ` (+${claimed.length - 20} more)` : ""}`,
            rawData: { username, totalFound: claimed.length, sites: claimed.slice(0, 100).map((e) => ({ site: e.sitename || e.site_name, url: e.url || e.link, tags: e.tags })) },
            remediation: "Maigret provides deep coverage across 2500+ sites. Review unfamiliar accounts — they may be impersonation.",
          });

          // Extract PII from entries that have it
          const piiEntries = claimed.filter((e) => e.ids_data && Object.keys(e.ids_data).length > 0);
          if (piiEntries.length > 0) {
            const allPii = {};
            for (const e of piiEntries) {
              for (const [key, val] of Object.entries(e.ids_data)) {
                if (val && typeof val === "string" && val.length > 0) {
                  if (!allPii[key]) allPii[key] = new Set();
                  allPii[key].add(val);
                }
              }
            }

            const piiSummary = Object.entries(allPii)
              .map(([key, vals]) => `${key}: ${[...vals].slice(0, 3).join(", ")}`)
              .slice(0, 10)
              .join("\n");

            if (piiSummary) {
              findings.push({
                category: "exposure",
                severity: "high",
                title: `PII extracted from ${piiEntries.length} profiles`,
                description: piiSummary,
                rawData: { piiFields: Object.fromEntries(Object.entries(allPii).map(([k, v]) => [k, [...v]])) },
                remediation: "Personal information was extracted from public profiles. Review privacy settings on each platform.",
              });
            }
          }
        } else {
          findings.push({
            category: "account_found",
            severity: "info",
            title: `Maigret: No confirmed accounts for "${username}"`,
            description: "Scanned top 500 sites with no confirmed matches.",
            rawData: { username, totalEntries: entries.length },
          });
        }
      } else {
        // Parse text output as fallback
        const stdout = result.stdout || "";
        const matchLines = stdout.split("\n").filter((l) => l.includes("[+]") || l.includes("Claimed"));
        if (matchLines.length > 0) {
          findings.push({
            category: "account_found",
            severity: matchLines.length > 10 ? "high" : "medium",
            title: `Maigret: ${matchLines.length} potential matches for "${username}"`,
            description: matchLines.slice(0, 10).join("\n"),
            rawData: { username, outputLines: matchLines.slice(0, 50) },
          });
        } else {
          findings.push({
            category: "account_found",
            severity: "info",
            title: `Maigret: No results for "${username}"`,
            description: "No accounts detected across top 500 sites.",
            rawData: { username },
          });
        }
      }
    } catch (err) {
      findings.push({
        category: "account_found",
        severity: "info",
        title: `Maigret scan error: ${err.message}`,
        description: `Failed to run Maigret for username "${username}".`,
        rawData: { error: err.message, tool: "maigret" },
      });
    }

    return findings;
  },
};
