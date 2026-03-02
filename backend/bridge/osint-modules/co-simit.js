// Colombian OSINT: SIMIT (Sistema Integrado de Información sobre Multas y Sanciones por Infracciones de Tránsito)
// Source: consulta.simit.org.co — traffic fines lookup
const { validateCedula, safeFetch, formatCOP, CO_HEADERS } = require("./co-utils");

module.exports = {
  name: "co-simit",
  profileTypes: ["cedula"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const cedula = validateCedula(profile.value);
    if (!cedula) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "SIMIT: Invalid cédula format",
        description: `The value "${profile.value}" is not a valid Colombian cédula.`,
        rawData: { input: profile.value },
      });
      return findings;
    }

    const release = await rateLimiter.acquire();
    try {
      // SIMIT has a JSON API behind the consultation page
      const url = `https://consulta.simit.org.co/Simit/verificar/multas/CC/${cedula}`;
      const res = await safeFetch(url, {
        method: "GET",
        headers: {
          ...CO_HEADERS,
          Accept: "application/json",
          Referer: "https://consulta.simit.org.co/",
        },
      });

      if (res.ok && res.body) {
        let data = res.body;
        // Handle various response formats
        if (typeof data === "string") {
          try { data = JSON.parse(data); } catch { /* not JSON */ }
        }

        const comparendos = data.comparendos || data.data || data.multas || [];
        const isArray = Array.isArray(comparendos);

        if (isArray && comparendos.length > 0) {
          let totalFines = 0;
          let totalAmount = 0;

          for (const c of comparendos) {
            const amount = parseFloat(c.valor || c.valorMulta || c.totalPagar || 0);
            totalAmount += amount;
            totalFines++;

            findings.push({
              category: "exposure",
              severity: amount > 500000 ? "high" : "medium",
              title: `SIMIT: Infracción — ${formatCOP(amount)}`,
              description: [
                c.codigoInfraccion ? `Código: ${c.codigoInfraccion}` : null,
                c.descripcionInfraccion || c.descripcion ? `Descripción: ${(c.descripcionInfraccion || c.descripcion).substring(0, 200)}` : null,
                c.fechaComparendo || c.fecha ? `Fecha: ${c.fechaComparendo || c.fecha}` : null,
                `Valor: ${formatCOP(amount)}`,
                c.estado ? `Estado: ${c.estado}` : null,
                c.secretaria || c.organismo ? `Organismo: ${c.secretaria || c.organismo}` : null,
              ].filter(Boolean).join("\n"),
              sourceUrl: `https://consulta.simit.org.co/Simit/indexA.jsp`,
              rawData: c,
              remediation: "Pay outstanding fines at your local transit office or through the SIMIT online portal.",
            });
          }

          findings.unshift({
            category: "exposure",
            severity: totalAmount > 2000000 ? "high" : "medium",
            title: `SIMIT: ${totalFines} traffic fine(s) — ${formatCOP(totalAmount)} total`,
            description: `Found ${totalFines} traffic fine(s) totaling ${formatCOP(totalAmount)} for CC: ${cedula}`,
            sourceUrl: "https://consulta.simit.org.co",
            rawData: { totalFines, totalAmount, cedula },
          });
        } else if (data.deudor === false || (isArray && comparendos.length === 0)) {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "SIMIT: No traffic fines",
            description: `No outstanding traffic fines found in SIMIT for CC: ${cedula}. Clean driving record.`,
            sourceUrl: "https://consulta.simit.org.co",
            rawData: { searched: cedula, deudor: false },
          });
        } else {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "SIMIT: Manual lookup required",
            description: `Could not parse SIMIT response. Check manually at consulta.simit.org.co with CC: ${cedula}`,
            sourceUrl: "https://consulta.simit.org.co/Simit/indexA.jsp",
            rawData: { searched: cedula, response: typeof data === "string" ? data.substring(0, 500) : data },
            remediation: "Visit https://consulta.simit.org.co and enter your cédula to check traffic fines.",
          });
        }
      } else {
        findings.push({
          category: "exposure",
          severity: "info",
          title: "SIMIT: Manual lookup required",
          description: `Could not query SIMIT. Check manually at consulta.simit.org.co with CC: ${cedula}`,
          sourceUrl: "https://consulta.simit.org.co/Simit/indexA.jsp",
          rawData: { error: res.error || `HTTP ${res.status}`, searched: cedula },
          remediation: "Visit https://consulta.simit.org.co and enter your cédula to check traffic fines.",
        });
      }
    } catch (err) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "SIMIT: Lookup error",
        description: `Error querying SIMIT: ${err.message}`,
        rawData: { error: err.message },
      });
    } finally {
      release();
    }

    return findings;
  },
};
