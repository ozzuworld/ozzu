// Maigret username enumeration — 3000+ sites, auto-extracts PII
// Wraps: /opt/osint-venv/bin/maigret
const cli = require("./cli-runner");

const MAIGRET_BIN = "/opt/osint-venv/bin/maigret";

module.exports = {
  name: "maigret-enum",
  profileTypes: ["username"],

  async scan(profile, rateLimiter) {
    const findings = [];

    if (!cli.binaryExists(MAIGRET_BIN)) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "Maigret unavailable — not installed in container",
        rawData: { reason: "no_maigret" },
      });
      return findings;
    }

    const release = await rateLimiter.acquire();
    const outFile = cli.tempPath("maigret", "json");
    try {
      const results = await cli.runNdjson(MAIGRET_BIN, [
        profile.value,
        "-J", "ndjson",
        "--top-sites", "500",
        "--timeout", "10",
        "--no-color",
        "-o", outFile,
      ], { timeout: 180000, allowNonZero: true });

      let claimed = 0;
      for (const r of results) {
        if (!r || !r.siteName) continue;
        const isClaimed = r.status === "Claimed" || r.http_status === 200;
        if (!isClaimed) continue;
        claimed++;

        findings.push({
          category: "account_found",
          severity: "medium",
          title: `Account found: ${r.siteName}`,
          description: r.url_user || r.url_main || "",
          sourceUrl: r.url_user || r.url_main,
          rawData: {
            platform: r.siteName,
            url: r.url_user || r.url_main,
            found: true,
            status: r.http_status,
            source: "maigret",
            // PII extraction (maigret auto-extracts from pages)
            ids: r.ids || null,
            tags: r.tags || null,
          },
        });
      }

      findings.push({
        category: "metadata",
        severity: claimed > 0 ? "medium" : "info",
        title: `Maigret: ${claimed} account(s) found across 500 top sites`,
        rawData: { totalChecked: 500, totalFound: claimed, source: "maigret" },
      });
    } catch (err) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "Maigret scan error",
        description: err.message,
        rawData: { error: err.message, source: "maigret" },
      });
    } finally {
      release();
      try { require("fs").unlinkSync(outFile); } catch {}
    }

    return findings;
  },
};
