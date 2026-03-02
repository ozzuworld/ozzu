// Colombian OSINT: REDAM (Registro de Deudores Alimentarios Morosos)
// Source: redam.gov.co — delinquent child support payer registry
// As of 2025, REDAM consultation requires Carpeta Ciudadana Digital (GOV.CO auth).
// The old direct form endpoint no longer works (returns Angular SPA shell).
const { validateCedula, safeFetch, CO_HEADERS } = require("./co-utils");

module.exports = {
  name: "co-redam",
  profileTypes: ["cedula"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const cedula = validateCedula(profile.value);
    if (!cedula) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "REDAM: Invalid cédula format",
        description: `The value "${profile.value}" is not a valid Colombian cédula.`,
        rawData: { input: profile.value },
      });
      return findings;
    }

    // REDAM now requires GOV.CO Carpeta Ciudadana Digital authentication
    // The old direct POST endpoint returns the Angular SPA shell, not data
    findings.push({
      category: "exposure",
      severity: "info",
      title: "REDAM: Authentication required",
      description: [
        `REDAM (delinquent child support registry) now requires GOV.CO Carpeta Ciudadana Digital login.`,
        `This is one of the most impactful registries — being listed blocks bank transactions, public employment, and passport issuance.`,
        `Check for CC: ${cedula} using the link below.`,
      ].join("\n"),
      sourceUrl: "https://www.redam.gov.co/",
      rawData: { searched: cedula, reason: "requires_gov_co_auth" },
      remediation: [
        "Visit https://www.redam.gov.co/ and use Carpeta Ciudadana Digital to check status.",
        "Being listed in REDAM blocks: bank transactions, passport issuance, public employment, and notarial acts.",
        "To resolve: pay outstanding child support obligations through the family court.",
      ].join("\n"),
    });

    return findings;
  },
};
