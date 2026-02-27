// Holehe CLI module — checks 120+ services for email registration
// Uses holehe via docker exec osint-tools
const cliRunner = require("../osint-cli-runner");

module.exports = {
  name: "holehe-cli",
  profileTypes: ["email"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const email = profile.value;

    const available = await cliRunner.isToolAvailable("holehe");
    if (!available) {
      findings.push({
        category: "account_found",
        severity: "info",
        title: "Holehe scan skipped — tool not available",
        description: "Holehe CLI is not installed in the osint-tools container.",
        rawData: { reason: "tool_unavailable", tool: "holehe" },
      });
      return findings;
    }

    try {
      const result = await cliRunner.runTool("holehe", [
        "--only-used",
        "--no-color",
        email,
      ], { timeout: 120000, parseJson: false });

      const stdout = result.stdout || "";
      const lines = stdout.split("\n").filter(Boolean);

      // Parse holehe output: lines containing [+] = registered, [-] = not registered
      const registeredServices = [];
      const recoveryInfo = [];

      for (const line of lines) {
        // [+] ServiceName: registered (recovery: email@***)
        if (line.includes("[+]")) {
          const match = line.match(/\[[\+x]\]\s*(\S+)/);
          const serviceName = match ? match[1].replace(":", "") : line.trim();
          registeredServices.push(serviceName);

          // Check for recovery info
          const recoveryMatch = line.match(/recovery[:\s]+(\S+)/i);
          if (recoveryMatch) {
            recoveryInfo.push({ service: serviceName, recovery: recoveryMatch[1] });
          }
        }
      }

      if (registeredServices.length > 0) {
        findings.push({
          category: "account_found",
          severity: registeredServices.length > 10 ? "high" : "medium",
          title: `Holehe: ${registeredServices.length} services registered with this email`,
          description: `Active registrations: ${registeredServices.slice(0, 20).join(", ")}${registeredServices.length > 20 ? ` (+${registeredServices.length - 20} more)` : ""}`,
          rawData: { email, totalFound: registeredServices.length, services: registeredServices },
          remediation: "These services confirm the email is actively registered. Review each for unnecessary accounts. Holehe checks via password-reset endpoints — registrations are confirmed, not guessed.",
        });

        if (recoveryInfo.length > 0) {
          findings.push({
            category: "exposure",
            severity: "high",
            title: `Recovery details leaked from ${recoveryInfo.length} services`,
            description: recoveryInfo.slice(0, 10).map((r) => `${r.service}: ${r.recovery}`).join("\n"),
            rawData: { recoveryInfo },
            remediation: "Recovery emails/phones are exposed via password-reset pages. Use unique recovery addresses per service.",
          });
        }
      } else {
        findings.push({
          category: "account_found",
          severity: "info",
          title: `Holehe: No registrations found for "${email}"`,
          description: "Checked 120+ services via password-reset endpoints. No confirmed registrations.",
          rawData: { email, totalFound: 0 },
        });
      }
    } catch (err) {
      findings.push({
        category: "account_found",
        severity: "info",
        title: `Holehe scan error: ${err.message}`,
        description: `Failed to check email registrations for "${email}".`,
        rawData: { error: err.message, tool: "holehe" },
      });
    }

    return findings;
  },
};
