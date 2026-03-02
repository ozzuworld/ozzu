// Colombian OSINT: SIMIT (Sistema Integrado de Información sobre Multas y Sanciones por Infracciones de Tránsito)
// Source: SIMIT has been migrated to fcm.org.co and old APIs are offline (2025+).
// The old consulta.simit.org.co is dead, simit.org.co redirects to fcm.org.co.
// This module tries known endpoints and falls back to manual lookup instructions.
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
      // Try the legacy endpoint (may still work intermittently)
      const url = `https://consulta.simit.org.co/Simit/verificar/multas/CC/${cedula}`;
      const res = await safeFetch(url, {
        method: "GET",
        headers: {
          ...CO_HEADERS,
          Accept: "application/json",
          Referer: "https://consulta.simit.org.co/",
        },
      }, 10000);

      if (res.ok && res.body) {
        let data = res.body;
        if (typeof data === "string") {
          try { data = JSON.parse(data); } catch { /* not JSON */ }
        }

        if (typeof data === "object" && !Array.isArray(data)) {
          const comparendos = data.comparendos || data.data || data.multas || [];
          if (Array.isArray(comparendos) && comparendos.length > 0) {
            let totalAmount = 0;
            for (const c of comparendos) {
              totalAmount += parseFloat(c.valor || c.valorMulta || c.totalPagar || 0);
            }

            findings.push({
              category: "exposure",
              severity: totalAmount > 2000000 ? "high" : "medium",
              title: `SIMIT: ${comparendos.length} traffic fine(s) — ${formatCOP(totalAmount)} total`,
              description: [
                `Found ${comparendos.length} traffic fine(s) totaling ${formatCOP(totalAmount)} for CC: ${cedula}`,
                "",
                ...comparendos.slice(0, 5).map((c, i) => {
                  const amount = parseFloat(c.valor || c.valorMulta || c.totalPagar || 0);
                  return `${i + 1}. ${c.codigoInfraccion || "N/A"} — ${formatCOP(amount)} (${c.fechaComparendo || c.fecha || "N/A"})`;
                }),
              ].join("\n"),
              sourceUrl: "https://www.fcm.org.co/simit/",
              rawData: { totalFines: comparendos.length, totalAmount, cedula, fines: comparendos.slice(0, 10) },
              remediation: "Pay outstanding fines at your local transit office or through the SIMIT online portal at fcm.org.co/simit/",
            });
            return findings;
          } else if (data.deudor === false) {
            findings.push({
              category: "exposure",
              severity: "info",
              title: "SIMIT: No traffic fines",
              description: `No outstanding traffic fines found in SIMIT for CC: ${cedula}. Clean driving record.`,
              sourceUrl: "https://www.fcm.org.co/simit/",
              rawData: { searched: cedula, deudor: false },
            });
            return findings;
          }
        }
      }

      // Old API didn't work — provide manual instructions
      findings.push({
        category: "exposure",
        severity: "info",
        title: "SIMIT: Manual lookup required",
        description: [
          `The SIMIT consultation system has been migrated (old API is offline since 2025).`,
          `Traffic fine lookup for CC: ${cedula} must be done manually.`,
          `Traffic fines affect driver's license renewal and vehicle registration.`,
        ].join("\n"),
        sourceUrl: "https://www.fcm.org.co/simit/",
        rawData: { searched: cedula, reason: "api_migrated", error: res.error || `HTTP ${res.status}` },
        remediation: "Visit https://www.fcm.org.co/simit/ to check traffic fines. Enter cédula and complete verification.",
      });
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
