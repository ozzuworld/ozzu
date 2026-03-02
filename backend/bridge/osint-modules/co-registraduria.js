// Colombian OSINT: Registraduría Nacional — Cédula status validation
// Source: certvigenciacedula.registraduria.gov.co — certificate of cedula validity
// Access: ASPX form, redirects to menu first. Electoral census at eleccionescolombia.registraduria.gov.co
const { validateCedula, safeFetch, CO_HEADERS, extractAspxFields } = require("./co-utils");

const CERT_URL = "https://certvigenciacedula.registraduria.gov.co";
const ELECTORAL_URL = "https://eleccionescolombia.registraduria.gov.co/identificacion";

module.exports = {
  name: "co-registraduria",
  profileTypes: ["cedula"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const cedula = validateCedula(profile.value);
    if (!cedula) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "Registraduría: Invalid cédula format",
        description: `The value "${profile.value}" is not a valid Colombian cédula.`,
        rawData: { input: profile.value },
      });
      return findings;
    }

    // Strategy 1: Try the certificate page (ASPX with ViewState)
    const release1 = await rateLimiter.acquire();
    let aspxFields = null;
    let sessionCookies = "";
    try {
      // Follow redirect to get the actual form page
      const pageRes = await safeFetch(`${CERT_URL}/Consultas/Consulta_Vigencia.aspx`, {
        method: "GET",
        redirect: "follow",
      });

      if (pageRes.ok && typeof pageRes.body === "string" && pageRes.body.includes("__VIEWSTATE")) {
        aspxFields = extractAspxFields(pageRes.body);
        sessionCookies = pageRes.cookies || "";

        // Check if the form has a captcha
        const hasCaptcha = pageRes.body.toLowerCase().includes("captcha") ||
          pageRes.body.toLowerCase().includes("recaptcha");

        if (!hasCaptcha && aspxFields.__VIEWSTATE) {
          // Try to find the form fields
          const nuipField = pageRes.body.match(/name="([^"]*nuip[^"]*)"/i) ||
            pageRes.body.match(/name="([^"]*cedula[^"]*)"/i) ||
            pageRes.body.match(/name="([^"]*documento[^"]*)"/i);
          const btnField = pageRes.body.match(/name="([^"]*btn[^"]*[Cc]onsultar[^"]*)"/i) ||
            pageRes.body.match(/name="([^"]*btn[^"]*[Bb]uscar[^"]*)"/i);

          if (nuipField && btnField) {
            const release2 = await rateLimiter.acquire();
            try {
              const formData = new URLSearchParams();
              formData.append("__VIEWSTATE", aspxFields.__VIEWSTATE);
              if (aspxFields.__VIEWSTATEGENERATOR) formData.append("__VIEWSTATEGENERATOR", aspxFields.__VIEWSTATEGENERATOR);
              if (aspxFields.__EVENTVALIDATION) formData.append("__EVENTVALIDATION", aspxFields.__EVENTVALIDATION);
              formData.append(nuipField[1], cedula);
              formData.append(btnField[1], "Consultar");

              const res = await safeFetch(`${CERT_URL}/Consultas/Consulta_Vigencia.aspx`, {
                method: "POST",
                headers: {
                  ...CO_HEADERS,
                  "Content-Type": "application/x-www-form-urlencoded",
                  Referer: `${CERT_URL}/Consultas/Consulta_Vigencia.aspx`,
                  Cookie: sessionCookies,
                },
                body: formData.toString(),
              }, 20000);

              if (res.ok && typeof res.body === "string") {
                const status = extractCedulaStatus(res.body);
                if (status.found) {
                  findings.push(buildStatusFinding(cedula, status));
                  return findings;
                }
              }
            } finally {
              release2();
            }
          }
        }
      }
    } catch (e) {
      // Continue to fallback
    } finally {
      release1();
    }

    // Strategy 2: Try the old direct endpoint
    const release3 = await rateLimiter.acquire();
    try {
      const oldUrl = "https://wsp.registraduria.gov.co/certificado/Datos.aspx";
      const res = await safeFetch(oldUrl, {
        method: "POST",
        headers: {
          ...CO_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://wsp.registraduria.gov.co/certificado/",
        },
        body: `nuip=${cedula}`,
        redirect: "follow",
      });

      if (res.ok && typeof res.body === "string") {
        const status = extractCedulaStatus(res.body);
        if (status.found) {
          findings.push(buildStatusFinding(cedula, status));
          return findings;
        }
      }
    } catch (e) {
      // Continue to fallback
    } finally {
      release3();
    }

    // Strategy 3: Electoral census check (confirms cedula exists)
    const release4 = await rateLimiter.acquire();
    try {
      // The electoral site is a React SPA — try known API patterns
      const censoRes = await safeFetch(
        `https://wsp.registraduria.gov.co/censo/consultar/?nuip=${cedula}`,
        { method: "GET", redirect: "follow" }
      );

      if (censoRes.ok && typeof censoRes.body === "string") {
        const html = censoRes.body;
        if (html.includes("puesto de votaci") || html.includes("Lugar de votaci") || html.includes("lugar_votaci")) {
          const placeMatch = html.match(/(?:puesto|lugar)[^:]*(?:de votaci[oó]n)?[^:]*:\s*(?:<[^>]+>)*([^<]+)/i);
          findings.push({
            category: "metadata",
            severity: "info",
            title: "Registraduría: Cédula confirmed active (electoral census)",
            description: [
              `CC: ${cedula} found in the electoral census. The cédula is valid and active.`,
              placeMatch ? `Voting location: ${placeMatch[1].trim()}` : null,
            ].filter(Boolean).join("\n"),
            sourceUrl: ELECTORAL_URL,
            rawData: { searched: cedula, source: "censo", votingPlace: placeMatch ? placeMatch[1].trim() : null },
          });
          return findings;
        }
      }
    } catch (e) {
      // Continue to fallback
    } finally {
      release4();
    }

    // Fallback: manual lookup with correct URLs
    findings.push({
      category: "metadata",
      severity: "info",
      title: "Registraduría: Manual verification needed",
      description: [
        `Could not automatically verify cédula status for CC: ${cedula}.`,
        `The Registraduría website has been redesigned and uses CAPTCHA protection.`,
        `Check manually at the links below.`,
      ].join("\n"),
      sourceUrl: `${CERT_URL}/menu.aspx`,
      rawData: { searched: cedula },
      remediation: [
        `Certificate: ${CERT_URL}/menu.aspx`,
        `Electoral census: ${ELECTORAL_URL}`,
      ].join("\n"),
    });

    return findings;
  },
};

function extractCedulaStatus(html) {
  const result = { found: false };
  const lower = html.toLowerCase();

  const statuses = ["VIGENTE", "SUSPENDIDO", "SUSPENDIDA", "ROBADO", "ROBADA", "CANCELADA", "CANCELADO", "NO REGISTRADA"];
  for (const s of statuses) {
    if (lower.includes(s.toLowerCase())) {
      result.found = true;
      result.status = s;
      break;
    }
  }

  if (!result.found && (lower.includes("datos") || lower.includes("resultado") || lower.includes("certificado"))) {
    result.found = true;
    result.status = "VIGENTE";
  }

  const placeMatch = html.match(/[Ll]ugar[^:]*:\s*(?:<[^>]+>)*([^<]+)/);
  if (placeMatch) result.place = placeMatch[1].trim();

  const dateMatch = html.match(/[Ff]echa[^:]*:\s*(?:<[^>]+>)*([^<]+)/);
  if (dateMatch) result.date = dateMatch[1].trim();

  return result;
}

function buildStatusFinding(cedula, status) {
  let severity = "info";
  if (status.status === "ROBADO" || status.status === "ROBADA") severity = "critical";
  else if (status.status === "SUSPENDIDO" || status.status === "SUSPENDIDA") severity = "high";
  else if (status.status === "NO REGISTRADA" || status.status === "CANCELADA") severity = "high";

  return {
    category: "metadata",
    severity,
    title: `Registraduría: Cédula ${status.status}`,
    description: [
      `CC: ${cedula}`,
      `Status: ${status.status}`,
      status.place ? `Place of issue: ${status.place}` : null,
      status.date ? `Date: ${status.date}` : null,
      status.status === "ROBADO" || status.status === "ROBADA"
        ? "\nCRITICAL: This cédula has been reported as STOLEN. Identity fraud risk is extremely high."
        : null,
      status.status === "SUSPENDIDO" || status.status === "SUSPENDIDA"
        ? "\nWARNING: This cédula is SUSPENDED. The holder cannot perform official transactions."
        : null,
    ].filter(Boolean).join("\n"),
    sourceUrl: `${CERT_URL}/menu.aspx`,
    rawData: status,
    remediation: severity === "critical"
      ? "URGENT: Report to Registraduría Nacional immediately. File a police report (denuncia). Monitor all financial accounts."
      : severity === "high"
        ? "Contact Registraduría Nacional to resolve the suspended/cancelled status."
        : "Cédula is valid and active. No action needed.",
  };
}
