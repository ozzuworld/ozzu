// Email domain intelligence module — DNS/MX record analysis
// Free — uses Node's built-in dns module, no API keys needed

const dns = require("dns").promises;

// Known disposable/temporary email providers
const DISPOSABLE_DOMAINS = new Set([
  "tempmail.com", "guerrillamail.com", "mailinator.com", "throwaway.email",
  "10minutemail.com", "trashmail.com", "yopmail.com", "sharklasers.com",
  "grr.la", "guerrillamailblock.com", "pokemail.net", "spam4.me",
  "dispostable.com", "maildrop.cc", "fakeinbox.com", "mailnesia.com",
  "tempr.email", "discard.email", "discardmail.com", "emailondeck.com",
]);

// Known privacy-focused email providers
const PRIVACY_PROVIDERS = new Set([
  "protonmail.com", "proton.me", "tutanota.com", "tuta.com",
  "pm.me", "cock.li", "disroot.org", "riseup.net",
]);

// Major email providers
const MAJOR_PROVIDERS = {
  "gmail.com": "Google",
  "googlemail.com": "Google",
  "outlook.com": "Microsoft",
  "hotmail.com": "Microsoft",
  "live.com": "Microsoft",
  "yahoo.com": "Yahoo",
  "aol.com": "AOL",
  "icloud.com": "Apple",
  "me.com": "Apple",
  "mac.com": "Apple",
};

module.exports = {
  name: "email-domain",
  profileTypes: ["email"],

  async scan(profile, rateLimiter) {
    const email = profile.value.toLowerCase();
    const domain = email.split("@")[1];
    if (!domain) return [];

    const findings = [];

    // 1. MX record lookup
    const release = await rateLimiter.acquire();
    let mxRecords = [];
    try {
      mxRecords = await dns.resolveMx(domain);
      mxRecords.sort((a, b) => a.priority - b.priority);
    } catch (err) {
      // No MX records — domain might not accept email
      findings.push({
        category: "exposure",
        severity: "high",
        title: `Email domain "${domain}" has no MX records`,
        description: `The domain ${domain} does not have valid MX (mail) records. This email address may be invalid or the domain may not accept mail. If this is your actual email, the domain may have been abandoned or misconfigured.`,
        rawData: { domain, error: err.code },
        remediation: "Verify this email address is still active. If the domain is yours, check DNS configuration.",
      });
      release();
      return findings;
    }
    release();

    // 2. Check for disposable email
    if (DISPOSABLE_DOMAINS.has(domain)) {
      findings.push({
        category: "exposure",
        severity: "low",
        title: `Disposable email domain: ${domain}`,
        description: `This email uses a known disposable/temporary email provider. While this can protect privacy, if used for account registrations, those accounts may become inaccessible when the email expires.`,
        rawData: { domain, type: "disposable" },
        remediation: "If used for important accounts, migrate to a permanent email address.",
      });
    }

    // 3. Privacy provider check
    if (PRIVACY_PROVIDERS.has(domain)) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: `Privacy-focused email provider: ${domain}`,
        description: `This email uses a privacy-focused provider (${domain}), which offers end-to-end encryption and enhanced privacy features. Good OPSEC choice.`,
        rawData: { domain, type: "privacy" },
        remediation: null,
      });
    }

    // 4. Major provider identification
    const provider = MAJOR_PROVIDERS[domain];
    if (provider) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: `Major email provider: ${provider} (${domain})`,
        description: `This email is hosted by ${provider}. Major providers are generally well-secured but may scan email content for advertising or comply with government data requests.`,
        rawData: { domain, provider, type: "major" },
        remediation: null,
      });
    }

    // 5. SPF record check (protects against spoofing)
    const release2 = await rateLimiter.acquire();
    try {
      const txtRecords = await dns.resolveTxt(domain);
      const spfRecord = txtRecords.flat().find((r) => r.startsWith("v=spf1"));
      if (!spfRecord) {
        findings.push({
          category: "exposure",
          severity: "medium",
          title: `No SPF record for ${domain}`,
          description: `The domain ${domain} does not have an SPF record. This means attackers can more easily spoof emails appearing to come from this domain.`,
          rawData: { domain, spf: null },
          remediation: "If you own this domain, add an SPF record to prevent email spoofing.",
        });
      }

      // 6. DMARC check
      try {
        const dmarcRecords = await dns.resolveTxt(`_dmarc.${domain}`);
        const dmarc = dmarcRecords.flat().find((r) => r.startsWith("v=DMARC1"));
        if (!dmarc) {
          findings.push({
            category: "exposure",
            severity: "medium",
            title: `No DMARC policy for ${domain}`,
            description: `The domain ${domain} does not have a DMARC policy. Without DMARC, the domain is vulnerable to email spoofing and phishing attacks.`,
            rawData: { domain, dmarc: null },
            remediation: "If you own this domain, set up a DMARC policy (start with p=none for monitoring).",
          });
        }
      } catch (_) {
        // No DMARC record
        findings.push({
          category: "exposure",
          severity: "medium",
          title: `No DMARC policy for ${domain}`,
          description: `The domain ${domain} does not have a DMARC policy. Without DMARC, the domain is vulnerable to email spoofing and phishing attacks.`,
          rawData: { domain, dmarc: null },
          remediation: "If you own this domain, set up a DMARC policy (start with p=none for monitoring).",
        });
      }
    } catch (_) {
      // No TXT records at all
    }
    release2();

    // 7. MX provider analysis
    const mxHosts = mxRecords.map((r) => r.exchange.toLowerCase());
    const mxInfo = mxHosts.join(", ");

    const knownMxProviders = [
      { pattern: /google|gmail|googlemail/, name: "Google Workspace" },
      { pattern: /outlook|microsoft|hotmail/, name: "Microsoft 365" },
      { pattern: /protonmail|proton/, name: "ProtonMail" },
      { pattern: /zoho/, name: "Zoho Mail" },
      { pattern: /mimecast/, name: "Mimecast (security gateway)" },
      { pattern: /barracuda/, name: "Barracuda (security gateway)" },
      { pattern: /pphosted|proofpoint/, name: "Proofpoint (security gateway)" },
    ];

    let mxProvider = null;
    for (const kp of knownMxProviders) {
      if (mxHosts.some((h) => kp.pattern.test(h))) {
        mxProvider = kp.name;
        break;
      }
    }

    findings.push({
      category: "exposure",
      severity: "info",
      title: `MX records: ${mxProvider || "custom"} (${mxRecords.length} record${mxRecords.length !== 1 ? "s" : ""})`,
      description: `Mail for ${domain} is handled by ${mxProvider || "a custom mail server"}: ${mxInfo}. MX records reveal what email infrastructure is being used.`,
      rawData: { domain, mxRecords: mxRecords.map((r) => ({ exchange: r.exchange, priority: r.priority })), provider: mxProvider },
      remediation: null,
    });

    return findings;
  },
};
