// Colombian OSINT: REDAM (Registro de Deudores Alimentarios Morosos)
// Source: redam.gov.co — delinquent child support payer registry
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

    const release = await rateLimiter.acquire();
    try {
      // REDAM consultation
      const url = "https://www.redam.gov.co/consultaciudadano";
      const res = await safeFetch(url, {
        method: "POST",
        headers: {
          ...CO_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://www.redam.gov.co/",
        },
        body: `tipoDocumento=CC&numeroDocumento=${cedula}`,
      });

      if (res.ok && typeof res.body === "string") {
        const html = res.body;
        const isListed = html.toLowerCase().includes("registrado") && !html.toLowerCase().includes("no se encuentra") && !html.toLowerCase().includes("no registrado");

        if (isListed) {
          findings.push({
            category: "exposure",
            severity: "high",
            title: "REDAM: Listed as delinquent child support payer",
            description: `CC: ${cedula} appears in REDAM — the Colombian registry of delinquent child support payers. This is a serious legal and financial flag.`,
            sourceUrl: "https://www.redam.gov.co/",
            rawData: { searched: cedula, listed: true },
            remediation: "Contact the relevant family court to resolve outstanding child support obligations. Being listed in REDAM can affect bank transactions, public employment eligibility, and passport issuance.",
          });
        } else {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "REDAM: Not listed",
            description: `CC: ${cedula} is NOT listed in REDAM. No delinquent child support obligations found.`,
            sourceUrl: "https://www.redam.gov.co/",
            rawData: { searched: cedula, listed: false },
          });
        }
      } else {
        findings.push({
          category: "exposure",
          severity: "info",
          title: "REDAM: Manual lookup required",
          description: `Could not automatically query REDAM. Check manually at redam.gov.co with CC: ${cedula}`,
          sourceUrl: "https://www.redam.gov.co/",
          rawData: { error: res.error || `HTTP ${res.status}`, searched: cedula },
          remediation: "Visit https://www.redam.gov.co/ and search by cédula.",
        });
      }
    } catch (err) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "REDAM: Lookup error",
        description: `Error querying REDAM: ${err.message}`,
        rawData: { error: err.message },
      });
    } finally {
      release();
    }

    return findings;
  },
};
