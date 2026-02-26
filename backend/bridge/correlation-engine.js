// Cross-Profile Correlation Engine
// Identifies linked identities by analyzing findings across all profiles
// Pattern matching: name correlation, email-username link, shared breach, platform overlap, domain association
const db = require("./db");

const CORRELATION_TYPES = {
  NAME_MATCH: "name_match",
  EMAIL_USERNAME_LINK: "email_username_link",
  SHARED_BREACH: "shared_breach",
  PLATFORM_OVERLAP: "platform_overlap",
  DOMAIN_ASSOCIATION: "domain_association",
};

// Simple fuzzy name comparison (case-insensitive, trims, handles common variants)
function namesMatch(a, b) {
  if (!a || !b) return { match: false, confidence: 0 };
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return { match: true, confidence: 1.0 };
  // Check if one contains the other (e.g. "John" in "John Doe")
  if (na.includes(nb) || nb.includes(na)) return { match: true, confidence: 0.7 };
  // Check word overlap
  const wordsA = na.split(/\s+/);
  const wordsB = nb.split(/\s+/);
  const common = wordsA.filter((w) => wordsB.includes(w));
  if (common.length > 0 && common.length >= Math.min(wordsA.length, wordsB.length) * 0.5) {
    return { match: true, confidence: 0.5 + (common.length / Math.max(wordsA.length, wordsB.length)) * 0.3 };
  }
  return { match: false, confidence: 0 };
}

async function runCorrelation() {
  const profiles = await db.getOsintProfiles();
  if (profiles.length < 2) return { correlationsFound: 0 };

  const allFindings = await db.getOsintFindings({ limit: 5000 });
  let correlationsFound = 0;

  // Index findings by profile
  const findingsByProfile = {};
  for (const f of allFindings) {
    if (!findingsByProfile[f.profile_id]) findingsByProfile[f.profile_id] = [];
    findingsByProfile[f.profile_id].push(f);
  }

  // Extract metadata from findings for each profile
  const profileMeta = {};
  for (const p of profiles) {
    const findings = findingsByProfile[p.id] || [];
    profileMeta[p.id] = {
      profile: p,
      names: new Set(),
      platforms: new Set(),
      breaches: new Set(),
      avatarHashes: new Set(),
    };
    const meta = profileMeta[p.id];

    for (const f of findings) {
      // Extract display names from gravatar, social profiles
      if (f.raw_data?.displayName) meta.names.add(f.raw_data.displayName);
      if (f.raw_data?.name) meta.names.add(f.raw_data.name);
      if (f.raw_data?.fullName) meta.names.add(f.raw_data.fullName);

      // Extract platforms from account_found findings
      if (f.category === "account_found" && f.raw_data?.platform) {
        meta.platforms.add(f.raw_data.platform.toLowerCase());
      }

      // Extract breach names from breach findings
      if (f.category === "breach" && f.raw_data?.breachName) {
        meta.breaches.add(f.raw_data.breachName.toLowerCase());
      }
      if (f.category === "breach" && f.raw_data?.Name) {
        meta.breaches.add(f.raw_data.Name.toLowerCase());
      }

      // Extract avatar hashes
      if (f.raw_data?.avatarHash) meta.avatarHashes.add(f.raw_data.avatarHash);
    }
  }

  // Compare all profile pairs
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      const pA = profiles[i];
      const pB = profiles[j];
      const metaA = profileMeta[pA.id];
      const metaB = profileMeta[pB.id];

      // 1. Name correlation: display names match across profiles
      for (const nameA of metaA.names) {
        for (const nameB of metaB.names) {
          const { match, confidence } = namesMatch(nameA, nameB);
          if (match && confidence >= 0.5) {
            await db.upsertOsintCorrelation(pA.id, pB.id, CORRELATION_TYPES.NAME_MATCH, confidence, {
              matchedNames: [nameA, nameB],
              sourceProfile: pA.label,
              targetProfile: pB.label,
            });
            correlationsFound++;
          }
        }
      }

      // 2. Email-username link: email local part matches a username
      if (pA.profile_type === "email" && pB.profile_type === "username") {
        const localPart = pA.value.split("@")[0].toLowerCase();
        if (localPart === pB.value.toLowerCase()) {
          await db.upsertOsintCorrelation(pA.id, pB.id, CORRELATION_TYPES.EMAIL_USERNAME_LINK, 0.9, {
            emailLocalPart: localPart,
            username: pB.value,
          });
          correlationsFound++;
        } else if (localPart.includes(pB.value.toLowerCase()) || pB.value.toLowerCase().includes(localPart)) {
          await db.upsertOsintCorrelation(pA.id, pB.id, CORRELATION_TYPES.EMAIL_USERNAME_LINK, 0.6, {
            emailLocalPart: localPart,
            username: pB.value,
            partial: true,
          });
          correlationsFound++;
        }
      }
      // Reverse direction
      if (pB.profile_type === "email" && pA.profile_type === "username") {
        const localPart = pB.value.split("@")[0].toLowerCase();
        if (localPart === pA.value.toLowerCase()) {
          await db.upsertOsintCorrelation(pB.id, pA.id, CORRELATION_TYPES.EMAIL_USERNAME_LINK, 0.9, {
            emailLocalPart: localPart,
            username: pA.value,
          });
          correlationsFound++;
        } else if (localPart.includes(pA.value.toLowerCase()) || pA.value.toLowerCase().includes(localPart)) {
          await db.upsertOsintCorrelation(pB.id, pA.id, CORRELATION_TYPES.EMAIL_USERNAME_LINK, 0.6, {
            emailLocalPart: localPart,
            username: pA.value,
            partial: true,
          });
          correlationsFound++;
        }
      }

      // 3. Shared breach: same breach appears across multiple email profiles
      if (pA.profile_type === "email" && pB.profile_type === "email") {
        const sharedBreaches = [...metaA.breaches].filter((b) => metaB.breaches.has(b));
        if (sharedBreaches.length > 0) {
          const confidence = Math.min(0.3 + sharedBreaches.length * 0.15, 0.9);
          await db.upsertOsintCorrelation(pA.id, pB.id, CORRELATION_TYPES.SHARED_BREACH, confidence, {
            sharedBreaches,
            count: sharedBreaches.length,
          });
          correlationsFound++;
        }
      }

      // 4. Platform overlap: same platform found for different usernames
      if (pA.profile_type === "username" && pB.profile_type === "username") {
        const sharedPlatforms = [...metaA.platforms].filter((p) => metaB.platforms.has(p));
        if (sharedPlatforms.length >= 2) {
          const confidence = Math.min(0.2 + sharedPlatforms.length * 0.1, 0.7);
          await db.upsertOsintCorrelation(pA.id, pB.id, CORRELATION_TYPES.PLATFORM_OVERLAP, confidence, {
            sharedPlatforms,
            count: sharedPlatforms.length,
          });
          correlationsFound++;
        }
      }

      // 5. Domain association: email domain matches a domain profile
      if (pA.profile_type === "email" && pB.profile_type === "domain") {
        const emailDomain = pA.value.split("@")[1]?.toLowerCase();
        if (emailDomain === pB.value.toLowerCase()) {
          await db.upsertOsintCorrelation(pA.id, pB.id, CORRELATION_TYPES.DOMAIN_ASSOCIATION, 0.95, {
            emailDomain,
            domainProfile: pB.value,
          });
          correlationsFound++;
        }
      }
      // Reverse
      if (pB.profile_type === "email" && pA.profile_type === "domain") {
        const emailDomain = pB.value.split("@")[1]?.toLowerCase();
        if (emailDomain === pA.value.toLowerCase()) {
          await db.upsertOsintCorrelation(pB.id, pA.id, CORRELATION_TYPES.DOMAIN_ASSOCIATION, 0.95, {
            emailDomain,
            domainProfile: pA.value,
          });
          correlationsFound++;
        }
      }
    }
  }

  return { correlationsFound };
}

async function getCorrelations(filters = {}) {
  return db.getOsintCorrelations(filters);
}

async function getGraphData() {
  return db.getOsintCorrelationGraph();
}

async function getProfileCorrelations(profileId) {
  return db.getOsintCorrelations({ profileId });
}

module.exports = {
  CORRELATION_TYPES,
  runCorrelation,
  getCorrelations,
  getGraphData,
  getProfileCorrelations,
};
