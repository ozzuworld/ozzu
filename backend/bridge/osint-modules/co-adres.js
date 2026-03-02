// Colombian OSINT: ADRES (Administradora de los Recursos del SGSS) — Health system affiliation
// Source: adres.gov.co redirects to miseguridadsocial.gov.co for actual consultation
// The old BDUA API (aplicaciones.adres.gov.co) is offline. New system requires web interaction.
const { validateCedula, safeFetch, CO_HEADERS } = require("./co-utils");

module.exports = {
  name: "co-adres",
  profileTypes: ["cedula"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const cedula = validateCedula(profile.value);
    if (!cedula) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "ADRES: Invalid cédula format",
        description: `The value "${profile.value}" is not a valid Colombian cédula.`,
        rawData: { input: profile.value },
      });
      return findings;
    }

    const release = await rateLimiter.acquire();
    try {
      // Try the legacy BDUA API endpoint (may still work)
      const url = "https://aplicaciones.adres.gov.co/bdua-internet-production/api/1.0/Afiliados/consultarAfiliado";
      const res = await safeFetch(url, {
        method: "POST",
        headers: {
          ...CO_HEADERS,
          "Content-Type": "application/json",
          Accept: "application/json",
          Origin: "https://www.adres.gov.co",
          Referer: "https://www.adres.gov.co/",
        },
        body: JSON.stringify({
          tipoDocumento: "CC",
          numeroDocumento: cedula,
        }),
      });

      if (res.ok && res.body) {
        const data = Array.isArray(res.body) ? res.body[0] : res.body;
        if (data && (data.nombre || data.primerNombre || data.eps || data.entidad)) {
          const fullName = [data.primerNombre, data.segundoNombre, data.primerApellido, data.segundoApellido]
            .filter(Boolean).join(" ") || data.nombre || "N/A";
          const eps = data.eps || data.entidad || data.nombreEntidad || "N/A";
          const regime = data.tipoAfiliado || data.regimen || data.tipoRegimen || "N/A";
          const status = data.estado || data.estadoAfiliado || "N/A";
          const municipality = data.municipio || data.nombreMunicipio || "N/A";
          const department = data.departamento || data.nombreDepartamento || "N/A";

          findings.push({
            category: "metadata",
            severity: "medium",
            title: `ADRES: ${eps} — ${regime}`,
            description: [
              `Name: ${fullName}`,
              `EPS: ${eps}`,
              `Regime: ${regime}`,
              `Status: ${status}`,
              `Municipality: ${municipality}`,
              `Department: ${department}`,
            ].join("\n"),
            sourceUrl: "https://www.adres.gov.co/consulte-su-eps",
            rawData: data,
            remediation: "Health affiliation data is managed by your EPS. Contact them to update or correct information.",
          });
          return findings;
        }
      }

      // Legacy API didn't work — try alternate approach
      // Try miseguridadsocial.gov.co (the new platform)
      const release2 = await rateLimiter.acquire();
      try {
        const msRes = await safeFetch("https://www.miseguridadsocial.gov.co/", { method: "GET" }, 10000);
        // Even if we can reach it, it's a SPA that requires JS execution
        // Just note it's available
      } catch (e) {
        // Continue
      } finally {
        release2();
      }

      findings.push({
        category: "metadata",
        severity: "info",
        title: "ADRES: Manual lookup required",
        description: [
          `The ADRES BDUA API has been migrated. Health affiliation for CC: ${cedula} must be checked manually.`,
          `Health affiliation reveals: EPS name, regime (contributivo/subsidiado), municipality, and affiliation status.`,
          `This data can identify the person's name and location.`,
        ].join("\n"),
        sourceUrl: "https://www.adres.gov.co/consulte-su-eps",
        rawData: { searched: cedula, reason: "api_migrated", error: res.error || `HTTP ${res.status}` },
        remediation: [
          "Primary: https://www.adres.gov.co/consulte-su-eps",
          "Alternate: https://www.miseguridadsocial.gov.co/",
          "Enter cédula to check health system affiliation (EPS, regime, status).",
        ].join("\n"),
      });
    } catch (err) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "ADRES: Lookup error",
        description: `Error querying ADRES: ${err.message}`,
        rawData: { error: err.message },
      });
    } finally {
      release();
    }

    return findings;
  },
};
