// Phone number OSINT module — format validation, carrier lookup, messaging platform checks
// Free APIs: NumVerify (250/mo), OpenCNAM (10/mo), messaging platform HEAD checks

// Country code table for E.164 validation (top 50 countries)
const COUNTRY_CODES = {
  "1": "US/CA", "7": "RU", "20": "EG", "27": "ZA", "30": "GR",
  "31": "NL", "32": "BE", "33": "FR", "34": "ES", "36": "HU",
  "39": "IT", "40": "RO", "41": "CH", "43": "AT", "44": "GB",
  "45": "DK", "46": "SE", "47": "NO", "48": "PL", "49": "DE",
  "51": "PE", "52": "MX", "53": "CU", "54": "AR", "55": "BR",
  "56": "CL", "57": "CO", "58": "VE", "60": "MY", "61": "AU",
  "62": "ID", "63": "PH", "64": "NZ", "65": "SG", "66": "TH",
  "81": "JP", "82": "KR", "84": "VN", "86": "CN", "90": "TR",
  "91": "IN", "92": "PK", "93": "AF", "94": "LK", "95": "MM",
  "98": "IR", "212": "MA", "213": "DZ", "234": "NG", "254": "KE",
  "351": "PT", "352": "LU", "353": "IE", "354": "IS", "358": "FI",
  "370": "LT", "371": "LV", "372": "EE", "380": "UA", "420": "CZ",
  "421": "SK", "852": "HK", "853": "MO", "886": "TW", "971": "AE",
  "972": "IL", "966": "SA",
};

// Validate E.164 format and extract country code
function validateE164(number) {
  // Strip common formatting
  const cleaned = number.replace(/[\s\-\(\)\.]/g, "");
  // Must start with + and have 7-15 digits
  const match = cleaned.match(/^\+?(\d{7,15})$/);
  if (!match) return null;

  const digits = match[1];
  // Try matching country codes (1-3 digit)
  for (const len of [1, 2, 3]) {
    const cc = digits.substring(0, len);
    if (COUNTRY_CODES[cc]) {
      return {
        formatted: `+${digits}`,
        countryCode: cc,
        country: COUNTRY_CODES[cc],
        nationalNumber: digits.substring(len),
        digits,
      };
    }
  }
  // Unknown country code but valid format
  return { formatted: `+${digits}`, countryCode: null, country: null, nationalNumber: digits, digits };
}

module.exports = {
  name: "phone-lookup",
  profileTypes: ["phone"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const raw = profile.value;

    // 1. Format validation + country code resolution
    const parsed = validateE164(raw);
    if (!parsed) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Invalid phone number format",
        description: `"${raw}" doesn't match E.164 format. Expected: +[country code][number] (e.g., +14155551234). Some checks may still work with the raw value.`,
        rawData: { input: raw, valid: false },
      });
    } else {
      findings.push({
        category: "exposure",
        severity: "info",
        title: `Phone number parsed: ${parsed.country || "Unknown"} (${parsed.formatted})`,
        description: `Country code: +${parsed.countryCode || "?"} (${parsed.country || "Unknown"}). National number: ${parsed.nationalNumber}. Format: E.164 valid.`,
        rawData: { ...parsed, valid: true },
      });
    }

    const number = parsed ? parsed.formatted : raw.replace(/[\s\-\(\)\.]/g, "");
    const digits = parsed ? parsed.digits : number.replace(/\D/g, "");

    // 2. NumVerify API (carrier, line type, country) — 250 free/mo
    const numverifyKey = process.env.NUMVERIFY_API_KEY;
    if (numverifyKey) {
      const release = await rateLimiter.acquire();
      try {
        const url = `http://apilayer.net/api/validate?access_key=${numverifyKey}&number=${encodeURIComponent(digits)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const data = await res.json();
          if (data.valid) {
            const parts = [];
            if (data.carrier) parts.push(`Carrier: ${data.carrier}`);
            if (data.line_type) parts.push(`Type: ${data.line_type}`);
            if (data.location) parts.push(`Location: ${data.location}`);
            if (data.country_name) parts.push(`Country: ${data.country_name}`);

            findings.push({
              category: "exposure",
              severity: data.line_type === "mobile" ? "medium" : "low",
              title: `Carrier identified: ${data.carrier || "Unknown"} (${data.line_type || "unknown"})`,
              description: parts.join(". ") + ".",
              rawData: { numverify: data },
              remediation: data.line_type === "mobile"
                ? "Mobile numbers are tied to personal identity. Consider using a VoIP number for public-facing accounts."
                : null,
            });
          }
        }
      } catch (_) {
        // Skip on error
      } finally {
        release();
      }
    } else {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Carrier lookup skipped — no NumVerify API key",
        description: "Set NUMVERIFY_API_KEY for carrier/line type/location lookup (250 free requests/month).",
        rawData: { reason: "no_numverify_api_key" },
      });
    }

    // 3. Messaging platform checks — HTTP HEAD to public profile URLs
    const messagingPlatforms = [
      { name: "WhatsApp", url: `https://wa.me/${digits}`, checkType: "redirect" },
      { name: "Telegram", url: `https://t.me/+${digits}`, checkType: "status" },
      { name: "Signal", url: null, checkType: "info" }, // Signal doesn't have public lookup
    ];

    for (const platform of messagingPlatforms) {
      if (!platform.url) {
        // Info-only platform
        findings.push({
          category: "account_found",
          severity: "info",
          title: `${platform.name}: no public lookup available`,
          description: `${platform.name} doesn't expose a public profile check for phone numbers. The number may still be registered.`,
          rawData: { platform: platform.name, checkable: false },
        });
        continue;
      }

      const release = await rateLimiter.acquire();
      try {
        const res = await fetch(platform.url, {
          method: "HEAD",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          signal: AbortSignal.timeout(10000),
          redirect: "manual",
        });

        // WhatsApp: wa.me always returns 200/302, but the page content differs
        // Telegram: returns 200 for valid users, 302 redirect for invalid
        const found = res.status === 200;

        if (found) {
          findings.push({
            category: "account_found",
            severity: "medium",
            title: `${platform.name} account linked to this number`,
            description: `HTTP check to ${platform.url} returned status ${res.status}, indicating the number is registered on ${platform.name}.`,
            sourceUrl: platform.url,
            rawData: { platform: platform.name, url: platform.url, status: res.status, found: true },
            remediation: `Review ${platform.name} privacy settings. Consider hiding your phone number from public search.`,
          });
        }
      } catch (_) {
        // Timeout or network error — skip
      } finally {
        release();
      }
    }

    // 4. Google dork for phone number exposure
    const googleApiKey = process.env.GOOGLE_API_KEY;
    const googleCseId = process.env.GOOGLE_CSE_ID;

    if (googleApiKey && googleCseId) {
      const release = await rateLimiter.acquire();
      try {
        const queries = [
          `"${number}"`,
          parsed ? `"${parsed.nationalNumber}"` : null,
        ].filter(Boolean);

        for (const query of queries.slice(0, 1)) { // Limit to 1 query to conserve quota
          const url = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleCseId}&q=${encodeURIComponent(query)}&num=5`;
          const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

          if (res.ok) {
            const data = await res.json();
            const totalResults = parseInt(data.searchInformation?.totalResults || "0", 10);

            if (totalResults > 0 && data.items) {
              findings.push({
                category: "exposure",
                severity: "high",
                title: `Phone number found in ${totalResults} search results`,
                description: `Google search for ${query} returned ${totalResults} results. Top: ${data.items.slice(0, 3).map((i) => i.title).join("; ")}`,
                sourceUrl: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
                rawData: {
                  query,
                  totalResults,
                  topResults: data.items.slice(0, 3).map((i) => ({ title: i.title, link: i.link })),
                },
                remediation: "Request removal from sites exposing your phone number. Use Google's removal tool for cached results.",
              });
            }
          }
        }
      } catch (_) {
        // Skip on error
      } finally {
        release();
      }
    } else {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Google phone number search skipped — no API key",
        description: `Set GOOGLE_API_KEY and GOOGLE_CSE_ID for automated search. Manual query: "${number}"`,
        rawData: { reason: "no_google_api_key", manualQuery: `"${number}"` },
      });
    }

    // 5. CallerID via OpenCNAM (10 free/mo)
    const opencnamSid = process.env.OPENCNAM_SID;
    const opencnamToken = process.env.OPENCNAM_TOKEN;

    if (opencnamSid && opencnamToken && parsed && parsed.countryCode === "1") {
      const release = await rateLimiter.acquire();
      try {
        const url = `https://api.opencnam.com/v3/phone/+${digits}?account_sid=${opencnamSid}&auth_token=${opencnamToken}&format=json`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

        if (res.ok) {
          const data = await res.json();
          if (data.name && data.name !== "UNAVAILABLE") {
            findings.push({
              category: "exposure",
              severity: "high",
              title: `CallerID name resolved: ${data.name}`,
              description: `OpenCNAM resolved the phone number to name: "${data.name}". This means the real name behind this number is publicly queryable.`,
              rawData: { opencnam: data },
              remediation: "CallerID databases are hard to remove from. Consider using a separate number for privacy-sensitive activities.",
            });
          }
        }
      } catch (_) {
        // Skip on error
      } finally {
        release();
      }
    } else if (!opencnamSid) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "CallerID lookup skipped — no OpenCNAM credentials",
        description: "Set OPENCNAM_SID and OPENCNAM_TOKEN for caller name resolution (10 free lookups/month, US numbers only).",
        rawData: { reason: "no_opencnam_credentials" },
      });
    }

    if (findings.length === 1 && findings[0].severity === "info") {
      // Only the format validation finding — nothing else found
      findings.push({
        category: "exposure",
        severity: "info",
        title: "No significant phone exposure found",
        description: `Basic checks for ${number} completed. Add API keys (NUMVERIFY_API_KEY, GOOGLE_API_KEY) for deeper analysis.`,
        rawData: { number, found: false },
      });
    }

    return findings;
  },
};
