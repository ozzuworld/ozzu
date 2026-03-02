// Colombian OSINT: DIAN RUT (Registro Único Tributario) — Tax registration lookup
// Source: muisca.dian.gov.co — JSF form-based, no captcha but needs ViewState handling
const { validateCedula, validateNIT, safeFetch, CO_HEADERS } = require("./co-utils");

module.exports = {
  name: "co-dian",
  profileTypes: ["cedula", "nit"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const value = profile.value;
    const isCedula = profile.profile_type === "cedula";
    const cleanValue = isCedula ? (validateCedula(value) || value) : (validateNIT(value) || value);

    // Step 1: Get JSF ViewState from the form page
    const release1 = await rateLimiter.acquire();
    let viewState = null;
    let cookies = "";
    try {
      const pageRes = await safeFetch(
        "https://muisca.dian.gov.co/WebRutMuisca/DefConsultaEstadoRUT.faces",
        { method: "GET", redirect: "follow" }
      );
      if (pageRes.ok && typeof pageRes.body === "string") {
        const vsMatch = pageRes.body.match(/javax\.faces\.ViewState[^>]*value="([^"]+)"/);
        if (vsMatch) viewState = vsMatch[1];
        // Extract JSESSIONID if present in response
        const cookieMatch = pageRes.body.match(/JSESSIONID=([^;]+)/);
        if (cookieMatch) cookies = `JSESSIONID=${cookieMatch[1]}`;
      }
    } catch (e) {
      // Continue with fallback
    } finally {
      release1();
    }

    // Step 2: Submit the form with cédula/NIT
    const release2 = await rateLimiter.acquire();
    try {
      if (viewState) {
        const formData = new URLSearchParams();
        formData.append("javax.faces.ViewState", viewState);
        formData.append("vistaConsultaEstadoRUT:formConsultaEstadoRUT:numNit", cleanValue);
        formData.append("vistaConsultaEstadoRUT:formConsultaEstadoRUT:btnBuscar", "Buscar");
        formData.append("vistaConsultaEstadoRUT:formConsultaEstadoRUT_SUBMIT", "1");

        const res = await safeFetch(
          "https://muisca.dian.gov.co/WebRutMuisca/DefConsultaEstadoRUT.faces",
          {
            method: "POST",
            headers: {
              ...CO_HEADERS,
              "Content-Type": "application/x-www-form-urlencoded",
              Referer: "https://muisca.dian.gov.co/WebRutMuisca/DefConsultaEstadoRUT.faces",
              Cookie: cookies,
            },
            body: formData.toString(),
          }
        );

        if (res.ok && typeof res.body === "string") {
          const html = res.body;
          const rutData = parseDianResponse(html);

          if (rutData.found) {
            findings.push({
              category: "exposure",
              severity: rutData.status === "ACTIVO" ? "low" : "medium",
              title: `DIAN RUT: ${rutData.status || "Found"} — ${rutData.name || cleanValue}`,
              description: [
                rutData.name ? `Nombre/Razón Social: ${rutData.name}` : null,
                `NIT/CC: ${cleanValue}`,
                rutData.dv ? `Dígito de verificación: ${rutData.dv}` : null,
                rutData.status ? `Estado: ${rutData.status}` : null,
                rutData.type ? `Tipo: ${rutData.type}` : null,
                rutData.mainActivity ? `Actividad principal: ${rutData.mainActivity}` : null,
                rutData.address ? `Dirección: ${rutData.address}` : null,
                rutData.city ? `Ciudad: ${rutData.city}` : null,
              ].filter(Boolean).join("\n"),
              sourceUrl: "https://muisca.dian.gov.co/WebRutMuisca/DefConsultaEstadoRUT.faces",
              rawData: rutData,
              remediation: rutData.status !== "ACTIVO"
                ? "RUT appears inactive or cancelled. If this is unexpected, contact DIAN."
                : "Active RUT registration. Verify tax obligations are up to date.",
            });
          } else {
            findings.push({
              category: "exposure",
              severity: "info",
              title: "DIAN RUT: No registration found",
              description: `No RUT registration found for ${isCedula ? "CC" : "NIT"}: ${cleanValue}`,
              sourceUrl: "https://muisca.dian.gov.co/WebRutMuisca/DefConsultaEstadoRUT.faces",
              rawData: { searched: cleanValue, type: profile.profile_type },
            });
          }
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
      } else {
        // ViewState extraction failed — provide manual link
        findings.push({
          category: "exposure",
          severity: "info",
          title: "DIAN RUT: Manual lookup required",
          description: `Could not establish session with DIAN MUISCA. Search manually with ${isCedula ? "CC" : "NIT"}: ${cleanValue}`,
          sourceUrl: "https://muisca.dian.gov.co/WebRutMuisca/DefConsultaEstadoRUT.faces",
          rawData: { searched: cleanValue },
          remediation: "Visit https://muisca.dian.gov.co/WebRutMuisca/DefConsultaEstadoRUT.faces to check RUT status.",
        });
      }
    } catch (err) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "DIAN RUT: Lookup error",
        description: `Error querying DIAN: ${err.message}`,
        rawData: { error: err.message },
      });
    } finally {
      release2();
    }

    return findings;
  },
};

function parseDianResponse(html) {
  const result = { found: false };

  // Check if results are present
  if (html.includes("No se encontr") || html.includes("no encontr") || !html.includes("Estado")) {
    return result;
  }

  result.found = true;

  // Extract fields from the HTML response
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
