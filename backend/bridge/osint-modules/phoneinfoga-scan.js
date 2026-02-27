// PhoneInfoga deep phone OSINT — carrier, Google dorks, validation
// Wraps: phoneinfoga Go binary
const cli = require("./cli-runner");

module.exports = {
  name: "phoneinfoga-scan",
  profileTypes: ["phone"],

  async scan(profile, rateLimiter) {
    const findings = [];

    if (!cli.binaryExists("phoneinfoga")) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "PhoneInfoga unavailable — binary not installed",
        rawData: { reason: "no_phoneinfoga" },
      });
      return findings;
    }

    const release = await rateLimiter.acquire();
    try {
      const stdout = await cli.run("phoneinfoga", ["scan", "-n", profile.value], {
        timeout: 45000,
        allowNonZero: true,
      });

      if (!stdout || !stdout.trim()) {
        findings.push({
          category: "metadata",
          severity: "info",
          title: "PhoneInfoga returned no data",
          rawData: { source: "phoneinfoga" },
        });
        return findings;
      }

      // Parse structured text output
      const lines = stdout.split("\n");
      const parsed = {
        valid: null,
        carrier: null,
        lineType: null,
        country: null,
        countryCode: null,
        international: null,
        local: null,
        e164: null,
        googleDorks: [],
      };

      let inGoogleSection = false;
      for (const line of lines) {
        const l = line.trim();
        if (l.includes("Valid:")) parsed.valid = l.includes("true");
        if (l.includes("Carrier:")) parsed.carrier = l.split("Carrier:")[1]?.trim();
        if (l.includes("Line type:") || l.includes("LineType:")) parsed.lineType = l.split(":").slice(1).join(":").trim();
        if (l.includes("Country:")) parsed.country = l.split("Country:")[1]?.trim();
        if (l.includes("CountryCode:") || l.includes("Country code:")) parsed.countryCode = l.split(":").slice(1).join(":").trim();
        if (l.includes("International:") || l.includes("E164:")) parsed.e164 = l.split(":").slice(1).join(":").trim();
        if (l.includes("Local:")) parsed.local = l.split("Local:")[1]?.trim();
        if (l.includes("Google") || l.includes("dork")) inGoogleSection = true;
        if (inGoogleSection && l.startsWith("http")) {
          parsed.googleDorks.push(l);
        }
      }

      if (parsed.valid === false) {
        findings.push({
          category: "metadata",
          severity: "info",
          title: "PhoneInfoga: invalid phone number format",
          rawData: { valid: false, source: "phoneinfoga" },
        });
        return findings;
      }

      // Carrier/validation info
      if (parsed.carrier || parsed.country) {
        findings.push({
          category: "metadata",
          severity: "low",
          title: `PhoneInfoga: ${parsed.carrier || "Unknown carrier"} (${parsed.country || "Unknown country"})`,
          description: [
            parsed.carrier ? `Carrier: ${parsed.carrier}` : null,
            parsed.lineType ? `Line type: ${parsed.lineType}` : null,
            parsed.country ? `Country: ${parsed.country}` : null,
            parsed.e164 ? `E.164: ${parsed.e164}` : null,
          ].filter(Boolean).join("\n"),
          rawData: { ...parsed, source: "phoneinfoga" },
        });
      }

      // Google dorks
      if (parsed.googleDorks.length > 0) {
        findings.push({
          category: "exposure",
          severity: "medium",
          title: `PhoneInfoga: ${parsed.googleDorks.length} Google dork URL(s) generated`,
          description: `Search URLs for finding this number online:\n${parsed.googleDorks.slice(0, 5).join("\n")}`,
          rawData: { googleDorks: parsed.googleDorks, source: "phoneinfoga" },
          remediation: "These URLs may reveal where your phone number appears publicly online.",
        });
      }

      findings.push({
        category: "metadata",
        severity: "info",
        title: "PhoneInfoga scan complete",
        rawData: { ...parsed, rawOutput: stdout.slice(0, 2000), source: "phoneinfoga" },
      });
    } catch (err) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "PhoneInfoga scan error",
        description: err.message,
        rawData: { error: err.message, source: "phoneinfoga" },
      });
    } finally {
      release();
    }

    return findings;
  },
};
