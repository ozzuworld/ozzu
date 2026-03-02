// Colombian OSINT: SIGEP II (Sistema de Información y Gestión del Empleo Público)
// Source: datos.gov.co SODA API — dataset 2jzx-383z (verified working)
// Access: Free, no auth, no captcha — proper REST API
const { validateCedula, safeFetch } = require("./co-utils");

const SIGEP_DATASET = "https://www.datos.gov.co/resource/2jzx-383z.json";

module.exports = {
  name: "co-sigep",
  profileTypes: ["cedula"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const cedula = validateCedula(profile.value);
    if (!cedula) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "SIGEP: Invalid cédula format",
        description: `The value "${profile.value}" is not a valid Colombian cédula.`,
        rawData: { input: profile.value },
      });
      return findings;
    }

    const release = await rateLimiter.acquire();
    try {
      const url = `${SIGEP_DATASET}?$where=numerodeidentificacion='${cedula}'&$limit=50`;
      const res = await safeFetch(url, {
        headers: { Accept: "application/json" },
      });

      if (res.ok && Array.isArray(res.body)) {
        if (res.body.length > 0) {
          const entities = new Set();
          const positions = [];

          for (const record of res.body) {
            const entity = record.nombreentidad || "Unknown entity";
            entities.add(entity);

            const salary = record.asignacionbasicasalarial
              ? record.asignacionbasicasalarial.replace(/,/g, "")
              : null;

            positions.push({
              entity,
              position: record.denominacionempleoactual || record.dependenciaempleoactual || "N/A",
              level: record.niveljerarquicoempleo || "N/A",
              appointmentType: record.tipodenombramiento || "N/A",
              salary: salary ? `$${Number(salary).toLocaleString("es-CO")} COP` : "N/A",
              startDate: record.fecha_de_vinculaci_n ? record.fecha_de_vinculaci_n.split("T")[0] : "N/A",
              education: record.niveleducativo || "N/A",
              birthplace: [record.municipiodenacimiento, record.departamentodenacimiento].filter(Boolean).join(", ") || "N/A",
              gender: record.sexo || "N/A",
              order: record.orden || "N/A",
              legalNature: record.naturalezajuridica || "N/A",
              experiencePublic: record.mesesdeexperienciapublico ? `${record.mesesdeexperienciapublico} months` : null,
              experiencePrivate: record.mesesdeexperienciaprivado ? `${record.mesesdeexperienciaprivado} months` : null,
            });
          }

          // Summary finding
          findings.push({
            category: "exposure",
            severity: "medium",
            title: `SIGEP: Public servant — ${res.body.length} position(s) in ${entities.size} entit${entities.size === 1 ? "y" : "ies"}`,
            description: [
              `CC: ${cedula} found in the SIGEP public servant registry.`,
              `Gender: ${positions[0].gender}`,
              `Birthplace: ${positions[0].birthplace}`,
              `Education: ${positions[0].education}`,
              positions[0].experiencePublic ? `Public experience: ${positions[0].experiencePublic}` : null,
              "",
              ...positions.slice(0, 5).map((p, i) => [
                `${i + 1}. ${p.entity}`,
                `   Position: ${p.position}`,
                `   Level: ${p.level} (${p.appointmentType})`,
                `   Salary: ${p.salary}`,
                `   Since: ${p.startDate}`,
              ].join("\n")),
              positions.length > 5 ? `\n... and ${positions.length - 5} more positions` : "",
            ].filter(Boolean).join("\n"),
            sourceUrl: "https://www.funcionpublica.gov.co/web/sigep2/directorio-publico",
            rawData: {
              count: res.body.length,
              cedula,
              entities: Array.from(entities),
              positions: positions.slice(0, 10),
              gps: positions[0].birthplace !== "N/A" ? positions[0].birthplace : undefined,
            },
            remediation: "Public servant information is public by law (Ley 1712 de 2014). Contact Función Pública for corrections.",
          });

          // Individual position findings for top entities
          for (const p of positions.slice(0, 3)) {
            findings.push({
              category: "exposure",
              severity: "medium",
              title: `SIGEP: ${p.entity} — ${p.position}`,
              description: [
                `Entity: ${p.entity} (${p.legalNature})`,
                `Position: ${p.position}`,
                `Level: ${p.level}`,
                `Type: ${p.appointmentType}`,
                `Salary: ${p.salary}`,
                `Since: ${p.startDate}`,
              ].join("\n"),
              sourceUrl: "https://www.funcionpublica.gov.co/web/sigep2/directorio-publico",
              rawData: p,
            });
          }
        } else {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "SIGEP: Not a public servant",
            description: `No public servant records found in SIGEP for CC: ${cedula}. This person is not currently listed as a government employee.`,
            sourceUrl: "https://www.funcionpublica.gov.co/web/sigep2/directorio-publico",
            rawData: { searched: cedula },
          });
        }
      } else {
        findings.push({
          category: "exposure",
          severity: "info",
          title: "SIGEP: Lookup error",
          description: `Could not query SIGEP dataset. Check manually at funcionpublica.gov.co with CC: ${cedula}`,
          sourceUrl: "https://www.funcionpublica.gov.co/web/sigep2/directorio-publico",
          rawData: { error: res.error || `HTTP ${res.status}`, searched: cedula },
          remediation: "Visit https://www.funcionpublica.gov.co/web/sigep2/directorio-publico and search by cédula.",
        });
      }
    } catch (err) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "SIGEP: Lookup error",
        description: `Error querying SIGEP: ${err.message}`,
        rawData: { error: err.message },
      });
    } finally {
      release();
    }

    return findings;
  },
};
