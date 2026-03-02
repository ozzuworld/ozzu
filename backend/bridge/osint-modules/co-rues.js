// Colombian OSINT: RUES (Registro Único Empresarial y Social) — Business registry lookup
// Source: rues.org.co — has internal API endpoints, no captcha
const { validateCedula, validateNIT, safeFetch, CO_HEADERS } = require("./co-utils");

module.exports = {
  name: "co-rues",
  profileTypes: ["nit", "cedula"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const value = profile.value;

    // RUES uses a token-based API internally
    const release = await rateLimiter.acquire();
    let token = null;
    try {
      // Step 1: Get RUES session token
      const tokenRes = await safeFetch("https://www.rues.org.co/RM", {
        method: "GET",
      });
      if (tokenRes.ok && typeof tokenRes.body === "string") {
        const tokenMatch = tokenRes.body.match(/token['":\s]+['"]([^'"]+)['"]/i) ||
          tokenRes.body.match(/antiForgeryToken['":\s]+['"]([^'"]+)['"]/i);
        if (tokenMatch) token = tokenMatch[1];
      }
    } catch (e) {
      // Continue without token
    } finally {
      release();
    }

    // Step 2: Search by NIT or cédula number
    const release2 = await rateLimiter.acquire();
    try {
      const searchQuery = profile.profile_type === "nit" ? validateNIT(value) || value : value;
      const searchUrl = "https://www.rues.org.co/RM/Search";
      const formData = new URLSearchParams();
      formData.append("query", searchQuery);
      formData.append("type", profile.profile_type === "nit" ? "nit" : "name");
      if (token) formData.append("__RequestVerificationToken", token);

      const res = await safeFetch(searchUrl, {
        method: "POST",
        headers: {
          ...CO_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://www.rues.org.co/RM",
        },
        body: formData.toString(),
      });

      if (res.ok && typeof res.body === "string") {
        // Parse HTML response for company listings
        const companies = parseRuesResults(res.body);

        if (companies.length > 0) {
          for (const company of companies.slice(0, 10)) {
            findings.push({
              category: "exposure",
              severity: company.status === "ACTIVA" ? "medium" : "low",
              title: `RUES: ${company.name}`,
              description: [
                `Razón Social: ${company.name}`,
                company.nit ? `NIT: ${company.nit}` : null,
                company.status ? `Estado: ${company.status}` : null,
                company.chamber ? `Cámara: ${company.chamber}` : null,
                company.city ? `Ciudad: ${company.city}` : null,
                company.registration ? `Matrícula: ${company.registration}` : null,
              ].filter(Boolean).join("\n"),
              sourceUrl: `https://www.rues.org.co/RM`,
              rawData: company,
              remediation: company.status === "ACTIVA"
                ? "Active business registration found. Review if this company should be publicly listed."
                : "Inactive/cancelled registration. No action needed.",
            });
          }

          findings.unshift({
            category: "exposure",
            severity: companies.length >= 3 ? "high" : "medium",
            title: `RUES: ${companies.length} business registration(s) found`,
            description: `Found ${companies.length} business registration(s) in RUES for this ${profile.profile_type}.`,
            rawData: { totalCompanies: companies.length, activeCount: companies.filter(c => c.status === "ACTIVA").length },
          });
        } else {
          findings.push({
            category: "exposure",
            severity: "info",
            title: "RUES: No business registrations found",
            description: `No companies or business registrations found in RUES for ${profile.profile_type}: ${value}`,
            sourceUrl: "https://www.rues.org.co/RM",
            rawData: { searched: value, type: profile.profile_type },
          });
        }
      } else {
        // Fallback: manual lookup
        findings.push({
          category: "exposure",
          severity: "info",
          title: "RUES: Manual lookup required",
          description: `Could not automatically query RUES. Search manually at rues.org.co with ${profile.profile_type}: ${value}`,
          sourceUrl: "https://www.rues.org.co/RM",
          rawData: { error: res.error || `HTTP ${res.status}`, searched: value },
          remediation: "Visit https://www.rues.org.co/RM and search manually.",
        });
      }
    } catch (err) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "RUES: Lookup error",
        description: `Error querying RUES: ${err.message}`,
        sourceUrl: "https://www.rues.org.co/RM",
        rawData: { error: err.message },
      });
    } finally {
      release2();
    }

    return findings;
  },
};

function parseRuesResults(html) {
  const companies = [];
  // Match table rows or result cards from RUES HTML
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowPattern.exec(html)) !== null) {
    const row = match[1];
    const cells = [];
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(row)) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, "").trim());
    }
    if (cells.length >= 3 && cells[0] && /\d/.test(cells[0] + cells[1])) {
      companies.push({
        registration: cells[0] || null,
        name: cells[1] || cells[0],
        nit: cells[2] || null,
        status: (cells[3] || "").toUpperCase() || null,
        chamber: cells[4] || null,
        city: cells[5] || null,
      });
    }
  }
  return companies;
}
