// Sherlock CLI module — username search across 400+ sites
// Uses sherlock-project via docker exec osint-tools
const cliRunner = require("../osint-cli-runner");

module.exports = {
  name: "sherlock-cli",
  profileTypes: ["username"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const username = profile.value;

    // Check tool availability
    const available = await cliRunner.isToolAvailable("sherlock");
    if (!available) {
      findings.push({
        category: "account_found",
        severity: "info",
        title: "Sherlock scan skipped — tool not available",
        description: "The Sherlock CLI tool is not installed in the osint-tools container.",
        rawData: { reason: "tool_unavailable", tool: "sherlock" },
      });
      return findings;
    }

    try {
      const result = await cliRunner.runTool("sherlock", [
        username,
        "--json", "/tmp/osint-data/sherlock-output.json",
        "--timeout", "15",
      ], { timeout: 180000, parseJson: false });

      // Read the JSON output file
      let output;
      try {
        const fileResult = await cliRunner.runTool("cat", ["/tmp/osint-data/sherlock-output.json"], {
          timeout: 5000,
        });
        output = fileResult.parsed;
      } catch {
        // Try parsing stdout if file read fails
        output = null;
      }

      // Clean up
      cliRunner.runTool("rm", ["-f", "/tmp/osint-data/sherlock-output.json"], { timeout: 5000 }).catch(() => {});

      if (output && typeof output === "object") {
        const sites = Object.entries(output);
        const found = sites.filter(([, data]) => data && data.status === "Claimed");

        if (found.length > 0) {
          findings.push({
            category: "account_found",
            severity: found.length > 20 ? "high" : "medium",
            title: `Sherlock: ${found.length} accounts found for "${username}"`,
            description: `Found on: ${found.slice(0, 15).map(([site]) => site).join(", ")}${found.length > 15 ? ` (+${found.length - 15} more)` : ""}`,
            rawData: { username, totalFound: found.length, sites: found.slice(0, 50).map(([site, data]) => ({ site, url: data.url_user })) },
            remediation: "Review accounts on platforms you no longer use. Delete or deactivate unnecessary accounts to reduce your digital footprint.",
          });

          // Individual findings for sensitive platforms
          const sensitivePlatforms = ["GitHub", "LinkedIn", "Facebook", "Instagram", "Twitter", "Reddit", "TikTok", "Discord"];
          for (const [site, data] of found) {
            if (sensitivePlatforms.includes(site)) {
              findings.push({
                category: "account_found",
                severity: "medium",
                title: `Sherlock: ${site} account found`,
                description: `Profile URL: ${data.url_user || "N/A"}`,
                sourceUrl: data.url_user || null,
                rawData: { site, url: data.url_user, tool: "sherlock" },
              });
            }
          }
        } else {
          findings.push({
            category: "account_found",
            severity: "info",
            title: `Sherlock: No accounts found for "${username}"`,
            description: `Sherlock checked 400+ sites and found no matches.`,
            rawData: { username, totalFound: 0 },
          });
        }
      } else if (result.stdout) {
        // Parse text output as fallback
        const lines = result.stdout.split("\n").filter((l) => l.includes("[+]") || l.includes("http"));
        if (lines.length > 0) {
          findings.push({
            category: "account_found",
            severity: lines.length > 10 ? "high" : "medium",
            title: `Sherlock: ${lines.length} potential matches for "${username}"`,
            description: lines.slice(0, 10).join("\n"),
            rawData: { username, outputLines: lines.slice(0, 50) },
            remediation: "Review accounts on platforms you no longer use.",
          });
        }
      }
    } catch (err) {
      findings.push({
        category: "account_found",
        severity: "info",
        title: `Sherlock scan error: ${err.message}`,
        description: `Failed to run Sherlock for username "${username}".`,
        rawData: { error: err.message, tool: "sherlock" },
      });
    }

    return findings;
  },
};
