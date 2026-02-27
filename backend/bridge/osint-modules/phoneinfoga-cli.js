// PhoneInfoga CLI module — phone number OSINT (carrier, Google dorks, disposable detection)
// Uses phoneinfoga binary via docker exec osint-tools
const cliRunner = require("../osint-cli-runner");

module.exports = {
  name: "phoneinfoga-cli",
  profileTypes: ["phone"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const phone = profile.value;

    const available = await cliRunner.isToolAvailable("phoneinfoga");
    if (!available) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "PhoneInfoga scan skipped — tool not available",
        description: "PhoneInfoga binary is not installed in the osint-tools container.",
        rawData: { reason: "tool_unavailable", tool: "phoneinfoga" },
      });
      return findings;
    }

    try {
      const result = await cliRunner.runTool("phoneinfoga", [
        "scan",
        "-n", phone,
      ], { timeout: 60000 });

      const stdout = result.stdout || "";
      const parsed = result.parsed;

      if (parsed) {
        // Structured JSON output
        const data = Array.isArray(parsed) ? parsed[0] : parsed;

        if (data) {
          // Carrier/line info
          if (data.carrier || data.line_type) {
            findings.push({
              category: "exposure",
              severity: "medium",
              title: `PhoneInfoga: ${data.carrier || "Unknown carrier"} (${data.line_type || "unknown type"})`,
              description: `Carrier: ${data.carrier || "N/A"}\nLine type: ${data.line_type || "N/A"}\nCountry: ${data.country || "N/A"}\nValid: ${data.valid !== false}`,
              rawData: { phoneinfoga: data },
              remediation: "Phone carrier and line type are publicly queryable. Consider a VoIP number for public accounts.",
            });
          }

          // Google dork results
          if (data.dorks && data.dorks.length > 0) {
            findings.push({
              category: "exposure",
              severity: "high",
              title: `PhoneInfoga: ${data.dorks.length} Google dork results`,
              description: data.dorks.slice(0, 5).map((d) => `${d.dork || d.query}: ${d.url || ""}`).join("\n"),
              rawData: { dorks: data.dorks },
              remediation: "Phone number appears in indexed web pages. Request removal from sites exposing it.",
            });
          }

          // Disposable number detection
          if (data.disposable) {
            findings.push({
              category: "exposure",
              severity: "low",
              title: "PhoneInfoga: Disposable/VoIP number detected",
              description: "This number is flagged as a disposable or VoIP number.",
              rawData: { disposable: true },
            });
          }
        }
      } else {
        // Parse text output
        const lines = stdout.split("\n").filter(Boolean);
        const infoLines = lines.filter((l) => !l.startsWith("Running") && !l.startsWith("Using") && l.trim().length > 0);

        if (infoLines.length > 0) {
          findings.push({
            category: "exposure",
            severity: "medium",
            title: `PhoneInfoga scan results for ${phone}`,
            description: infoLines.slice(0, 15).join("\n"),
            rawData: { phone, output: infoLines },
          });
        }
      }

      if (findings.length === 0) {
        findings.push({
          category: "exposure",
          severity: "info",
          title: `PhoneInfoga: No additional data for ${phone}`,
          description: "PhoneInfoga returned no significant findings beyond basic validation.",
          rawData: { phone },
        });
      }
    } catch (err) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: `PhoneInfoga scan error: ${err.message}`,
        description: `Failed to scan phone number "${phone}".`,
        rawData: { error: err.message, tool: "phoneinfoga" },
      });
    }

    return findings;
  },
};
