// Colombian OSINT: Policía Nacional — Criminal background check
// Source: policia.gov.co — antecedentes judiciales
// Access: reCAPTCHA protected — attempts direct query, falls back to info stub
const { validateCedula, safeFetch, CO_HEADERS } = require("./co-utils");

module.exports = {
  name: "co-policia",
  profileTypes: ["cedula"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const cedula = validateCedula(profile.value);
    if (!cedula) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Policía: Invalid cédula format",
        description: `The value "${profile.value}" is not a valid Colombian cédula.`,
        rawData: { input: profile.value },
      });
      return findings;
    }

    const release = await rateLimiter.acquire();
    try {
      // Try the direct API endpoint
      const url = "https://antecedentes.policia.gov.co:7005/WebJudworker/consulta";
      const res = await safeFetch(url, {
        method: "POST",
        headers: {
          ...CO_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://antecedentes.policia.gov.co:7005",
          Referer: "https://antecedentes.policia.gov.co:7005/WebJudworker/",
        },
        body: `tipoDocumento=CC&numeroDocumento=${cedula}`,
      }, 20000);

      if (res.ok && typeof res.body === "string") {
        const html = res.body.toLowerCase();
        const hasRecords = html.includes("registra anotaciones") ||
          html.includes("medida de aseguramiento") ||
          html.includes("orden de captura");
        const isClean = html.includes("no tiene asuntos pendientes") ||
          html.includes("no registra");

        if (hasRecords) {
          findings.push({
            category: "exposure",
            severity: "critical",
            title: "Policía: CRIMINAL RECORDS FOUND",
            description: [
              `CC: ${cedula} has criminal records or pending matters with the Policía Nacional.`,
              `This may include arrest warrants, security measures, or criminal annotations.`,
              `This is a critical finding — verify details at the Policía Nacional website.`,
            ].join("\n"),
            sourceUrl: "https://antecedentes.policia.gov.co:7005/WebJudworker/",
            rawData: { searched: cedula, hasRecords: true },
            remediation: "Criminal records are managed by the judicial system. Consult a criminal defense attorney. Check official status at antecedentes.policia.gov.co",
          });
        } else if (isClean) {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "Policía: No criminal records",
            description: `CC: ${cedula} has no pending criminal matters with the Policía Nacional. Clean judicial background.`,
            sourceUrl: "https://antecedentes.policia.gov.co:7005/WebJudworker/",
            rawData: { searched: cedula, clean: true },
          });
        } else {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "Policía: Manual verification required",
            description: `Response from Policía Nacional could not be parsed automatically. Check criminal background for CC: ${cedula} manually.`,
            sourceUrl: "https://antecedentes.policia.gov.co:7005/WebJudworker/",
            rawData: { searched: cedula },
            remediation: "Visit https://antecedentes.policia.gov.co:7005/WebJudworker/ — enter cédula + complete CAPTCHA.",
          });
        }
      } else {
        // CAPTCHA blocked or service unavailable
        findings.push({
          category: "exposure",
          severity: "info",
          title: "Policía: Manual verification required",
          description: `The Policía Nacional website uses reCAPTCHA. Check criminal background for CC: ${cedula} manually.\nThis is one of the most important checks — criminal records directly affect employment and travel.`,
          sourceUrl: "https://antecedentes.policia.gov.co:7005/WebJudworker/",
          rawData: { error: res.error || `HTTP ${res.status}`, searched: cedula },
          remediation: "Visit https://antecedentes.policia.gov.co:7005/WebJudworker/ — enter cédula + complete CAPTCHA to check for criminal records, arrest warrants, and pending matters.",
        });
      }
    } catch (err) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Policía: Lookup error",
        description: `Error querying Policía Nacional: ${err.message}`,
        rawData: { error: err.message },
      });
    } finally {
      release();
    }

    return findings;
  },
};
