// Colombian OSINT: Contraloría General de la República — Fiscal responsibility
// Source: contraloria.gov.co — boletín de responsables fiscales
// Access: reCAPTCHA protected — provides info stub with manual link
const { validateCedula, safeFetch, CO_HEADERS } = require("./co-utils");

module.exports = {
  name: "co-contraloria",
  profileTypes: ["cedula"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const cedula = validateCedula(profile.value);
    if (!cedula) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Contraloría: Invalid cédula format",
        description: `The value "${profile.value}" is not a valid Colombian cédula.`,
        rawData: { input: profile.value },
      });
      return findings;
    }

    const release = await rateLimiter.acquire();
    try {
      // Try the SIREL API endpoint (sometimes accessible without captcha)
      const url = "https://www.contraloria.gov.co/web/sirel/certificado";
      const res = await safeFetch(url, {
        method: "POST",
        headers: {
          ...CO_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://www.contraloria.gov.co",
          Referer: "https://www.contraloria.gov.co/web/sirel/certificado",
        },
        body: `tipoDocumento=CC&numeroDocumento=${cedula}`,
      });

      if (res.ok && typeof res.body === "string") {
        const html = res.body.toLowerCase();
        const isReported = html.includes("responsable fiscal") &&
          !html.includes("no aparece reportado") &&
          !html.includes("no se encuentra");

        if (isReported) {
          findings.push({
            category: "exposure",
            severity: "critical",
            title: "Contraloría: FISCAL RESPONSIBILITY REPORTED",
            description: [
              `CC: ${cedula} appears in the Contraloría's Boletín de Responsables Fiscales.`,
              `This person has been found fiscally responsible — meaning they owe money to the Colombian state due to mismanagement of public funds.`,
              `This blocks public employment and government contracting.`,
            ].join("\n"),
            sourceUrl: "https://www.contraloria.gov.co/web/sirel/certificado",
            rawData: { searched: cedula, reported: true },
            remediation: "Being listed as 'responsable fiscal' blocks public employment. Consult a public finance attorney. Resolution requires paying the fiscal liability.",
          });
        } else if (html.includes("no aparece reportado") || html.includes("no se encuentra")) {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "Contraloría: Not reported",
            description: `CC: ${cedula} does NOT appear in the Boletín de Responsables Fiscales. Clean fiscal record.`,
            sourceUrl: "https://www.contraloria.gov.co/web/sirel/certificado",
            rawData: { searched: cedula, reported: false },
          });
        } else {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "Contraloría: Manual verification required",
            description: `The Contraloría website uses CAPTCHA protection. Check fiscal responsibility for CC: ${cedula} manually.`,
            sourceUrl: "https://www.contraloria.gov.co/web/sirel/certificado",
            rawData: { searched: cedula },
            remediation: "Visit https://www.contraloria.gov.co/web/sirel/certificado — enter cédula to check fiscal responsibility status.",
          });
        }
      } else {
        findings.push({
          category: "exposure",
          severity: "info",
          title: "Contraloría: Manual verification required",
          description: `Automatic query failed (CAPTCHA protected). Check fiscal responsibility for CC: ${cedula} at contraloria.gov.co`,
          sourceUrl: "https://www.contraloria.gov.co/web/sirel/certificado",
          rawData: { error: res.error || `HTTP ${res.status}`, searched: cedula },
          remediation: "Visit https://www.contraloria.gov.co/web/sirel/certificado — enter cédula + complete CAPTCHA.",
        });
      }
    } catch (err) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Contraloría: Lookup error",
        description: `Error querying Contraloría: ${err.message}`,
        rawData: { error: err.message },
      });
    } finally {
      release();
    }

    return findings;
  },
};
