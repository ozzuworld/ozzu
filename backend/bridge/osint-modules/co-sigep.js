// Colombian OSINT: SIGEP II (Sistema de Información y Gestión del Empleo Público)
// Source: funcionpublica.gov.co — public servant directory, no captcha
const { validateCedula, safeFetch, CO_HEADERS } = require("./co-utils");

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
      // SIGEP has a public servant directory search
      const url = `https://www.funcionpublica.gov.co/web/sigep2/directorio-publico?keywords=${cedula}&p=`;
      const res = await safeFetch(url, {
        method: "GET",
        headers: {
          ...CO_HEADERS,
          Referer: "https://www.funcionpublica.gov.co/web/sigep2/directorio-publico",
        },
      });

      if (res.ok && typeof res.body === "string") {
        const html = res.body;
        const servants = parseSigepResults(html);

        if (servants.length > 0) {
          for (const s of servants) {
            findings.push({
              category: "exposure",
              severity: "medium",
              title: `SIGEP: Public servant — ${s.institution || "Government"}`,
              description: [
                s.name ? `Nombre: ${s.name}` : null,
                s.institution ? `Entidad: ${s.institution}` : null,
                s.position ? `Cargo: ${s.position}` : null,
                s.contractType ? `Tipo de vinculación: ${s.contractType}` : null,
                s.email ? `Email: ${s.email}` : null,
                s.phone ? `Teléfono: ${s.phone}` : null,
                s.city ? `Ciudad: ${s.city}` : null,
              ].filter(Boolean).join("\n"),
              sourceUrl: "https://www.funcionpublica.gov.co/web/sigep2/directorio-publico",
              rawData: s,
              remediation: "Public servant information is public by law. Contact Función Pública for corrections.",
            });
          }

          findings.unshift({
            category: "exposure",
            severity: "medium",
            title: `SIGEP: ${servants.length} public servant record(s) found`,
            description: `Found ${servants.length} record(s) in the SIGEP public servant directory for CC: ${cedula}`,
            rawData: { count: servants.length, cedula },
          });
        } else if (html.includes("No se encontraron") || html.includes("sin resultados") || !html.includes("directorio")) {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "SIGEP: Not a public servant",
            description: `No public servant records found in SIGEP for CC: ${cedula}. This person is not currently listed as a government employee.`,
            sourceUrl: "https://www.funcionpublica.gov.co/web/sigep2/directorio-publico",
            rawData: { searched: cedula },
          });
        } else {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "SIGEP: Manual lookup required",
            description: `Could not parse SIGEP response. Check manually at funcionpublica.gov.co with CC: ${cedula}`,
            sourceUrl: "https://www.funcionpublica.gov.co/web/sigep2/directorio-publico",
            rawData: { searched: cedula },
            remediation: "Visit https://www.funcionpublica.gov.co/web/sigep2/directorio-publico and search by cédula.",
          });
        }
      } else {
        findings.push({
          category: "exposure",
          severity: "info",
          title: "SIGEP: Manual lookup required",
          description: `Could not query SIGEP. Check manually with CC: ${cedula}`,
          sourceUrl: "https://www.funcionpublica.gov.co/web/sigep2/directorio-publico",
          rawData: { error: res.error || `HTTP ${res.status}` },
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

function parseSigepResults(html) {
  const results = [];
  // Parse the directory results table/cards
  const rowPattern = /<tr[^>]*class="[^"]*results[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  const cardPattern = /<div[^>]*class="[^"]*user-card[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;

  // Try table format
  let match;
  while ((match = rowPattern.exec(html)) !== null) {
    const row = match[1];
    const cells = [];
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(row)) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, "").trim());
    }
    if (cells.length >= 2) {
      results.push({
        name: cells[0] || null,
        institution: cells[1] || null,
        position: cells[2] || null,
        contractType: cells[3] || null,
        email: cells[4] || null,
        city: cells[5] || null,
      });
    }
  }

  // Try card format
  if (results.length === 0) {
    while ((match = cardPattern.exec(html)) !== null) {
      const card = match[1];
      const extract = (label) => {
        const m = card.match(new RegExp(label + "[^:]*:\\s*(?:<[^>]+>)*([^<]+)", "i"));
        return m ? m[1].trim() : null;
      };
      const nameMatch = card.match(/<h[2-4][^>]*>([^<]+)/);
      results.push({
        name: nameMatch ? nameMatch[1].trim() : null,
        institution: extract("Entidad") || extract("Instituci"),
        position: extract("Cargo") || extract("Empleo"),
        contractType: extract("Vinculaci") || extract("Tipo"),
        email: extract("Correo") || extract("Email"),
        city: extract("Ciudad") || extract("Municipio"),
      });
    }
  }

  return results;
}
