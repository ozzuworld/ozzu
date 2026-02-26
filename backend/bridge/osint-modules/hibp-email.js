// HIBP v3 Email Breach Lookup — checks if an email appears in known data breaches
// Requires a HIBP API key ($3.50/month) — set HIBP_API_KEY in environment
// If no API key is configured, the module gracefully skips with an info finding

module.exports = {
  name: "hibp-email",
  profileTypes: ["email"],

  async scan(profile, rateLimiter) {
    const apiKey = process.env.HIBP_API_KEY;
    const email = profile.value.toLowerCase().trim();

    if (!apiKey) {
      return [{
        category: "breach",
        severity: "info",
        title: "HIBP email breach check skipped — no API key",
        description: "The Have I Been Pwned email breach lookup requires an API key ($3.50/month at haveibeenpwned.com/API/Key). Set HIBP_API_KEY in your environment to enable this check.",
        sourceUrl: "https://haveibeenpwned.com/API/Key",
        rawData: { reason: "no_api_key" },
        remediation: "Get an API key from https://haveibeenpwned.com/API/Key and set HIBP_API_KEY environment variable.",
      }];
    }

    const findings = [];

    // 1. Check breaches
    const release = await rateLimiter.acquire();
    try {
      const res = await fetch(
        `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`,
        {
          headers: {
            "hibp-api-key": apiKey,
            "User-Agent": "ozzu-osint-scanner",
          },
          signal: AbortSignal.timeout(15000),
        }
      );

      if (res.status === 200) {
        const breaches = await res.json();

        // Overall breach summary
        const sensitive = breaches.filter((b) => b.IsSensitive);
        const verified = breaches.filter((b) => b.IsVerified);
        const total = breaches.length;

        let severity;
        if (total >= 10) severity = "critical";
        else if (total >= 5) severity = "high";
        else if (total >= 2) severity = "medium";
        else severity = "low";

        findings.push({
          category: "breach",
          severity,
          title: `Email found in ${total} data breach${total !== 1 ? "es" : ""}`,
          description: `This email appears in ${total} known data breaches (${verified.length} verified, ${sensitive.length} sensitive). Breached sites: ${breaches.map((b) => b.Name).join(", ")}.`,
          sourceUrl: `https://haveibeenpwned.com/account/${encodeURIComponent(email)}`,
          rawData: {
            total,
            verified: verified.length,
            sensitive: sensitive.length,
            breaches: breaches.map((b) => ({
              name: b.Name,
              domain: b.Domain,
              date: b.BreachDate,
              count: b.PwnCount,
              dataClasses: b.DataClasses,
              isVerified: b.IsVerified,
              isSensitive: b.IsSensitive,
            })),
          },
          remediation: `Change passwords for all breached services. Enable 2FA where available. Check each breach's exposed data types to understand what was compromised.`,
        });

        // Individual breach details for critical/sensitive ones
        for (const breach of breaches) {
          if (breach.IsSensitive || breach.PwnCount > 1000000) {
            const dataTypes = breach.DataClasses ? breach.DataClasses.join(", ") : "unknown";
            findings.push({
              category: "breach",
              severity: breach.IsSensitive ? "high" : "medium",
              title: `${breach.Name}: ${breach.PwnCount.toLocaleString()} accounts (${breach.BreachDate})`,
              description: `Breach of ${breach.Domain || breach.Name} on ${breach.BreachDate}. ${breach.PwnCount.toLocaleString()} accounts affected. Exposed data: ${dataTypes}.${breach.IsSensitive ? " ⚠️ This is marked as a sensitive breach." : ""}${breach.Description ? "\n\n" + breach.Description.replace(/<[^>]*>/g, "") : ""}`,
              sourceUrl: `https://haveibeenpwned.com/breach/${breach.Name}`,
              rawData: breach,
              remediation: `Change your password for ${breach.Domain || breach.Name} immediately. If you reused this password elsewhere, change it there too.`,
            });
          }
        }
      } else if (res.status === 404) {
        // Not found in any breaches — good news
        findings.push({
          category: "breach",
          severity: "info",
          title: "Email not found in any known breaches",
          description: "This email address was not found in the Have I Been Pwned breach database. This doesn't guarantee the email hasn't been compromised in unreported breaches.",
          sourceUrl: `https://haveibeenpwned.com/account/${encodeURIComponent(email)}`,
          rawData: { breaches: 0 },
          remediation: null,
        });
      } else if (res.status === 401) {
        findings.push({
          category: "breach",
          severity: "info",
          title: "HIBP API key invalid",
          description: "The HIBP API key is invalid or expired. Please update the HIBP_API_KEY environment variable.",
          rawData: { status: 401 },
          remediation: "Update HIBP_API_KEY with a valid key from https://haveibeenpwned.com/API/Key",
        });
      } else if (res.status === 429) {
        findings.push({
          category: "breach",
          severity: "info",
          title: "HIBP rate limited — try again later",
          description: "The HIBP API rate limit was exceeded. Wait a moment and re-scan.",
          rawData: { status: 429 },
          remediation: null,
        });
      }
    } catch (err) {
      findings.push({
        category: "breach",
        severity: "info",
        title: "HIBP breach check failed",
        description: `Could not reach the HIBP API: ${err.message}`,
        rawData: { error: err.message },
        remediation: null,
      });
    } finally {
      release();
    }

    // 2. Check pastes (also requires API key)
    const release2 = await rateLimiter.acquire();
    try {
      const res = await fetch(
        `https://haveibeenpwned.com/api/v3/pasteaccount/${encodeURIComponent(email)}`,
        {
          headers: {
            "hibp-api-key": apiKey,
            "User-Agent": "ozzu-osint-scanner",
          },
          signal: AbortSignal.timeout(15000),
        }
      );

      if (res.status === 200) {
        const pastes = await res.json();
        if (pastes.length > 0) {
          findings.push({
            category: "exposure",
            severity: pastes.length >= 5 ? "high" : "medium",
            title: `Email found in ${pastes.length} paste${pastes.length !== 1 ? "s" : ""}`,
            description: `This email was found in ${pastes.length} paste(s) on sites like Pastebin. Pastes often contain leaked credentials or data dumps. Sources: ${pastes.map((p) => `${p.Source || "Unknown"} (${p.Date || "undated"})`).join(", ")}.`,
            rawData: { pastes: pastes.map((p) => ({ source: p.Source, id: p.Id, date: p.Date, emailCount: p.EmailCount })) },
            remediation: "Change the password associated with this email. Monitor for unauthorized access to accounts using this email.",
          });
        }
      }
      // 404 = no pastes, which is fine
    } catch (_) {
      // Network error — skip paste check
    } finally {
      release2();
    }

    return findings;
  },
};
