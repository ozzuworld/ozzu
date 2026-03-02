// Colombian OSINT: Rama Judicial — Court case lookup
// Source: consultaprocesos.ramajudicial.gov.co — process consultation
// Access: Public API, no captcha. NumeroDocumento endpoint removed in 2025.
// Uses NombreRazonSocial search — requires name from other modules or DB.
const { validateCedula, safeFetch, CO_HEADERS } = require("./co-utils");

const API_BASE = "https://consultaprocesos.ramajudicial.gov.co:448/api/v2/Procesos/Consulta";

module.exports = {
  name: "co-rama-judicial",
  profileTypes: ["cedula"],

  async scan(profile, rateLimiter, { db } = {}) {
    const findings = [];
    const cedula = validateCedula(profile.value);
    if (!cedula) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Rama Judicial: Invalid cédula format",
        description: `The value "${profile.value}" is not a valid Colombian cédula.`,
        rawData: { input: profile.value },
      });
      return findings;
    }

    // Step 1: Try to resolve the person's name from existing scan findings
    let personName = null;
    if (db) {
      try {
        const nameResult = await db.query(`
          SELECT raw_data FROM osint_findings
          WHERE profile_id = $1
            AND raw_data IS NOT NULL
            AND status != 'false_positive'
          ORDER BY created_at DESC LIMIT 20
        `, [profile.id]);

        for (const row of nameResult.rows) {
          const data = typeof row.raw_data === "string" ? JSON.parse(row.raw_data) : row.raw_data;
          // Try to find name from ADRES, SIGEP, or other CO modules
          const name = data?.primerNombre || data?.nombre || data?.name || data?.fullName;
          const lastName = data?.primerApellido || data?.apellido;
          if (name && name !== cedula && !/^\d+$/.test(name)) {
            personName = lastName ? `${name} ${lastName}` : name;
            break;
          }
          // Check raw_data for birthplace-based name from SIGEP positions
          if (data?.positions && Array.isArray(data.positions)) {
            // SIGEP datos.gov.co doesn't include names, skip
            continue;
          }
        }
      } catch (e) {
        // DB not available, continue without name
      }
    }

    // Also check profile label which might contain the name
    if (!personName && profile.label && !/^\d+$/.test(profile.label)) {
      personName = profile.label;
    }

    if (!personName) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Rama Judicial: Name required for lookup",
        description: [
          `The Rama Judicial API no longer supports cédula-based search (NumeroDocumento query type was removed in 2025).`,
          `Court cases must be searched by name (NombreRazonSocial).`,
          `Run other modules first (ADRES, Registraduría) to resolve the name, then re-scan.`,
          `Or search manually at consultaprocesos.ramajudicial.gov.co`,
        ].join("\n"),
        sourceUrl: "https://consultaprocesos.ramajudicial.gov.co/",
        rawData: { searched: cedula, reason: "name_not_resolved" },
        remediation: "Visit https://consultaprocesos.ramajudicial.gov.co/ — search by name to find court cases.",
      });
      return findings;
    }

    // Step 2: Search by name
    const release = await rateLimiter.acquire();
    try {
      const encodedName = encodeURIComponent(personName);
      const url = `${API_BASE}/NombreRazonSocial?nombre=${encodedName}&tipoPersona=Natural&SoloActivos=false&pagina=1`;
      const res = await safeFetch(url, {
        method: "GET",
        headers: {
          ...CO_HEADERS,
          Accept: "application/json",
        },
      }, 20000);

      if (res.ok && res.body) {
        const data = typeof res.body === "string" ? {} : res.body;

        // Check for "too many results" error
        if (data.StatusCode === 400 || data.Message) {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "Rama Judicial: Too many results",
            description: `Search for "${personName}" returned too many results. Try a more specific name at consultaprocesos.ramajudicial.gov.co`,
            sourceUrl: "https://consultaprocesos.ramajudicial.gov.co/",
            rawData: { searched: personName, cedula, message: data.Message },
            remediation: "Visit https://consultaprocesos.ramajudicial.gov.co/ and search with the full name.",
          });
          return findings;
        }

        const processes = data.procesos || data.Procesos || [];
        const total = data.cantidadRegistros || data.CantidadRegistros || processes.length;

        if (Array.isArray(processes) && processes.length > 0) {
          // Filter to processes that mention this cedula in the parties
          const relevant = processes.filter(p => {
            const subjects = (p.sujetosProcesales || p.SujetosProcesales || "").toLowerCase();
            return subjects.includes(cedula) || subjects.includes(personName.toLowerCase());
          });

          const display = relevant.length > 0 ? relevant : processes.slice(0, 10);
          const count = relevant.length > 0 ? relevant.length : total;

          const summary = display.slice(0, 8).map((p, i) => {
            const court = p.despacho || p.Despacho || "N/A";
            const subject = p.sujetosProcesales || p.SujetosProcesales || "N/A";
            const date = p.fechaUltimaActuacion || p.FechaUltimaActuacion || "N/A";
            const type = p.tipoProceso || p.TipoProceso || "N/A";
            const caseNum = p.llaveProceso || p.LlaveProceso || "N/A";
            return `${i + 1}. [${type}] ${caseNum}\n   Court: ${court}\n   Last action: ${date}\n   Parties: ${typeof subject === "string" ? subject.substring(0, 120) : "N/A"}`;
          }).join("\n\n");

          const active = display.filter(p =>
            (p.esPrivado !== true) &&
            (p.fechaUltimaActuacion || p.FechaUltimaActuacion)
          );

          const severity = active.length > 0 ? "high" : "medium";

          findings.push({
            category: "exposure",
            severity,
            title: `Rama Judicial: ${count} court case${count !== 1 ? "s" : ""} found`,
            description: [
              `"${personName}" (CC: ${cedula}) — ${count} judicial process(es) in Colombian courts.`,
              active.length > 0 ? `Active cases: ${active.length}` : "No recently active cases.",
              relevant.length > 0 ? `(Filtered to cases mentioning this person)` : `(Showing all results for name match)`,
              "",
              summary,
              count > 8 ? `\n... and ${count - 8} more cases` : "",
            ].filter(Boolean).join("\n"),
            sourceUrl: "https://consultaprocesos.ramajudicial.gov.co/",
            rawData: { total: count, activeCount: active.length, searchedName: personName, cases: display.slice(0, 10) },
            remediation: "Court cases are public record. For active cases, consult the assigned court or a legal attorney.",
          });
        } else {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "Rama Judicial: No court cases found",
            description: `No judicial processes found for "${personName}" (CC: ${cedula}) in the Colombian court system. Clean judicial record.`,
            sourceUrl: "https://consultaprocesos.ramajudicial.gov.co/",
            rawData: { searched: personName, cedula, total: 0 },
          });
        }
      } else {
        findings.push({
          category: "exposure",
          severity: "info",
          title: "Rama Judicial: Manual verification required",
          description: `Could not query Rama Judicial for "${personName}". Check at consultaprocesos.ramajudicial.gov.co`,
          sourceUrl: "https://consultaprocesos.ramajudicial.gov.co/",
          rawData: { error: res.error || `HTTP ${res.status}`, searchedName: personName, cedula },
          remediation: "Visit https://consultaprocesos.ramajudicial.gov.co/ — search by name to find all court cases.",
        });
      }
    } catch (err) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Rama Judicial: Lookup error",
        description: `Error querying Rama Judicial: ${err.message}`,
        rawData: { error: err.message },
      });
    } finally {
      release();
    }

    return findings;
  },
};
