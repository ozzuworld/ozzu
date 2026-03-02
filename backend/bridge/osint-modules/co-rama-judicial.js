// Colombian OSINT: Rama Judicial — Court case lookup
// Source: consultaprocesos.ramajudicial.gov.co — process consultation
// Access: Public API with rate limits, no captcha
const { validateCedula, safeFetch, CO_HEADERS } = require("./co-utils");

module.exports = {
  name: "co-rama-judicial",
  profileTypes: ["cedula"],

  async scan(profile, rateLimiter) {
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

    const release = await rateLimiter.acquire();
    try {
      // Rama Judicial public consultation API
      const url = `https://consultaprocesos.ramajudicial.gov.co:448/api/v2/Procesos/Consulta/NumeroDocumento?numero=${cedula}&SoloActivos=false&pagina=1`;
      const res = await safeFetch(url, {
        method: "GET",
        headers: {
          ...CO_HEADERS,
          Accept: "application/json",
        },
      }, 20000);

      if (res.ok && res.body) {
        const data = typeof res.body === "string" ? {} : res.body;
        const processes = data.procesos || data.Procesos || [];
        const total = data.cantidadRegistros || data.CantidadRegistros || processes.length;

        if (Array.isArray(processes) && processes.length > 0) {
          const active = processes.filter(p =>
            (p.esPrivado !== true) &&
            (p.fechaUltimaActuacion || p.FechaUltimaActuacion)
          );

          const summary = processes.slice(0, 8).map((p, i) => {
            const court = p.despacho || p.Despacho || "N/A";
            const subject = p.sujetosProcesales || p.SujetosProcesales || "N/A";
            const date = p.fechaUltimaActuacion || p.FechaUltimaActuacion || "N/A";
            const type = p.tipoProceso || p.TipoProceso || "N/A";
            const caseNum = p.llaveProceso || p.LlaveProceso || "N/A";
            return `${i + 1}. [${type}] ${caseNum}\n   Court: ${court}\n   Last action: ${date}\n   Parties: ${typeof subject === "string" ? subject.substring(0, 100) : "N/A"}`;
          }).join("\n\n");

          const severity = active.length > 0 ? "high" : "medium";

          findings.push({
            category: "exposure",
            severity,
            title: `Rama Judicial: ${total} court case${total !== 1 ? "s" : ""} found`,
            description: [
              `CC: ${cedula} is involved in ${total} judicial process(es) in Colombian courts.`,
              active.length > 0 ? `Active cases: ${active.length}` : "No recently active cases.",
              "",
              summary,
              total > 8 ? `\n... and ${total - 8} more cases` : "",
            ].filter(Boolean).join("\n"),
            sourceUrl: "https://consultaprocesos.ramajudicial.gov.co/",
            rawData: { total, activeCount: active.length, cases: processes.slice(0, 10) },
            remediation: "Court cases are public record. For active cases, consult the assigned court or a legal attorney. Visit consultaprocesos.ramajudicial.gov.co for full details.",
          });
        } else {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "Rama Judicial: No court cases found",
            description: `CC: ${cedula} has no judicial processes in the Colombian court system. Clean judicial record.`,
            sourceUrl: "https://consultaprocesos.ramajudicial.gov.co/",
            rawData: { searched: cedula, total: 0 },
          });
        }
      } else {
        findings.push({
          category: "exposure",
          severity: "info",
          title: "Rama Judicial: Manual verification required",
          description: `Could not automatically query Rama Judicial. Check court cases for CC: ${cedula} at consultaprocesos.ramajudicial.gov.co`,
          sourceUrl: "https://consultaprocesos.ramajudicial.gov.co/",
          rawData: { error: res.error || `HTTP ${res.status}`, searched: cedula },
          remediation: "Visit https://consultaprocesos.ramajudicial.gov.co/ — search by cédula to find all court cases.",
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
