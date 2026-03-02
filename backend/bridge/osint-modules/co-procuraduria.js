// Colombian OSINT: Procuraduría General de la Nación — Disciplinary records
// Source: procuraduria.gov.co — antecedentes disciplinarios
// Access: Security questions (trivial) or Apitude fallback
const { validateCedula, safeFetch, CO_HEADERS } = require("./co-utils");

module.exports = {
  name: "co-procuraduria",
  profileTypes: ["cedula"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const cedula = validateCedula(profile.value);
    if (!cedula) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Procuraduría: Invalid cédula format",
        description: `The value "${profile.value}" is not a valid Colombian cédula.`,
        rawData: { input: profile.value },
      });
      return findings;
    }

    const release = await rateLimiter.acquire();
    try {
      // Try direct consultation endpoint
      const url = "https://www.procuraduria.gov.co/relatoria/api/antecedentes";
      const res = await safeFetch(url, {
        method: "POST",
        headers: {
          ...CO_HEADERS,
          "Content-Type": "application/json",
          Accept: "application/json",
          Origin: "https://www.procuraduria.gov.co",
          Referer: "https://www.procuraduria.gov.co/Pages/Consulta-de-Antecedentes.aspx",
        },
        body: JSON.stringify({
          tipoDocumento: 1,
          numeroDocumento: cedula,
        }),
      });

      if (res.ok && res.body) {
        const data = typeof res.body === "string" ? {} : res.body;
        const hasRecords = data.spipiRegistros || data.registros || data.tiene_antecedentes;

        if (hasRecords) {
          const records = data.spipiRegistros || data.registros || [];
          const sanctions = Array.isArray(records) ? records : [];
          findings.push({
            category: "exposure",
            severity: "critical",
            title: `Procuraduría: DISCIPLINARY RECORDS FOUND (${sanctions.length || "1+"})`,
            description: [
              `CC: ${cedula} has disciplinary records in Procuraduría.`,
              `This indicates formal sanctions by the Colombian government.`,
              ...sanctions.slice(0, 5).map((s, i) =>
                `${i + 1}. ${s.sancion || s.tipo || "Sanction"} — ${s.entidad || s.entity || "N/A"} (${s.fecha || s.date || "N/A"})`
              ),
              sanctions.length > 5 ? `... and ${sanctions.length - 5} more records` : "",
            ].filter(Boolean).join("\n"),
            sourceUrl: "https://www.procuraduria.gov.co/Pages/Consulta-de-Antecedentes.aspx",
            rawData: data,
            remediation: "Disciplinary records from the Procuraduría are public. Consult a Colombian attorney for expungement options if applicable.",
          });
        } else {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "Procuraduría: No disciplinary records",
            description: `CC: ${cedula} has no disciplinary records in the Procuraduría General de la Nación. Clean disciplinary background.`,
            sourceUrl: "https://www.procuraduria.gov.co/Pages/Consulta-de-Antecedentes.aspx",
            rawData: { searched: cedula, clean: true },
          });
        }
      } else {
        // Fallback: try HTML scrape of the legacy page
        const legacyUrl = `https://www.procuraduria.gov.co/Pages/Consulta-de-Antecedentes.aspx`;
        const legacyRes = await safeFetch(legacyUrl);
        const hasPageData = legacyRes.ok && typeof legacyRes.body === "string" &&
          legacyRes.body.includes("antecedentes");

        if (hasPageData) {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "Procuraduría: Manual verification required",
            description: `Automatic query returned HTTP ${res.status}. Visit the Procuraduría website to check disciplinary records for CC: ${cedula}.\nThe site uses security questions that change — manual verification is more reliable.`,
            sourceUrl: "https://www.procuraduria.gov.co/Pages/Consulta-de-Antecedentes.aspx",
            rawData: { searched: cedula, error: res.error || `HTTP ${res.status}` },
            remediation: "Visit https://www.procuraduria.gov.co/Pages/Consulta-de-Antecedentes.aspx — enter cédula + answer security questions.",
          });
        } else {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "Procuraduría: Service unavailable",
            description: `Could not reach Procuraduría service. Check manually for CC: ${cedula}`,
            sourceUrl: "https://www.procuraduria.gov.co/Pages/Consulta-de-Antecedentes.aspx",
            rawData: { error: res.error || `HTTP ${res.status}` },
            remediation: "Visit https://www.procuraduria.gov.co/Pages/Consulta-de-Antecedentes.aspx",
          });
        }
      }
    } catch (err) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Procuraduría: Lookup error",
        description: `Error querying Procuraduría: ${err.message}`,
        rawData: { error: err.message },
      });
    } finally {
      release();
    }

    return findings;
  },
};
