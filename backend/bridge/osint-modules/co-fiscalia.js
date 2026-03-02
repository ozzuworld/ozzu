// Colombian OSINT: Fiscalía General de la Nación — Criminal investigation status
// Source: fiscalia.gov.co — no public API, hard captcha
// Access: Info-only stub with manual lookup link
const { validateCedula } = require("./co-utils");

module.exports = {
  name: "co-fiscalia",
  profileTypes: ["cedula"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const cedula = validateCedula(profile.value);
    if (!cedula) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "Fiscalía: Invalid cédula format",
        description: `The value "${profile.value}" is not a valid Colombian cédula.`,
        rawData: { input: profile.value },
      });
      return findings;
    }

    // Fiscalía has no public API — manual lookup only
    findings.push({
      category: "metadata",
      severity: "info",
      title: "Fiscalía: Manual lookup required",
      description: [
        `The Fiscalía General de la Nación (Attorney General's Office) does not provide public API access.`,
        `To check if CC: ${cedula} has any ongoing criminal investigations or prosecution records,`,
        `visit the SPOA (Sistema Penal Oral Acusatorio) portal or contact the Fiscalía directly.`,
        ``,
        `Note: The Fiscalía handles criminal prosecution — separate from Policía (background check) and Rama Judicial (court cases).`,
      ].join("\n"),
      sourceUrl: "https://www.fiscalia.gov.co/colombia/servicios-de-informacion-al-ciudadano/consulta-de-procesos/",
      rawData: { searched: cedula, stub: true },
      remediation: "Visit https://www.fiscalia.gov.co/ or call the Fiscalía hotline (018000919748) to inquire about prosecution status.",
    });

    return findings;
  },
};
