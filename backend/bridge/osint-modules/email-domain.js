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

    // 8. DKIM selector probing — reveals email infrastructure
    const DKIM_SELECTORS = [
      "google", "default", "selector1", "selector2", "k1", "dkim", "mail",
      "s1", "s2", "mandrill", "amazonses", "smtp", "cm", "mxvault",
      "protonmail", "zoho", "everlytickey1", "dkim1",
    ];
    const DKIM_INFRA_MAP = {
      google: "Google Workspace", selector1: "Microsoft 365", selector2: "Microsoft 365",
      mandrill: "Mailchimp/Mandrill", amazonses: "Amazon SES", k1: "Mailchimp",
      cm: "Campaign Monitor", protonmail: "ProtonMail", zoho: "Zoho Mail",
      s1: "Generic", s2: "Generic", smtp: "Custom SMTP",
    };

    const dkimResults = [];
    const release3 = await rateLimiter.acquire();
    try {
      for (const selector of DKIM_SELECTORS) {
        try {
          const records = await dns.resolveTxt(`${selector}._domainkey.${domain}`);
          const record = records.flat().join("");
          if (record.includes("v=DKIM1") || record.includes("p=")) {
            const keyMatch = record.match(/p=([A-Za-z0-9+/=]+)/);
            const keyLength = keyMatch && keyMatch[1] !== "" ? Math.floor(Buffer.from(keyMatch[1], "base64").length * 8) : null;
            const infra = DKIM_INFRA_MAP[selector] || "Unknown";
            dkimResults.push({ selector, record, keyLength, infrastructure: infra });
          }
        } catch (_) { /* selector not found — normal */ }
      }
    } finally {
      release3();
    }

    if (dkimResults.length > 0) {
      const weakKeys = dkimResults.filter((d) => d.keyLength && d.keyLength < 1024);
      const infraList = [...new Set(dkimResults.map((d) => d.infrastructure).filter((i) => i !== "Unknown"))];

      if (weakKeys.length > 0) {
        findings.push({
          category: "exposure",
          severity: "high",
          title: `Weak DKIM key detected for ${domain}`,
          description: `DKIM selector(s) ${weakKeys.map((d) => d.selector).join(", ")} use key sizes under 1024 bits. These are vulnerable to factoring attacks and should be upgraded to 2048-bit keys.`,
          rawData: { domain, weakKeys: weakKeys.map((d) => ({ selector: d.selector, keyLength: d.keyLength })) },
          remediation: "Upgrade DKIM keys to 2048-bit RSA. Rotate selectors after upgrade.",
        });
      }

      findings.push({
        category: "exposure",
        severity: "info",
        title: `DKIM: ${dkimResults.length} active selector(s) — ${infraList.join(", ") || "custom"}`,
        description: `Active DKIM selectors: ${dkimResults.map((d) => `${d.selector} (${d.infrastructure}${d.keyLength ? `, ${d.keyLength}-bit` : ""})`).join(", ")}. DKIM selectors reveal which email services the domain uses for sending.`,
        rawData: { domain, dkimSelectors: dkimResults, detectedInfrastructure: infraList },
        remediation: null,
      });
    } else {
      findings.push({
        category: "exposure",
        severity: "medium",
        title: `No DKIM selectors found for ${domain}`,
        description: `None of the ${DKIM_SELECTORS.length} common DKIM selectors were found for ${domain}. Email from this domain is not DKIM-signed, making it easier to spoof.`,
        rawData: { domain, selectorsChecked: DKIM_SELECTORS },
        remediation: "If you own this domain, configure DKIM signing to authenticate outbound email.",
      });
    }

    // 9. SPF recursion — fully resolve include: and redirect= chains
    const release4 = await rateLimiter.acquire();
    try {
      const txtRecords2 = await dns.resolveTxt(domain);
      const spfRecord2 = txtRecords2.flat().find((r) => r.startsWith("v=spf1"));
      if (spfRecord2) {
        const spfChain = [{ domain, record: spfRecord2 }];
        const visited = new Set([domain]);
        const includes = spfRecord2.match(/include:([^\s]+)/g) || [];
        const redirect = spfRecord2.match(/redirect=([^\s]+)/);

        const toResolve = [
          ...includes.map((i) => i.replace("include:", "")),
          ...(redirect ? [redirect[1]] : []),
        ];

        for (const target of toResolve) {
          if (visited.has(target)) continue;
          visited.add(target);
          try {
            const subTxt = await dns.resolveTxt(target);
            const subSpf = subTxt.flat().find((r) => r.startsWith("v=spf1"));
            if (subSpf) {
              spfChain.push({ domain: target, record: subSpf });
              const nestedIncludes = subSpf.match(/include:([^\s]+)/g) || [];
              for (const ni of nestedIncludes) {
                const niDomain = ni.replace("include:", "");
                if (!visited.has(niDomain)) {
                  visited.add(niDomain);
                  try {
                    const niTxt = await dns.resolveTxt(niDomain);
                    const niSpf = niTxt.flat().find((r) => r.startsWith("v=spf1"));
                    if (niSpf) spfChain.push({ domain: niDomain, record: niSpf });
                  } catch (_) {}
                }
              }
            }
          } catch (_) {}
        }

        if (spfChain.length > 1) {
          findings.push({
            category: "exposure",
            severity: "info",
            title: `SPF chain: ${spfChain.length} records resolved for ${domain}`,
            description: `Full SPF resolution chain: ${spfChain.map((s) => s.domain).join(" → ")}. This reveals all authorized mail senders.`,
            rawData: { domain, spfChain },
            remediation: null,
          });
        }
      }
    } catch (_) {}
    release4();

    // 10. BIMI record check — brand indicator
    const release5 = await rateLimiter.acquire();
    try {
      const bimiRecords = await dns.resolveTxt(`default._bimi.${domain}`);
      const bimi = bimiRecords.flat().find((r) => r.startsWith("v=BIMI1"));
      if (bimi) {
        const logoMatch = bimi.match(/l=([^\s;]+)/);
        findings.push({
          category: "exposure",
          severity: "info",
          title: `BIMI record found for ${domain}`,
          description: `${domain} has a Brand Indicators for Message Identification (BIMI) record configured.${logoMatch ? ` Logo URL: ${logoMatch[1]}` : ""}`,
          rawData: { domain, bimi, logoUrl: logoMatch?.[1] || null },
          remediation: null,
        });
      }
    } catch (_) { /* No BIMI record — normal for most domains */ }
    release5();

    return findings;
  },
};
