// Colombian OSINT: Registraduría Nacional — Cédula status validation
// Source: wsp.registraduria.gov.co — check if a cédula is valid, suspended, or stolen
const { validateCedula, safeFetch, CO_HEADERS } = require("./co-utils");

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

    const release = await rateLimiter.acquire();
    try {
      // Registraduría cédula consultation
      const url = "https://wsp.registraduria.gov.co/certificado/Datos.aspx";
      const res = await safeFetch(url, {
        method: "POST",
        headers: {
          ...CO_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://wsp.registraduria.gov.co/certificado/",
        },
        body: `nuip=${cedula}`,
      });

      if (res.ok && typeof res.body === "string") {
        const html = res.body;
        const status = extractCedulaStatus(html);

        if (status.found) {
          let severity = "info";
          if (status.status === "ROBADO" || status.status === "ROBADA") severity = "critical";
          else if (status.status === "SUSPENDIDO" || status.status === "SUSPENDIDA") severity = "high";
          else if (status.status === "NO REGISTRADA" || status.status === "CANCELADA") severity = "high";
          else if (status.status === "VIGENTE") severity = "info";

          findings.push({
            category: "metadata",
            severity,
            title: `Registraduría: Cédula ${status.status}`,
            description: [
              `CC: ${cedula}`,
              `Estado: ${status.status}`,
              status.place ? `Lugar de expedición: ${status.place}` : null,
              status.date ? `Fecha: ${status.date}` : null,
              status.status === "ROBADO" || status.status === "ROBADA"
                ? "\n⚠️ CRITICAL: This cédula has been reported as STOLEN. Identity fraud risk is extremely high."
                : null,
              status.status === "SUSPENDIDO" || status.status === "SUSPENDIDA"
                ? "\n⚠️ WARNING: This cédula is SUSPENDED. The holder cannot perform official transactions."
                : null,
            ].filter(Boolean).join("\n"),
            sourceUrl: "https://wsp.registraduria.gov.co/certificado/",
            rawData: status,
            remediation: severity === "critical"
              ? "URGENT: Report to Registraduría Nacional immediately. File a police report (denuncia). Monitor all financial accounts for unauthorized activity."
              : severity === "high"
                ? "Contact Registraduría Nacional to resolve the suspended/cancelled status."
                : "Cédula is valid and active. No action needed.",
          });
        } else {
          findings.push({
            category: "metadata",
            severity: "info",
            title: "Registraduría: Manual lookup required",
            description: `Could not parse Registraduría response. Check status at wsp.registraduria.gov.co with CC: ${cedula}`,
            sourceUrl: "https://wsp.registraduria.gov.co/certificado/",
            rawData: { searched: cedula },
            remediation: "Visit https://wsp.registraduria.gov.co/certificado/ to check your cédula status.",
          });
        }
      } else {
        // Try the voting place endpoint as a fallback to at least confirm the cédula exists
        const release2 = await rateLimiter.acquire();
        try {
          const censoUrl = `https://wsp.registraduria.gov.co/censo/consultar/?nuip=${cedula}`;
          const censoRes = await safeFetch(censoUrl, { method: "GET" });

          if (censoRes.ok && typeof censoRes.body === "string") {
            const html = censoRes.body;
            if (html.includes("puesto de votaci") || html.includes("Lugar de votaci")) {
              findings.push({
                category: "metadata",
                severity: "info",
                title: "Registraduría: Cédula confirmed active (via censo)",
                description: `CC: ${cedula} found in the electoral census. The cédula exists and is active.`,
                sourceUrl: censoUrl,
                rawData: { searched: cedula, source: "censo" },
              });
            } else {
              findings.push({
                category: "metadata",
                severity: "info",
                title: "Registraduría: Manual lookup required",
                description: `Could not confirm cédula status automatically. Check at registraduria.gov.co with CC: ${cedula}`,
                sourceUrl: "https://wsp.registraduria.gov.co/certificado/",
                rawData: { searched: cedula },
                remediation: "Visit https://wsp.registraduria.gov.co/certificado/ to check your cédula status.",
              });
            }
          }
        } catch (e) {
          // Ignore fallback errors
        } finally {
          release2();
        }

        if (findings.length === 0) {
          findings.push({
            category: "metadata",
            severity: "info",
            title: "Registraduría: Manual lookup required",
            description: `Could not query Registraduría. Check manually with CC: ${cedula}`,
            sourceUrl: "https://wsp.registraduria.gov.co/certificado/",
            rawData: { error: res.error || `HTTP ${res.status}` },
            remediation: "Visit https://wsp.registraduria.gov.co/certificado/ to check your cédula status.",
          });
        }
      }
    } catch (err) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "Registraduría: Lookup error",
        description: `Error querying Registraduría: ${err.message}`,
        rawData: { error: err.message },
      });
    } finally {
      release();
    }

    return findings;
  },
};

function extractCedulaStatus(html) {
  const result = { found: false };
  const lower = html.toLowerCase();

  // Check for known statuses
  const statuses = ["VIGENTE", "SUSPENDIDO", "SUSPENDIDA", "ROBADO", "ROBADA", "CANCELADA", "CANCELADO", "NO REGISTRADA"];
  for (const s of statuses) {
    if (lower.includes(s.toLowerCase())) {
      result.found = true;
      result.status = s;
      break;
    }
  }

  if (!result.found && (lower.includes("datos") || lower.includes("resultado"))) {
    result.found = true;
    result.status = "VIGENTE"; // Default if page loaded with results but no explicit status
  }

  // Extract place of expedition
  const placeMatch = html.match(/[Ll]ugar[^:]*:\s*(?:<[^>]+>)*([^<]+)/);
  if (placeMatch) result.place = placeMatch[1].trim();

  // Extract date
  const dateMatch = html.match(/[Ff]echa[^:]*:\s*(?:<[^>]+>)*([^<]+)/);
  if (dateMatch) result.date = dateMatch[1].trim();

  return result;
}
