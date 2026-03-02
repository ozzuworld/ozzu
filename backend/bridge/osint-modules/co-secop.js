// Colombian OSINT: SECOP II — Government procurement contracts
// Source: datos.gov.co Socrata SODA API — proper REST API, free, no auth required
const { validateNIT, formatCOP, safeFetch } = require("./co-utils");

// Socrata SODA API endpoints for SECOP datasets
const SECOP_DATASETS = {
  secopII: "https://www.datos.gov.co/resource/jbjy-vk9h.json",    // SECOP II contracts
  secopI:  "https://www.datos.gov.co/resource/79ga-5jck.json",     // SECOP I contracts
};

module.exports = {
  name: "co-secop",
  profileTypes: ["nit", "cedula"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const value = profile.value;

    // Search SECOP II first (more recent/complete)
    const release = await rateLimiter.acquire();
    try {
      let query;
      if (profile.profile_type === "nit") {
        const nit = validateNIT(value) || value;
        query = `$where=nit_del_proveedor_adjudicado='${nit}' OR documento_proveedor='${nit}'&$limit=50&$order=fecha_de_firma DESC`;
      } else {
        // For cédula, search by document number
        query = `$where=documento_proveedor='${value}'&$limit=50&$order=fecha_de_firma DESC`;
      }

      const url = `${SECOP_DATASETS.secopII}?${query}`;
      const res = await safeFetch(url, {
        headers: { Accept: "application/json" },
      });

      if (res.ok && Array.isArray(res.body) && res.body.length > 0) {
        const contracts = res.body;
        let totalValue = 0;
        const entities = new Set();
        const years = new Set();

        for (const c of contracts) {
          const amount = parseFloat(c.valor_del_contrato || c.valor_contrato || 0);
          totalValue += amount;
          if (c.nombre_entidad) entities.add(c.nombre_entidad);
          if (c.fecha_de_firma) years.add(c.fecha_de_firma.substring(0, 4));
        }

        // Summary finding
        findings.push({
          category: "exposure",
          severity: contracts.length >= 10 ? "high" : contracts.length >= 3 ? "medium" : "low",
          title: `SECOP: ${contracts.length} government contract(s) — ${formatCOP(totalValue)}`,
          description: [
            `Found ${contracts.length} contract(s) in SECOP II`,
            `Total value: ${formatCOP(totalValue)}`,
            `Entities: ${Array.from(entities).slice(0, 5).join(", ")}${entities.size > 5 ? ` (+${entities.size - 5} more)` : ""}`,
            `Years: ${Array.from(years).sort().join(", ")}`,
            totalValue > 10000000000 ? "\n⚠️ PEP INDICATOR: High government contract volume (>$10B COP)" : "",
          ].filter(Boolean).join("\n"),
          sourceUrl: "https://community.secop.gov.co/Public/Tendering/ContractNoticeManagement/Index",
          rawData: {
            totalContracts: contracts.length,
            totalValue,
            entities: Array.from(entities),
            years: Array.from(years).sort(),
            topContracts: contracts.slice(0, 5).map(c => ({
              entity: c.nombre_entidad,
              description: (c.descripcion_del_proceso || c.objeto_del_contrato || "").substring(0, 200),
              value: parseFloat(c.valor_del_contrato || c.valor_contrato || 0),
              date: c.fecha_de_firma,
              type: c.tipo_de_contrato,
              status: c.estado_contrato,
            })),
          },
          remediation: contracts.length >= 10
            ? "High volume of government contracts. Verify compliance and review for potential conflicts of interest."
            : "Government contract records are public. No remediation needed.",
        });

        // Individual top contracts (top 5 by value)
        const sorted = [...contracts].sort((a, b) =>
          parseFloat(b.valor_del_contrato || b.valor_contrato || 0) - parseFloat(a.valor_del_contrato || a.valor_contrato || 0)
        );
        for (const c of sorted.slice(0, 5)) {
          const amount = parseFloat(c.valor_del_contrato || c.valor_contrato || 0);
          findings.push({
            category: "exposure",
            severity: amount > 1000000000 ? "high" : "medium",
            title: `SECOP Contract: ${formatCOP(amount)} — ${(c.nombre_entidad || "Unknown entity").substring(0, 60)}`,
            description: [
              `Entity: ${c.nombre_entidad || "N/A"}`,
              `Object: ${(c.descripcion_del_proceso || c.objeto_del_contrato || "N/A").substring(0, 300)}`,
              `Value: ${formatCOP(amount)}`,
              `Date: ${c.fecha_de_firma || "N/A"}`,
              `Type: ${c.tipo_de_contrato || "N/A"}`,
              `Status: ${c.estado_contrato || "N/A"}`,
            ].join("\n"),
            sourceUrl: c.urlproceso || "https://community.secop.gov.co",
            rawData: c,
          });
        }
      } else {
        findings.push({
          category: "exposure",
          severity: "info",
          title: "SECOP: No government contracts found",
          description: `No government procurement contracts found in SECOP II for ${profile.profile_type}: ${value}`,
          sourceUrl: "https://community.secop.gov.co",
          rawData: { searched: value, type: profile.profile_type, dataset: "SECOP II" },
        });
      }
    } catch (err) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "SECOP: Lookup error",
        description: `Error querying SECOP: ${err.message}`,
        rawData: { error: err.message },
      });
    } finally {
      release();
    }

    return findings;
  },
};
