// Colombian OSINT: Contraloría General de la República — Fiscal responsibility
// Source: cfiscal.contraloria.gov.co — Boletín de Responsables Fiscales
// Access: ASPX form with ViewState — NO reCAPTCHA. GET page → extract hidden fields → POST.
const { validateCedula, safeFetch, CO_HEADERS, extractAspxFields } = require("./co-utils");

const FORM_URL = "https://cfiscal.contraloria.gov.co/certificados/certificadopersonanatural.aspx";

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

    // Step 1: GET the form page to extract ViewState fields
    const release1 = await rateLimiter.acquire();
    let aspxFields = null;
    let sessionCookies = "";
    try {
      const pageRes = await safeFetch(FORM_URL, { method: "GET" });
      if (pageRes.ok && typeof pageRes.body === "string") {
        aspxFields = extractAspxFields(pageRes.body);
        sessionCookies = pageRes.cookies || "";
      }
    } catch (e) {
      // Continue, will fall back to manual
    } finally {
      release1();
    }

    if (!aspxFields || !aspxFields.__VIEWSTATE) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Contraloría: Could not load form",
        description: `Failed to load Contraloría form page. Check fiscal responsibility for CC: ${cedula} manually.`,
        sourceUrl: FORM_URL,
        rawData: { searched: cedula, reason: "viewstate_extraction_failed" },
        remediation: "Visit https://cfiscal.contraloria.gov.co/certificados/certificadopersonanatural.aspx — select CC, enter cédula, click Buscar.",
      });
      return findings;
    }

    // Step 2: POST the form with the cédula
    const release2 = await rateLimiter.acquire();
    try {
      const formData = new URLSearchParams();
      formData.append("__VIEWSTATE", aspxFields.__VIEWSTATE);
      if (aspxFields.__VIEWSTATEGENERATOR) formData.append("__VIEWSTATEGENERATOR", aspxFields.__VIEWSTATEGENERATOR);
      if (aspxFields.__EVENTVALIDATION) formData.append("__EVENTVALIDATION", aspxFields.__EVENTVALIDATION);
      formData.append("ctl00$MainContent$ddlTipoDocumento", "CC");
      formData.append("ctl00$MainContent$txtNumeroDocumento", cedula);
      formData.append("ctl00$MainContent$btnBuscar", "Buscar");

      const res = await safeFetch(FORM_URL, {
        method: "POST",
        headers: {
          ...CO_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: FORM_URL,
          Origin: "https://cfiscal.contraloria.gov.co",
          Cookie: sessionCookies,
        },
        body: formData.toString(),
      }, 20000);

      if (res.ok && typeof res.body === "string") {
        const html = res.body;
        const lower = html.toLowerCase();

        // Check for positive result (person IS listed as fiscally responsible)
        const isReported = (
          lower.includes("responsable fiscal") ||
          lower.includes("boletín de responsables") ||
          lower.includes("se encuentra reportado")
        ) && !lower.includes("no aparece reportado") && !lower.includes("no se encuentra reportado");

        // Check for clean result
        const isClean = lower.includes("no aparece reportado") ||
          lower.includes("no se encuentra reportado") ||
          lower.includes("no registra");

        if (isReported) {
          // Try to extract details
          const amountMatch = html.match(/(?:valor|monto|cuant[ií]a)[^$]*\$[\s]*([0-9.,]+)/i);
          const entityMatch = html.match(/(?:entidad|instituci[oó]n)[^:]*:\s*([^<\n]+)/i);

          findings.push({
            category: "exposure",
            severity: "critical",
            title: "Contraloría: FISCAL RESPONSIBILITY REPORTED",
            description: [
              `CC: ${cedula} appears in the Contraloría's Boletín de Responsables Fiscales.`,
              `This person has been found fiscally responsible — they owe money to the Colombian state due to mismanagement of public funds.`,
              `This blocks public employment and government contracting.`,
              amountMatch ? `Amount: $${amountMatch[1]} COP` : null,
              entityMatch ? `Entity: ${entityMatch[1].trim()}` : null,
            ].filter(Boolean).join("\n"),
            sourceUrl: FORM_URL,
            rawData: {
              searched: cedula,
              reported: true,
              amount: amountMatch ? amountMatch[1] : null,
              entity: entityMatch ? entityMatch[1].trim() : null,
            },
            remediation: "Being listed as 'responsable fiscal' blocks public employment and government contracting. Consult a public finance attorney. Resolution requires paying the fiscal liability.",
          });
        } else if (isClean) {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "Contraloría: Not reported",
            description: `CC: ${cedula} does NOT appear in the Boletín de Responsables Fiscales. Clean fiscal record.`,
            sourceUrl: FORM_URL,
            rawData: { searched: cedula, reported: false },
          });
        } else {
          // Response didn't match expected patterns
          findings.push({
            category: "exposure",
            severity: "info",
            title: "Contraloría: Response unclear",
            description: `Received response but could not determine fiscal responsibility status for CC: ${cedula}. Verify manually.`,
            sourceUrl: FORM_URL,
            rawData: { searched: cedula, responseSnippet: html.substring(0, 500) },
            remediation: "Visit https://cfiscal.contraloria.gov.co/certificados/certificadopersonanatural.aspx and search manually.",
          });
        }
      } else {
        findings.push({
          category: "exposure",
          severity: "info",
          title: "Contraloría: Form submission failed",
          description: `Form submission returned HTTP ${res.status}. Check fiscal responsibility for CC: ${cedula} manually.`,
          sourceUrl: FORM_URL,
          rawData: { error: res.error || `HTTP ${res.status}`, searched: cedula },
          remediation: "Visit https://cfiscal.contraloria.gov.co/certificados/certificadopersonanatural.aspx — select CC, enter cédula, click Buscar.",
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
      release2();
    }

    return findings;
  },
};
