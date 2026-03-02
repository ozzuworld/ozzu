// Colombian OSINT: Composite Risk Score
// Post-scan scoring across all CO modules — legal, financial, identity, exposure
const db = require("../db");

module.exports = {
  name: "co-risk-score",
  profileTypes: ["cedula", "nit"],

  async scan(profile, rateLimiter) {
    const findings = [];

    // Fetch all findings from this profile's latest scan (other CO modules ran first)
    let allFindings = [];
    try {
      const res = await db.query(
        `SELECT module, category, severity, title, raw_data
         FROM osint_findings
         WHERE profile_id = $1 AND module LIKE 'co-%' AND module != 'co-risk-score'
         ORDER BY created_at DESC LIMIT 200`,
        [profile.id]
      );
      allFindings = res.rows || [];
    } catch {
      // If we can't query, still produce a stub
    }

    if (allFindings.length === 0) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "CO Risk Score: No Colombian data to score",
        description: "No Colombian database findings available for risk scoring.",
        rawData: { score: null },
      });
      return findings;
    }

    // ── Score Components ──
    const scores = {
      legal_risk: 0,      // Policía + Procuraduría + Contraloría + Rama Judicial
      financial_risk: 0,   // SIMIT fines + SECOP irregularities + DIAN status
      identity_risk: 0,    // Registraduría status + REDAM listing
      exposure_level: 0,   // How much data is accessible across databases
    };

    let modulesChecked = 0;
    let modulesWithData = 0;
    const moduleResults = {};

    for (const f of allFindings) {
      const mod = f.module;
      const sev = f.severity;
      const raw = typeof f.raw_data === "string" ? JSON.parse(f.raw_data) : (f.raw_data || {});

      if (!moduleResults[mod]) moduleResults[mod] = [];
      moduleResults[mod].push({ severity: sev, raw });

      // ── Legal Risk ──
      if (mod === "co-policia") {
        modulesChecked++;
        if (sev === "critical") { scores.legal_risk += 40; modulesWithData++; }
        else if (sev !== "info" || !raw.clean) modulesWithData++;
      }
      if (mod === "co-procuraduria") {
        modulesChecked++;
        if (sev === "critical") { scores.legal_risk += 30; modulesWithData++; }
        else if (sev !== "info" || !raw.clean) modulesWithData++;
      }
      if (mod === "co-contraloria") {
        modulesChecked++;
        if (sev === "critical") { scores.legal_risk += 25; modulesWithData++; }
        else if (sev !== "info" || !raw.reported === false) modulesWithData++;
      }
      if (mod === "co-rama-judicial") {
        modulesChecked++;
        if (sev === "critical" || sev === "high") {
          const caseCount = raw.total || raw.activeCount || 1;
          scores.legal_risk += Math.min(30, caseCount * 5);
          modulesWithData++;
        } else if (sev === "medium") {
          scores.legal_risk += 10;
          modulesWithData++;
        }
      }

      // ── Financial Risk ──
      if (mod === "co-simit") {
        modulesChecked++;
        if (sev === "high" || sev === "medium") {
          const fineCount = raw.totalFines || raw.fines?.length || 1;
          scores.financial_risk += Math.min(25, fineCount * 3);
          modulesWithData++;
        }
      }
      if (mod === "co-secop") {
        modulesChecked++;
        if (sev !== "info") {
          scores.financial_risk += 5; // Having contracts is neutral, not necessarily risky
          modulesWithData++;
        }
      }
      if (mod === "co-dian") {
        modulesChecked++;
        if (raw.status && raw.status !== "ACTIVO") {
          scores.financial_risk += 15;
        }
        if (sev !== "info") modulesWithData++;
      }

      // ── Identity Risk ──
      if (mod === "co-registraduria") {
        modulesChecked++;
        if (raw.estado === "ROBADO" || raw.estado === "SUSPENDIDO") {
          scores.identity_risk += 40;
          modulesWithData++;
        } else if (raw.vigente === false) {
          scores.identity_risk += 20;
          modulesWithData++;
        } else if (sev !== "info") {
          modulesWithData++;
        }
      }
      if (mod === "co-redam") {
        modulesChecked++;
        if (raw.listed === true) {
          scores.identity_risk += 25;
          modulesWithData++;
        }
      }

      // ── Exposure Level ──
      if (sev !== "info" && !raw.stub) {
        scores.exposure_level += 5;
      }
    }

    // Normalize each component to 0-100
    scores.legal_risk = Math.min(100, scores.legal_risk);
    scores.financial_risk = Math.min(100, scores.financial_risk);
    scores.identity_risk = Math.min(100, scores.identity_risk);
    scores.exposure_level = Math.min(100, scores.exposure_level);

    // Composite score (weighted average)
    const composite = Math.round(
      scores.legal_risk * 0.35 +
      scores.financial_risk * 0.25 +
      scores.identity_risk * 0.25 +
      scores.exposure_level * 0.15
    );

    // Determine overall risk level
    let riskLevel, severity;
    if (composite >= 70) { riskLevel = "CRITICAL"; severity = "critical"; }
    else if (composite >= 45) { riskLevel = "HIGH"; severity = "high"; }
    else if (composite >= 20) { riskLevel = "MEDIUM"; severity = "medium"; }
    else if (composite >= 5) { riskLevel = "LOW"; severity = "low"; }
    else { riskLevel = "CLEAN"; severity = "info"; }

    // Build module-by-module status
    const checkedModules = Object.keys(moduleResults);
    const allCOModules = [
      "co-adres", "co-simit", "co-rues", "co-sigep", "co-dian",
      "co-registraduria", "co-redam", "co-secop",
      "co-procuraduria", "co-contraloria", "co-policia", "co-rama-judicial",
      "co-fiscalia", "co-libreta-militar",
    ];
    const moduleStatus = allCOModules.map(m => {
      const results = moduleResults[m];
      if (!results) return `  ${m}: not checked`;
      const maxSev = results.reduce((max, r) => {
        const order = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
        return (order[r.severity] || 0) > (order[max] || 0) ? r.severity : max;
      }, "info");
      const icon = maxSev === "critical" ? "!!!" : maxSev === "high" ? "!!" : maxSev === "medium" ? "!" : "ok";
      return `  ${m}: ${icon} (${maxSev})`;
    }).join("\n");

    findings.push({
      category: "metadata",
      severity,
      title: `CO Risk Score: ${composite}/100 — ${riskLevel}`,
      description: [
        `Colombian OSINT Composite Risk Score: ${composite}/100`,
        `Risk Level: ${riskLevel}`,
        ``,
        `Components:`,
        `  Legal Risk: ${scores.legal_risk}/100 (Policía, Procuraduría, Contraloría, Rama Judicial)`,
        `  Financial Risk: ${scores.financial_risk}/100 (SIMIT, SECOP, DIAN)`,
        `  Identity Risk: ${scores.identity_risk}/100 (Registraduría, REDAM)`,
        `  Exposure Level: ${scores.exposure_level}/100 (data accessibility)`,
        ``,
        `Databases checked: ${checkedModules.length}/${allCOModules.length}`,
        `Databases with findings: ${modulesWithData}`,
        ``,
        `Module Status:`,
        moduleStatus,
      ].join("\n"),
      sourceUrl: null,
      rawData: {
        composite,
        riskLevel,
        components: scores,
        modulesChecked: checkedModules.length,
        modulesWithData,
        moduleStatus: moduleResults,
      },
    });

    return findings;
  },
};
