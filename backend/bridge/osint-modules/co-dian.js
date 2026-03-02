// Colombian OSINT: DIAN RUT (Registro Único Tributario) — Tax registration lookup
// Source: muisca.dian.gov.co — JSF form with ViewState + reCAPTCHA
// Note: DIAN added reCAPTCHA (verificarCaptcha) — direct submission is blocked.
// This module extracts the JSESSIONID and ViewState but cannot bypass captcha.
// Falls back to datos.gov.co RUT datasets when available.
const { validateCedula, validateNIT, safeFetch, CO_HEADERS } = require("./co-utils");

// datos.gov.co has some RUT-related open datasets
const DIAN_OPEN_DATA = "https://www.datos.gov.co/resource/f9g5-2wvi.json"; // Grandes Contribuyentes

module.exports = {
  name: "co-dian",
  profileTypes: ["cedula", "nit"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const value = profile.value;
    const isCedula = profile.profile_type === "cedula";
    const cleanValue = isCedula ? (validateCedula(value) || value) : (validateNIT(value) || value);

    // Strategy 1: Check open datasets on datos.gov.co (free, no captcha)
    const release1 = await rateLimiter.acquire();
    try {
      // Check Grandes Contribuyentes (large taxpayers)
      const query = isCedula
        ? `$where=nit='${cleanValue}' OR numero_documento='${cleanValue}'`
        : `$where=nit='${cleanValue}'`;
      const url = `${DIAN_OPEN_DATA}?${query}&$limit=10`;
      const res = await safeFetch(url, {
        headers: { Accept: "application/json" },
      });

      if (res.ok && Array.isArray(res.body) && res.body.length > 0) {
        const record = res.body[0];
        findings.push({
          category: "exposure",
          severity: "medium",
          title: `DIAN: Large taxpayer — ${record.razon_social || record.nombre || cleanValue}`,
          description: [
            record.razon_social || record.nombre ? `Name: ${record.razon_social || record.nombre}` : null,
            `NIT: ${record.nit || cleanValue}`,
            record.actividad_economica ? `Economic activity: ${record.actividad_economica}` : null,
            record.regimen ? `Tax regime: ${record.regimen}` : null,
            record.direccion ? `Address: ${record.direccion}` : null,
            record.municipio ? `City: ${record.municipio}` : null,
            record.departamento ? `Department: ${record.departamento}` : null,
          ].filter(Boolean).join("\n"),
          sourceUrl: "https://muisca.dian.gov.co/WebRutMuisca/DefConsultaEstadoRUT.faces",
          rawData: record,
          remediation: "Large taxpayer registration is public. Verify tax obligations are current.",
        });
        return findings;
      }
    } catch (e) {
      // Continue to next strategy
    } finally {
      release1();
    }

    // Strategy 2: Try the MUISCA JSF form (usually blocked by captcha)
    const release2 = await rateLimiter.acquire();
    let viewState = null;
    let sessionCookies = "";
    try {
      const pageRes = await safeFetch(
        "https://muisca.dian.gov.co/WebRutMuisca/DefConsultaEstadoRUT.faces",
        { method: "GET", redirect: "follow" }
      );
      if (pageRes.ok && typeof pageRes.body === "string") {
        const vsMatch = pageRes.body.match(/javax\.faces\.ViewState[^>]*value="([^"]+)"/);
        if (vsMatch) viewState = vsMatch[1];
        // Extract JSESSIONID from the action URL or cookies
        const jidMatch = pageRes.body.match(/jsessionid=([^"&]+)/i);
        if (jidMatch) sessionCookies = `JSESSIONID=${jidMatch[1]}`;
        if (pageRes.cookies) sessionCookies = pageRes.cookies;
      }
    } catch (e) {
      // Continue with fallback
    } finally {
      release2();
    }

    const release3 = await rateLimiter.acquire();
    try {
      if (viewState) {
        const formData = new URLSearchParams();
        formData.append("javax.faces.ViewState", viewState);
        formData.append("vistaConsultaEstadoRUT:formConsultaEstadoRUT:numNit", cleanValue);
        formData.append("vistaConsultaEstadoRUT:formConsultaEstadoRUT:btnBuscar.x", "1");
        formData.append("vistaConsultaEstadoRUT:formConsultaEstadoRUT:btnBuscar.y", "1");
        formData.append("vistaConsultaEstadoRUT:formConsultaEstadoRUT_SUBMIT", "1");

        const actionUrl = sessionCookies.includes("JSESSIONID")
          ? `https://muisca.dian.gov.co/WebRutMuisca/DefConsultaEstadoRUT.faces;${sessionCookies.replace("; ", ";")}`
          : "https://muisca.dian.gov.co/WebRutMuisca/DefConsultaEstadoRUT.faces";

        const res = await safeFetch(actionUrl, {
          method: "POST",
          headers: {
            ...CO_HEADERS,
            "Content-Type": "application/x-www-form-urlencoded",
            Referer: "https://muisca.dian.gov.co/WebRutMuisca/DefConsultaEstadoRUT.faces",
            Cookie: sessionCookies,
          },
          body: formData.toString(),
        });

        if (res.ok && typeof res.body === "string") {
          const html = res.body;
          const rutData = parseDianResponse(html);

          if (rutData.found) {
            findings.push({
              category: "exposure",
              severity: rutData.status === "ACTIVO" ? "low" : "medium",
              title: `DIAN RUT: ${rutData.status || "Found"} — ${rutData.name || cleanValue}`,
              description: [
                rutData.name ? `Name: ${rutData.name}` : null,
                `NIT/CC: ${cleanValue}`,
                rutData.dv ? `Verification digit: ${rutData.dv}` : null,
                rutData.status ? `Status: ${rutData.status}` : null,
                rutData.type ? `Type: ${rutData.type}` : null,
                rutData.mainActivity ? `Main activity: ${rutData.mainActivity}` : null,
                rutData.address ? `Address: ${rutData.address}` : null,
                rutData.city ? `City: ${rutData.city}` : null,
              ].filter(Boolean).join("\n"),
              sourceUrl: "https://muisca.dian.gov.co/WebRutMuisca/DefConsultaEstadoRUT.faces",
              rawData: rutData,
              remediation: rutData.status !== "ACTIVO"
                ? "RUT appears inactive or cancelled. Contact DIAN if unexpected."
                : "Active RUT registration. Verify tax obligations are current.",
            });
            return findings;
          }
        }
      }

      // Captcha blocked or no data — provide manual link
      findings.push({
        category: "exposure",
        severity: "info",
        title: "DIAN RUT: Captcha-protected",
        description: [
          `The DIAN MUISCA portal uses reCAPTCHA to protect RUT lookups.`,
          `Automated lookup not possible for ${isCedula ? "CC" : "NIT"}: ${cleanValue}`,
          `Search manually at the DIAN website.`,
        ].join("\n"),
        sourceUrl: "https://muisca.dian.gov.co/WebRutMuisca/DefConsultaEstadoRUT.faces",
        rawData: { searched: cleanValue, type: profile.profile_type, reason: "captcha" },
        remediation: "Visit https://muisca.dian.gov.co/WebRutMuisca/DefConsultaEstadoRUT.faces — enter NIT/CC and complete captcha.",
      });
    } catch (err) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "DIAN RUT: Lookup error",
        description: `Error querying DIAN: ${err.message}`,
        rawData: { error: err.message },
      });
    } finally {
      release3();
    }

    return findings;
  },
};

function parseDianResponse(html) {
  const result = { found: false };

  if (html.includes("No se encontr") || html.includes("no encontr") || html.includes("captcha") || html.includes("reCAPTCHA")) {
    return result;
  }

  // Check for results
  if (!html.includes("Estado") && !html.includes("Razón Social") && !html.includes("Nombre")) {
    return result;
  }

  result.found = true;

  const extract = (pattern) => {
    const m = html.match(pattern);
    return m ? m[1].replace(/<[^>]+>/g, "").trim() : null;
  };

  result.name = extract(/Raz[oó]n\s*Social[^:]*:\s*(?:<[^>]+>)*([^<]+)/) ||
                extract(/Nombre[^:]*:\s*(?:<[^>]+>)*([^<]+)/);
  result.status = extract(/Estado[^:]*:\s*(?:<[^>]+>)*([^<]+)/);
  result.dv = extract(/[Dd][ií]gito[^:]*:\s*(?:<[^>]+>)*(\d+)/);
  result.type = extract(/Tipo[^:]*:\s*(?:<[^>]+>)*([^<]+)/);
  result.mainActivity = extract(/[Aa]ctividad\s*[Pp]rincipal[^:]*:\s*(?:<[^>]+>)*([^<]+)/);
  result.address = extract(/[Dd]irecci[oó]n[^:]*:\s*(?:<[^>]+>)*([^<]+)/);
  result.city = extract(/[Cc]iudad[^:]*:\s*(?:<[^>]+>)*([^<]+)/) ||
                extract(/[Mm]unicipio[^:]*:\s*(?:<[^>]+>)*([^<]+)/);

  return result;
}
