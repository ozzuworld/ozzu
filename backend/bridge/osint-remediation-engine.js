// OSINT Remediation Engine — auto-generates actionable fix-it steps from scan findings
const db = require("./db");

// ── Remediation Templates ──
// Each template maps a finding pattern → remediation item(s)
const REMEDIATION_RULES = [
  // Data broker opt-outs
  {
    module: "data-broker",
    match: (f) => f.category === "exposure" && f.raw_data?.broker,
    generate: (f, profile) => {
      const broker = f.raw_data.broker;
      const optOutUrls = {
        spokeo: "https://www.spokeo.com/optout",
        whitepages: "https://www.whitepages.com/suppression-requests",
        beenverified: "https://www.beenverified.com/app/optout/search",
        intelius: "https://www.intelius.com/opt-out",
        truepeoplesearch: "https://www.truepeoplesearch.com/removal",
        fastpeoplesearch: "https://www.fastpeoplesearch.com/removal",
        thatsThem: "https://thatsthem.com/optout",
        radaris: "https://radaris.com/page/how-to-remove",
        mylife: "https://www.mylife.com/privacy-policy#optout",
        pipl: "https://pipl.com/personal-information-removal-request",
        peoplefinder: "https://www.peoplefinder.com/optout.php",
        usphonebook: "https://www.usphonebook.com/opt-out",
        familytreenow: "https://www.familytreenow.com/optout",
      };
      const key = broker.toLowerCase().replace(/[^a-z]/g, "");
      const url = Object.entries(optOutUrls).find(([k]) => key.includes(k))?.[1];
      return [{
        remediationType: "opt_out",
        title: `Remove your data from ${broker}`,
        description: `${broker} has your personal information publicly listed. Submit an opt-out request to have it removed.`,
        actionUrl: url || f.source_url || `https://www.google.com/search?q=${encodeURIComponent(broker + " opt out")}`,
        actionType: "link",
        priority: 2,
      }];
    },
  },

  // Password change for breaches
  {
    module: "hibp-email",
    match: (f) => f.category === "breach" && f.raw_data?.Name,
    generate: (f, profile) => [{
      remediationType: "password_change",
      title: `Change password for ${f.raw_data.Name} breach`,
      description: `Your email was found in the ${f.raw_data.Name} data breach${f.raw_data.BreachDate ? ` (${f.raw_data.BreachDate})` : ""}. ${f.raw_data.DataClasses ? `Exposed data: ${f.raw_data.DataClasses.join(", ")}` : ""}`,
      actionUrl: null,
      actionType: "instruction",
      priority: f.severity === "critical" ? 1 : 2,
    }],
  },

  // 2FA for breached accounts
  {
    module: "hibp-email",
    match: (f) => f.category === "breach" && f.raw_data?.DataClasses?.includes("Passwords"),
    generate: (f, profile) => [{
      remediationType: "2fa_enable",
      title: `Enable 2FA after ${f.raw_data.Name} breach`,
      description: `Passwords were exposed in the ${f.raw_data.Name} breach. Enable two-factor authentication on any account that used this password.`,
      actionUrl: "https://2fa.directory/",
      actionType: "link",
      priority: 1,
    }],
  },

  // Account deletion for unused accounts
  {
    module: "username-enum",
    match: (f) => f.category === "account_found" && f.raw_data?.found === true,
    generate: (f, profile) => {
      const platform = f.raw_data?.platform || f.title.replace("Account found: ", "");
      return [{
        remediationType: "account_delete",
        title: `Review/delete ${platform} account`,
        description: `An active account was found on ${platform}. If you no longer use this service, consider deleting or deactivating the account.`,
        actionUrl: f.source_url || null,
        actionType: "link",
        priority: 3,
      }];
    },
  },

  // Sherlock — bulk account review
  {
    module: "sherlock-cli",
    match: (f) => f.category === "account_found" && f.raw_data?.totalFound > 10,
    generate: (f, profile) => [{
      remediationType: "account_delete",
      title: `Review ${f.raw_data.totalFound} accounts found by Sherlock`,
      description: `Sherlock found accounts on ${f.raw_data.totalFound} platforms. Review and delete accounts you no longer use to reduce your digital footprint.`,
      actionUrl: null,
      actionType: "instruction",
      priority: 2,
    }],
  },

  // Google privacy settings from GHunt
  {
    module: "ghunt-email",
    match: (f) => f.raw_data?.reviews || f.raw_data?.mapsReviews || f.severity === "critical",
    generate: (f, profile) => [{
      remediationType: "privacy_setting",
      title: "Set Google Maps reviews to private",
      description: "Your Google Maps reviews are publicly visible and reveal physical locations you've visited.",
      actionUrl: "https://maps.google.com/localguides/profile",
      actionType: "link",
      priority: 1,
    }],
  },

  {
    module: "ghunt-email",
    match: (f) => f.raw_data?.profilePhoto && f.raw_data?.profilePhoto !== "default",
    generate: (f, profile) => [{
      remediationType: "privacy_setting",
      title: "Review Google profile photo",
      description: "Your Google profile photo can be used for reverse-image searches across platforms.",
      actionUrl: "https://myaccount.google.com/personal-info",
      actionType: "link",
      priority: 3,
    }],
  },

  // Abuse report for phishing domains
  {
    module: "dnstwist-scan",
    match: (f) => f.severity === "critical" && f.raw_data?.domains,
    generate: (f, profile) => {
      const domains = f.raw_data.domains || [];
      return domains.slice(0, 5).map((d) => ({
        remediationType: "abuse_report",
        title: `Report phishing domain: ${d.domain}`,
        description: `Lookalike domain "${d.domain}" was recently registered${d.whois_registrar ? ` via ${d.whois_registrar}` : ""}. Report to registrar abuse contact.`,
        actionUrl: d.whois_registrar ? `https://www.google.com/search?q=${encodeURIComponent(d.whois_registrar + " abuse report")}` : null,
        actionType: "link",
        priority: 1,
      }));
    },
  },

  // DNS config for missing DMARC/SPF/DKIM
  {
    module: "email-domain",
    match: (f) => f.raw_data?.spf === false || f.raw_data?.dmarc === false || f.raw_data?.dkim === false || (f.title && (f.title.includes("No SPF") || f.title.includes("No DMARC") || f.title.includes("No DKIM"))),
    generate: (f, profile) => [{
      remediationType: "dns_config",
      title: "Configure email authentication records (SPF/DKIM/DMARC)",
      description: "Missing email authentication DNS records make your domain vulnerable to spoofing. Add SPF, DKIM, and DMARC records.",
      actionUrl: "https://dmarcian.com/dmarc-inspector/",
      actionType: "link",
      priority: 2,
    }],
  },

  // Metadata stripping from EXIF
  {
    module: "exif-extract",
    match: (f) => f.raw_data?.latitude && f.raw_data?.longitude,
    generate: (f, profile) => [{
      remediationType: "metadata_strip",
      title: "Strip GPS metadata from images",
      description: "Images with GPS coordinates reveal exact physical locations. Remove EXIF metadata before sharing photos online.",
      actionUrl: null,
      actionType: "instruction",
      priority: 2,
    }],
  },

  // Dark web exposure — password change + monitoring
  {
    module: "darkweb-search",
    match: (f) => f.severity === "critical" || f.severity === "high",
    generate: (f, profile) => [{
      remediationType: "password_change",
      title: "Change passwords — dark web exposure detected",
      description: "Your information was found on the dark web. Immediately change passwords on all important accounts and enable 2FA.",
      actionUrl: null,
      actionType: "instruction",
      priority: 1,
    }],
  },

  // Leak search — credential rotation
  {
    module: "leak-search",
    match: (f) => f.severity === "critical",
    generate: (f, profile) => [{
      remediationType: "password_change",
      title: "Rotate credentials — found in leaked database",
      description: "Your data was found in a leaked database via IntelligenceX. Change all passwords associated with this account.",
      actionUrl: null,
      actionType: "instruction",
      priority: 1,
    }, {
      remediationType: "2fa_enable",
      title: "Enable 2FA on all accounts",
      description: "After a credential leak, enabling two-factor authentication is critical to prevent account takeover.",
      actionUrl: "https://2fa.directory/",
      actionType: "link",
      priority: 1,
    }],
  },

  // HIBP password check
  {
    module: "hibp-password",
    match: (f) => f.severity !== "info" && f.raw_data?.count > 0,
    generate: (f, profile) => [{
      remediationType: "password_change",
      title: "Change compromised password immediately",
      description: `This password has appeared in ${f.raw_data.count} data breaches. Never reuse it anywhere.`,
      actionUrl: null,
      actionType: "instruction",
      priority: 1,
    }],
  },

  // Certificate transparency — subdomain takeover
  {
    module: "crtsh-monitor",
    match: (f) => f.severity === "high" && f.raw_data?.subdomains,
    generate: (f, profile) => [{
      remediationType: "dns_config",
      title: "Investigate unexpected subdomains",
      description: `${f.raw_data.subdomains.length} unexpected subdomains found in certificate transparency logs. Verify they are authorized and not vulnerable to takeover.`,
      actionUrl: null,
      actionType: "instruction",
      priority: 2,
    }],
  },
];

/**
 * Generate remediations for a single finding.
 */
function generateForFinding(finding, profile) {
  const remediations = [];
  for (const rule of REMEDIATION_RULES) {
    if (rule.module !== finding.module) continue;
    try {
      if (rule.match(finding)) {
        const items = rule.generate(finding, profile);
        for (const item of items) {
          remediations.push({
            findingId: finding.id,
            profileId: profile.id,
            ...item,
          });
        }
      }
    } catch {
      // Skip failing rules
    }
  }
  return remediations;
}

/**
 * Generate remediations for all findings of a profile.
 * Deduplicates by (profile_id, remediation_type, title).
 */
async function generateForProfile(profileId) {
  const profile = await db.getOsintProfile(profileId);
  if (!profile) return [];

  const findings = await db.getOsintFindings({ profileId });
  const allRemediations = [];
  const seen = new Set();

  for (const finding of findings) {
    const items = generateForFinding(finding, profile);
    for (const item of items) {
      const key = `${item.profileId}:${item.remediationType}:${item.title}`;
      if (!seen.has(key)) {
        seen.add(key);
        allRemediations.push(item);
      }
    }
  }

  // Bulk insert (createOsintRemediation uses ON CONFLICT DO NOTHING)
  const created = await db.bulkCreateRemediations(allRemediations);
  return created;
}

/**
 * Generate remediations for ALL profiles.
 */
async function generateAll() {
  const profiles = await db.getOsintProfiles();
  let totalCreated = 0;
  for (const profile of profiles) {
    const created = await generateForProfile(profile.id);
    totalCreated += created.length;
  }
  return totalCreated;
}

/**
 * Auto-remediate: triage noise, mark known FPs, generate remediation tasks.
 * Runs after scan completes — only touches findings with status='new'.
 */
async function autoRemediate(profileId, scanId) {
  const findings = await db.getOsintFindings({ profileId, scanId, status: "new", limit: 500 });
  if (!findings || findings.length === 0) return { acknowledged: 0, falsePositives: 0, remediationsGenerated: 0 };

  const fpIds = [];
  const ackIds = [];

  // Build set of previously-reviewed finding keys for re-scan dedup
  let prevKeys = null;

  for (const f of findings) {
    // ── Never auto-triage: critical/high (except paste-monitor FP), breach category, hibp-password with hits
    if (f.category === "breach") continue;
    if (f.module === "hibp-password" && f.raw_data?.count > 0) continue;

    // ── False Positive rules (noise pattern registry)
    if (matchesNoisePattern(f)) {
      fpIds.push(f.id);
      continue;
    }

    // ── High/critical findings that passed FP check stay as new
    if (f.severity === "critical" || f.severity === "high") continue;

    // ── Acknowledge rules (info/low noise)
    if (shouldAcknowledge(f)) {
      ackIds.push(f.id);
      continue;
    }

    // ── Re-scan duplicate: same (profile_id, module, title) already exists with status != 'new'
    if (!prevKeys) {
      const allFindings = await db.getOsintFindings({ profileId, limit: 500 });
      prevKeys = new Set();
      for (const prev of allFindings) {
        if (prev.scan_id !== scanId && prev.status !== "new") {
          prevKeys.add(`${prev.module}:${prev.title}`);
        }
      }
    }
    const key = `${f.module}:${f.title}`;
    if (prevKeys.has(key)) {
      ackIds.push(f.id);
    }
  }

  // ── Bulk username-enum ack: if >20 accounts found, keep top 10 important platforms, ack the rest
  const usernameFindings = findings.filter(f =>
    f.module === "username-enum" && f.category === "account_found" && f.status === "new"
    && !fpIds.includes(f.id) && !ackIds.includes(f.id)
  );
  if (usernameFindings.length > 20) {
    const importantPlatforms = ["github", "twitter", "linkedin", "instagram", "facebook",
                                "reddit", "tiktok", "youtube", "pinterest", "snapchat"];
    const sorted = [...usernameFindings].sort((a, b) => {
      const aIdx = importantPlatforms.indexOf((a.raw_data?.platform || "").toLowerCase());
      const bIdx = importantPlatforms.indexOf((b.raw_data?.platform || "").toLowerCase());
      return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
    });
    for (const f of sorted.slice(10)) {
      ackIds.push(f.id);
    }
  }

  // Bulk updates
  const fpUpdated = await db.bulkUpdateOsintFindings(fpIds, "false_positive");
  const ackUpdated = await db.bulkUpdateOsintFindings(ackIds, "acknowledged");

  // Generate remediation tasks for remaining actionable findings
  let remediationsGenerated = 0;
  try {
    const created = await generateForProfile(profileId);
    remediationsGenerated = created.length;
  } catch (e) {
    console.error(`[remediation] Auto-generate error:`, e.message);
  }

  // Count remaining new findings
  const triaged = new Set([...fpIds, ...ackIds]);
  const remainingNew = findings.filter(f => f.status === "new" && !triaged.has(f.id)).length;

  return {
    acknowledged: ackUpdated.length,
    falsePositives: fpUpdated.length,
    remediationsGenerated,
    remainingNew,
  };
}

// ── Noise Pattern Registry ──
// Each pattern identifies a known false-positive source by module + test function
const NOISE_PATTERNS = [
  // Paste search generic hits — no verification that value appears in paste body
  { module: "paste-monitor", test: (f) => {
    const rd = f.raw_data || {};
    return rd.hasResults === true && !rd.confirmedMatch;
  }},
  // Paste-monitor GitHub Gists search page hits without PII confirmation
  { module: "paste-monitor", test: (f) => {
    if (f.severity !== "high" || f.raw_data?.site !== "GitHub Gists") return false;
    const title = (f.title || "").toLowerCase();
    return !f.raw_data?.piiFound && (title.includes("search") || title.includes("match"));
  }},
  // Google dork hits without API key — unverified search results
  { module: "paste-monitor", test: (f) => {
    return f.category === "exposure" && f.raw_data?.reason === "no_google_api_key";
  }},
  // Web-crawler phone spam — sequential/repeated digit patterns or bulk regex noise
  { module: "web-crawler", test: (f) => {
    if (f.category !== "exposure" || !(f.title || "").toLowerCase().includes("phone")) return false;
    const phones = f.raw_data?.phones || [];
    if (phones.length === 0) {
      const count = f.raw_data?.count || f.raw_data?.phoneCount || 0;
      return count > 20;
    }
    return phones.every(p => {
      const digits = p.replace(/\D/g, "");
      return /^(\d)\1+$/.test(digits) || /0123456789|9876543210|1234567890/.test(digits);
    });
  }},
  // Web-crawler test/example emails from known junk domains
  { module: "web-crawler", test: (f) => {
    if (f.category !== "exposure" || !(f.title || "").toLowerCase().includes("email")) return false;
    const emails = f.raw_data?.emails || [];
    const junkDomains = ["example.com", "example.org", "test.com", "localhost",
                         "sentry.io", "webpack.js.org", "w3.org", "schema.org"];
    return emails.length > 0 && emails.every(e =>
      junkDomains.some(d => e.endsWith("@" + d)) || /^(test|admin|noreply|no-reply|postmaster|webmaster)@/.test(e)
    );
  }},
  // Phone lookup — WhatsApp always returns 200 (100% FP)
  { module: "phone-lookup", test: (f) => {
    return f.category === "account_found" && f.raw_data?.platform === "WhatsApp";
  }},
  // Data broker — generic 200 without content verification
  { module: "data-broker", test: (f) => {
    return f.severity === "low" && f.raw_data?.statusCode === 200 && !f.raw_data?.confirmedMatch;
  }},
  // h8mail "no results" that slipped through (safety net after ANSI fix)
  { module: "h8mail-cli", test: (f) => {
    return f.severity === "info" && (f.title?.includes("No breach") || f.title?.includes("no results"));
  }},
];

function matchesNoisePattern(finding) {
  return NOISE_PATTERNS.some(p =>
    (p.module === "*" || p.module === finding.module) && p.test(finding)
  );
}

function shouldAcknowledge(f) {
  // All info severity = tool status messages, not exposure
  if (f.severity === "info") return true;
  // Low severity social-deep = "profile exists" baseline
  if (f.severity === "low" && f.module === "social-deep") return true;
  // Title indicates skipped/unavailable tool
  const title = (f.title || "").toLowerCase();
  if (title.includes("skipped") || title.includes("not available")) return true;
  // Clean baseline "No X found" info results
  if (title.startsWith("no ") && f.severity === "info") return true;
  return false;
}

module.exports = {
  generateForFinding,
  generateForProfile,
  generateAll,
  autoRemediate,
  REMEDIATION_RULES,
};
