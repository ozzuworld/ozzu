// Colombian OSINT: Libreta Militar — Military service status
// Source: libretamilitar.mil.co — no public API, requires personal data
// Access: Info-only stub with manual lookup link
const { validateCedula } = require("./co-utils");

module.exports = {
  name: "co-libreta-militar",
  profileTypes: ["cedula"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const cedula = validateCedula(profile.value);
    if (!cedula) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "Libreta Militar: Invalid cédula format",
        description: `The value "${profile.value}" is not a valid Colombian cédula.`,
        rawData: { input: profile.value },
      });
      return findings;
    }

    // Libreta militar has no public API — manual lookup only
    findings.push({
      category: "metadata",
      severity: "info",
      title: "Libreta Militar: Manual lookup required",
      description: [
        `The Colombian military service records (Libreta Militar) are not publicly queryable via API.`,
        `To check military service status for CC: ${cedula}, visit the Ejército Nacional portal.`,
        ``,
        `Libreta Militar is required for Colombian males for:`,
        `• Public employment`,
        `• Passport issuance`,
        `• Notarial procedures`,
        `• University enrollment (some institutions)`,
      ].join("\n"),
      sourceUrl: "https://www.libretamilitar.mil.co/",
      rawData: { searched: cedula, stub: true },
      remediation: "Visit https://www.libretamilitar.mil.co/ to check military service status. If the libreta is pending, contact the nearest Distrito Militar.",
    });

    return findings;
  },
};
