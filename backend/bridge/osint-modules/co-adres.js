// Colombian OSINT: ADRES (Administradora de los Recursos del SGSS) — Health system affiliation
// Source: adres.gov.co — public health affiliation lookup, no captcha
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
      // ADRES BDUA consultation endpoint
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
              `Nombre: ${fullName}`,
              `EPS: ${eps}`,
              `Régimen: ${regime}`,
              `Estado: ${status}`,
              `Municipio: ${municipality}`,
              `Departamento: ${department}`,
            ].join("\n"),
            sourceUrl: "https://www.adres.gov.co/consulte-su-eps",
            rawData: data,
            remediation: "Health affiliation data is managed by your EPS. Contact them to update or correct information.",
          });
        } else {
          findings.push({
            category: "metadata",
            severity: "info",
            title: "ADRES: No health affiliation found",
            description: `No active health system affiliation found in ADRES/BDUA for CC: ${cedula}`,
            sourceUrl: "https://www.adres.gov.co/consulte-su-eps",
            rawData: { searched: cedula, response: data },
          });
        }
      } else {
        // Fallback: try alternate endpoint or provide manual link
        findings.push({
          category: "metadata",
          severity: "info",
          title: "ADRES: Manual lookup required",
          description: `Could not automatically query ADRES. Check your health affiliation at adres.gov.co with CC: ${cedula}`,
          sourceUrl: "https://www.adres.gov.co/consulte-su-eps",
          rawData: { error: res.error || `HTTP ${res.status}`, searched: cedula },
          remediation: "Visit https://www.adres.gov.co/consulte-su-eps and enter your cédula to check your EPS affiliation.",
        });
      }
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
