// Colombian OSINT: RUES (Registro Único Empresarial y Social) — Business registry lookup
// Source: datos.gov.co SODA API — dataset c82u-588k (Personas Naturales, Jurídicas y ESALES)
// Also: dataset nb3d-v3n7 (Establecimientos, Agencias, Sucursales)
// Access: Free, no auth, no captcha
const { validateCedula, validateNIT, safeFetch } = require("./co-utils");

const RUES_DATASET = "https://www.datos.gov.co/resource/c82u-588k.json";
const ESTABLECIMIENTOS_DATASET = "https://www.datos.gov.co/resource/nb3d-v3n7.json";

module.exports = {
  name: "co-rues",
  profileTypes: ["nit", "cedula"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const value = profile.value;
    const cleanValue = profile.profile_type === "nit"
      ? (validateNIT(value) || value)
      : (validateCedula(value) || value);

    // Strategy 1: Query datos.gov.co RUES dataset
    const release = await rateLimiter.acquire();
    try {
      const query = `$where=numero_identificacion='${cleanValue}'&$limit=50&$order=fecha_matricula DESC`;
      const url = `${RUES_DATASET}?${query}`;
      const res = await safeFetch(url, {
        headers: { Accept: "application/json" },
      });

      if (res.ok && Array.isArray(res.body) && res.body.length > 0) {
        const companies = res.body;
        const active = companies.filter(c => c.estado_matricula === "ACTIVA");
        const cancelled = companies.filter(c => c.estado_matricula !== "ACTIVA");

        // Summary finding
        findings.push({
          category: "exposure",
          severity: active.length >= 3 ? "high" : active.length > 0 ? "medium" : "low",
          title: `RUES: ${companies.length} business registration(s) — ${active.length} active`,
          description: [
            `Found ${companies.length} business registration(s) for ${profile.profile_type.toUpperCase()}: ${cleanValue}`,
            `Active: ${active.length} | Cancelled: ${cancelled.length}`,
            "",
            ...companies.slice(0, 8).map((c, i) => [
              `${i + 1}. ${c.razon_social || "N/A"}`,
              `   Chamber: ${c.camara_comercio || "N/A"}`,
              `   Type: ${c.organizacion_juridica || c.tipo_sociedad || "N/A"}`,
              `   Status: ${c.estado_matricula || "N/A"}`,
              `   Registration: ${c.matricula || "N/A"}`,
              c.cod_ciiu_act_econ_pri ? `   CIIU: ${c.cod_ciiu_act_econ_pri}` : null,
              c.fecha_matricula ? `   Since: ${formatDate(c.fecha_matricula)}` : null,
            ].filter(Boolean).join("\n")),
          ].join("\n"),
          sourceUrl: "https://www.rues.org.co/RM",
          rawData: {
            totalCompanies: companies.length,
            activeCount: active.length,
            companies: companies.slice(0, 10).map(c => ({
              name: c.razon_social,
              chamber: c.camara_comercio,
              type: c.organizacion_juridica,
              status: c.estado_matricula,
              registration: c.matricula,
              ciiu: c.cod_ciiu_act_econ_pri,
              date: c.fecha_matricula,
              nit: c.numero_identificacion,
            })),
          },
          remediation: active.length >= 3
            ? "Multiple active business registrations found. Review for potential conflicts of interest."
            : "Business registration data is public record. No remediation needed.",
        });

        // Individual active business findings
        for (const c of active.slice(0, 5)) {
          findings.push({
            category: "exposure",
            severity: "medium",
            title: `RUES: ${c.razon_social || "Business"} — ${c.camara_comercio || "Unknown Chamber"}`,
            description: [
              `Name: ${c.razon_social || "N/A"}`,
              `NIT/CC: ${c.numero_identificacion || cleanValue}`,
              `Chamber: ${c.camara_comercio || "N/A"}`,
              `Type: ${c.organizacion_juridica || c.tipo_sociedad || "N/A"}`,
              `Category: ${c.categoria_matricula || "N/A"}`,
              `Registration #: ${c.matricula || "N/A"}`,
              `Status: ${c.estado_matricula || "N/A"}`,
              c.cod_ciiu_act_econ_pri ? `CIIU Activity: ${c.cod_ciiu_act_econ_pri}` : null,
              c.fecha_matricula ? `Registered: ${formatDate(c.fecha_matricula)}` : null,
              c.ultimo_ano_renovado && c.ultimo_ano_renovado !== "0" ? `Last renewed: ${c.ultimo_ano_renovado}` : null,
            ].filter(Boolean).join("\n"),
            sourceUrl: "https://www.rues.org.co/RM",
            rawData: c,
          });
        }

        return findings;
      }

      // No results in main dataset
      findings.push({
        category: "exposure",
        severity: "info",
        title: "RUES: No business registrations found",
        description: `No companies or business registrations found in RUES for ${profile.profile_type.toUpperCase()}: ${cleanValue}`,
        sourceUrl: "https://www.rues.org.co/RM",
        rawData: { searched: cleanValue, type: profile.profile_type },
      });
    } catch (err) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "RUES: Lookup error",
        description: `Error querying RUES: ${err.message}`,
        sourceUrl: "https://www.rues.org.co/RM",
        rawData: { error: err.message },
      });
    } finally {
      release();
    }

    return findings;
  },
};

function formatDate(dateStr) {
  if (!dateStr || dateStr.length < 8) return dateStr || "N/A";
  // Format YYYYMMDD to YYYY-MM-DD
  if (/^\d{8}$/.test(dateStr)) {
    return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  }
  return dateStr;
}
