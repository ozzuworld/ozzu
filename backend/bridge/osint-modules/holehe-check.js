// Holehe email registration check — 120+ sites via password-reset endpoints
// Wraps: /opt/osint-venv/bin/python3 -c "import holehe..."
const cli = require("./cli-runner");

const PYTHON_BIN = "/opt/osint-venv/bin/python3";

module.exports = {
  name: "holehe-check",
  profileTypes: ["email"],

  async scan(profile, rateLimiter) {
    const findings = [];

    if (!cli.binaryExists(PYTHON_BIN)) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "Holehe unavailable — Python venv not installed",
        rawData: { reason: "no_python_venv" },
      });
      return findings;
    }

    const release = await rateLimiter.acquire();
    try {
      // Holehe's best structured output is via Python API
      const script = `
import asyncio, json, sys
try:
    import holehe.core as core
except ImportError:
    print("[]")
    sys.exit(0)

async def run():
    out = []
    await core.holehe("${profile.value.replace(/"/g, '\\"')}", out)
    print(json.dumps(out))

asyncio.run(run())
`.trim();

      const stdout = await cli.run(PYTHON_BIN, ["-c", script], {
        timeout: 90000,
        allowNonZero: true,
      });

      let results = [];
      try { results = JSON.parse(stdout.trim()); } catch {}

      let registered = 0;
      for (const r of results) {
        if (!r || !r.name) continue;
        if (r.rateLimit) continue; // Skip rate-limited results

        if (r.exists) {
          registered++;
          const desc = [];
          if (r.emailrecovery) desc.push(`Recovery email: ${r.emailrecovery}`);
          if (r.phoneNumber) desc.push(`Recovery phone: ${r.phoneNumber}`);
          if (r.others) desc.push(`Other: ${JSON.stringify(r.others)}`);

          findings.push({
            category: "account_found",
            severity: "medium",
            title: `Email registered on ${r.name}`,
            description: desc.join("\n") || `Account exists on ${r.name}`,
            rawData: {
              platform: r.name,
              found: true,
              emailRecovery: r.emailrecovery || null,
              phoneRecovery: r.phoneNumber || null,
              source: "holehe",
            },
          });
        }
      }

      const checked = results.filter((r) => !r.rateLimit).length;
      const rateLimited = results.filter((r) => r.rateLimit).length;

      findings.push({
        category: "metadata",
        severity: registered > 0 ? "medium" : "info",
        title: `Holehe: ${registered} registration(s) found on ${checked} sites`,
        description: rateLimited > 0 ? `${rateLimited} site(s) rate-limited — retry later` : "",
        rawData: { totalChecked: checked, totalFound: registered, rateLimited, source: "holehe" },
      });
    } catch (err) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "Holehe scan error",
        description: err.message,
        rawData: { error: err.message, source: "holehe" },
      });
    } finally {
      release();
    }

    return findings;
  },
};
