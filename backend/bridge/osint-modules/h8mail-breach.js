// h8mail email breach hunting — searches breach databases beyond HIBP
// Wraps: /opt/osint-venv/bin/h8mail
const cli = require("./cli-runner");
const fs = require("fs");

const H8MAIL_BIN = "/opt/osint-venv/bin/h8mail";

module.exports = {
  name: "h8mail-breach",
  profileTypes: ["email"],

  async scan(profile, rateLimiter) {
    const findings = [];

    if (!cli.binaryExists(H8MAIL_BIN)) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "h8mail unavailable — not installed",
        rawData: { reason: "no_h8mail" },
      });
      return findings;
    }

    const release = await rateLimiter.acquire();
    const outFile = cli.tempPath("h8mail", "json");
    try {
      await cli.run(H8MAIL_BIN, [
        "-t", profile.value,
        "-j", outFile,
      ], { timeout: 90000, allowNonZero: true });

      if (!fs.existsSync(outFile)) {
        findings.push({
          category: "metadata",
          severity: "info",
          title: "h8mail: no output file generated",
          rawData: { source: "h8mail" },
        });
        return findings;
      }

      let results;
      try { results = JSON.parse(fs.readFileSync(outFile, "utf8")); } catch { results = null; }

      if (!results || !results.targets || results.targets.length === 0) {
        findings.push({
          category: "metadata",
          severity: "info",
          title: "h8mail: no breach data found",
          description: "No breaches found in h8mail's free sources. Configure API keys for Snusbase/LeakLookup for more coverage.",
          rawData: { source: "h8mail" },
        });
        return findings;
      }

      let totalBreaches = 0;
      for (const target of results.targets) {
        if (!target.data || target.data.length === 0) continue;

        for (const entry of target.data) {
          totalBreaches++;
          const source = entry[0] || "unknown";
          const data = entry[1] || "";

          // Determine severity based on data leaked
          const hasPassword = data.toLowerCase().includes("password") || data.includes(":");
          findings.push({
            category: "breach",
            severity: hasPassword ? "critical" : "high",
            title: `h8mail: breach data from ${source}`,
            description: `Source: ${source}\nData: ${data.slice(0, 200)}${data.length > 200 ? "..." : ""}`,
            rawData: {
              source: "h8mail",
              breachSource: source,
              dataPreview: data.slice(0, 500),
              hasPassword,
            },
            remediation: hasPassword
              ? "Leaked password found. Change this password immediately on all sites where it's used."
              : "Your email appears in breach data. Monitor for unauthorized access.",
          });
        }
      }

      findings.push({
        category: "metadata",
        severity: totalBreaches > 0 ? "high" : "info",
        title: `h8mail: ${totalBreaches} breach record(s) found`,
        rawData: { totalBreaches, source: "h8mail" },
      });
    } catch (err) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "h8mail scan error",
        description: err.message,
        rawData: { error: err.message, source: "h8mail" },
      });
    } finally {
      release();
      try { fs.unlinkSync(outFile); } catch {}
    }

    return findings;
  },
};
