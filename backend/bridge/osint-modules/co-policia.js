// Colombian OSINT: Policía Nacional — Criminal background + traffic violations
// Source: srvcnpc.policia.gov.co/PSC/ — ASPX form with ViewState, NO reCAPTCHA
// The old antecedentes.policia.gov.co:7005 endpoint is offline (500/404).
// This endpoint covers traffic violations and police records by cédula.
const { validateCedula, safeFetch, CO_HEADERS, extractAspxFields } = require("./co-utils");

const FORM_URL = "https://srvcnpc.policia.gov.co/PSC/frm_cnp_consulta.aspx";

module.exports = {
  name: "co-policia",
  profileTypes: ["cedula"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const cedula = validateCedula(profile.value);
    if (!cedula) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Policía: Invalid cédula format",
        description: `The value "${profile.value}" is not a valid Colombian cédula.`,
        rawData: { input: profile.value },
      });
      return findings;
    }

    // Step 1: GET the ASPX form to extract ViewState
    const release1 = await rateLimiter.acquire();
    let aspxFields = null;
    let sessionCookies = "";
    try {
      const pageRes = await safeFetch(FORM_URL, { method: "GET" });
      if (pageRes.ok && typeof pageRes.body === "string") {
        aspxFields = extractAspxFields(pageRes.body);
        sessionCookies = pageRes.cookies || "";

        // Also extract __VIEWSTATEENCRYPTED if present
        const encMatch = pageRes.body.match(/__VIEWSTATEENCRYPTED[^>]*value="([^"]*)"/);
        if (encMatch && aspxFields) aspxFields.__VIEWSTATEENCRYPTED = encMatch[1];
      }
    } catch (e) {
      // Continue
    } finally {
      release1();
    }

    if (!aspxFields || !aspxFields.__VIEWSTATE) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Policía: Could not load form",
        description: `Failed to load Policía consultation form. Check records for CC: ${cedula} manually.`,
        sourceUrl: FORM_URL,
        rawData: { searched: cedula, reason: "viewstate_extraction_failed" },
        remediation: "Visit https://srvcnpc.policia.gov.co/PSC/frm_cnp_consulta.aspx — select Cédula, enter number, click search.",
      });
      return findings;
    }

    // Step 2: POST the form with cédula
    const release2 = await rateLimiter.acquire();
    try {
      const formData = new URLSearchParams();
      formData.append("ctl00_ContentPlaceHolder3_ToolkitScriptManager2_HiddenField", "");
      formData.append("__VIEWSTATE", aspxFields.__VIEWSTATE);
      if (aspxFields.__VIEWSTATEGENERATOR) formData.append("__VIEWSTATEGENERATOR", aspxFields.__VIEWSTATEGENERATOR);
      if (aspxFields.__VIEWSTATEENCRYPTED !== undefined) formData.append("__VIEWSTATEENCRYPTED", aspxFields.__VIEWSTATEENCRYPTED);
      if (aspxFields.__EVENTVALIDATION) formData.append("__EVENTVALIDATION", aspxFields.__EVENTVALIDATION);
      formData.append("__EVENTTARGET", "ctl00$ContentPlaceHolder3$btnConsultar");
      formData.append("__EVENTARGUMENT", "");
      formData.append("ctl00$ContentPlaceHolder3$ddlTipoDoc", "55"); // CEDULA DE CIUDADANIA
      formData.append("ctl00$ContentPlaceHolder3$txtExpediente", cedula);

      const res = await safeFetch(FORM_URL, {
        method: "POST",
        headers: {
          ...CO_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: FORM_URL,
          Origin: "https://srvcnpc.policia.gov.co",
          Cookie: sessionCookies,
        },
        body: formData.toString(),
      }, 20000);

      if (res.ok && typeof res.body === "string") {
        const html = res.body;
        const lower = html.toLowerCase();

        // Check for records found
        const hasRecords = lower.includes("registra anotaciones") ||
          lower.includes("medida de aseguramiento") ||
          lower.includes("orden de captura") ||
          lower.includes("comparendo") ||
          lower.includes("infracción");

        const isClean = lower.includes("no tiene asuntos pendientes") ||
          lower.includes("no registra") ||
          lower.includes("no se encontraron");

        // Parse any result table
        const tableData = parsePoliceTable(html);

        if (hasRecords || tableData.length > 0) {
          const severity = lower.includes("orden de captura") || lower.includes("medida de aseguramiento")
            ? "critical"
            : tableData.length > 5 ? "high" : "medium";

          findings.push({
            category: "exposure",
            severity,
            title: `Policía: ${tableData.length || "1+"} record(s) found`,
            description: [
              `CC: ${cedula} has records in the Policía Nacional system.`,
              lower.includes("orden de captura") ? "ARREST WARRANT DETECTED" : null,
              lower.includes("medida de aseguramiento") ? "SECURITY MEASURE DETECTED" : null,
              tableData.length > 0 ? `\nRecords:` : null,
              ...tableData.slice(0, 5).map((r, i) => `${i + 1}. ${r}`),
              tableData.length > 5 ? `... and ${tableData.length - 5} more records` : null,
            ].filter(Boolean).join("\n"),
            sourceUrl: FORM_URL,
            rawData: { searched: cedula, hasRecords: true, records: tableData.slice(0, 10) },
            remediation: "Police records are managed by the judicial system. Consult a criminal defense attorney. Check official status at srvcnpc.policia.gov.co",
          });
        } else if (isClean) {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "Policía: No records found",
            description: `CC: ${cedula} has no pending matters in the Policía Nacional system. Clean record.`,
            sourceUrl: FORM_URL,
            rawData: { searched: cedula, clean: true },
          });
        } else {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "Policía: Response unclear",
            description: `Received response but could not determine status for CC: ${cedula}. Verify manually.`,
            sourceUrl: FORM_URL,
            rawData: { searched: cedula, responseSnippet: html.substring(0, 500) },
            remediation: "Visit https://srvcnpc.policia.gov.co/PSC/frm_cnp_consulta.aspx — select Cédula, enter number, click search.",
          });
        }
      } else {
        findings.push({
          category: "exposure",
          severity: "info",
          title: "Policía: Form submission failed",
          description: `HTTP ${res.status}. Check police records for CC: ${cedula} manually.`,
          sourceUrl: FORM_URL,
          rawData: { error: res.error || `HTTP ${res.status}`, searched: cedula },
          remediation: "Visit https://srvcnpc.policia.gov.co/PSC/frm_cnp_consulta.aspx",
        });
      }
    } catch (err) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Policía: Lookup error",
        description: `Error querying Policía Nacional: ${err.message}`,
        rawData: { error: err.message },
      });
    } finally {
      release2();
    }

    return findings;
  },
};

function parsePoliceTable(html) {
  const records = [];
  // Parse table rows from results
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowPattern.exec(html)) !== null) {
    const row = match[1];
    const cells = [];
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(row)) !== null) {
      const text = cellMatch[1].replace(/<[^>]+>/g, "").trim();
      if (text) cells.push(text);
    }
    if (cells.length >= 2) {
      records.push(cells.join(" | "));
    }
  }
  return records;
}
