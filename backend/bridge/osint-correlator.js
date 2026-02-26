// OSINT Correlation Engine — Maltego-style entity extraction and relationship mapping
// Extracts identity fragments from scan findings and connects them into an intelligence graph
const db = require("./db");

// ── Confidence Scores ──
const CONFIDENCE = {
  PLATFORM_CONFIRMED: 90,    // HTTP 200 on platform profile
  HIBP_VERIFIED: 95,         // HIBP verified breach data
  GRAVATAR_LINKED: 85,       // Gravatar linked account
  DNS_RESOLVED: 90,          // DNS record confirmed
  WHOIS_DATA: 85,            // WHOIS/RDAP registrant data
  CERT_TRANSPARENCY: 80,     // Certificate transparency log
  DATA_BROKER_HIT: 40,       // Data broker HTTP 200 (generic page possible)
  GOOGLE_DORK: 60,           // Google search result
  CALLERID: 80,              // OpenCNAM caller name
  CARRIER_DATA: 75,          // NumVerify carrier info
  SOCIAL_DEEP: 85,           // Deep social profile extraction
  CROSS_PROFILE: 95,         // Two profiles link to same entity
};

// ── Entity Extraction Rules ──
// Each rule: { module, findingPattern, extract(finding, profile) → { entities[], relationships[] } }

const EXTRACTION_RULES = [
  // username-enum: account exists on platform → social_account entity
  {
    module: "username-enum",
    match: (f) => f.category === "account_found" && f.raw_data?.found === true,
    extract: (f, profile) => {
      const platform = f.raw_data?.platform || f.title.replace("Account found: ", "");
      const url = f.source_url || f.raw_data?.url;
      return {
        entities: [
          { entity_type: "social_account", value: `${platform.toLowerCase()}:${profile.value}`, label: `${platform} (${profile.value})`, metadata: { platform, url, profileUrl: url }, source_module: "username-enum" },
        ],
        relationships: [
          { fromType: "username", fromValue: profile.value, toType: "social_account", toValue: `${platform.toLowerCase()}:${profile.value}`, relationship: "uses", confidence: CONFIDENCE.PLATFORM_CONFIRMED, evidence: `HTTP ${f.raw_data?.status || 200} on ${url}` },
        ],
      };
    },
  },

  // gravatar-lookup: linked accounts → entities for each
  {
    module: "gravatar-lookup",
    match: (f) => f.raw_data?.accounts && Array.isArray(f.raw_data.accounts),
    extract: (f, profile) => {
      const entities = [];
      const relationships = [];
      for (const acct of f.raw_data.accounts) {
        const platform = (acct.shortname || acct.name || "unknown").toLowerCase();
        const url = acct.url || acct.profileUrl || "";
        const username = acct.username || acct.display || url.split("/").pop() || "";
        entities.push({
          entity_type: "social_account", value: `${platform}:${username}`, label: `${acct.name || platform} (${username})`,
          metadata: { platform, url, username, viaGravatar: true }, source_module: "gravatar-lookup",
        });
        relationships.push({
          fromType: "email", fromValue: profile.value, toType: "social_account", toValue: `${platform}:${username}`,
          relationship: "linked_to", confidence: CONFIDENCE.GRAVATAR_LINKED, evidence: `Gravatar profile lists ${acct.name || platform} account`,
        });
      }
      // If gravatar reveals a display name → person entity
      if (f.raw_data?.displayName || f.raw_data?.name?.formatted) {
        const name = f.raw_data.displayName || f.raw_data.name.formatted;
        entities.push({
          entity_type: "person", value: name.toLowerCase(), label: name,
          metadata: { source: "gravatar", email: profile.value }, source_module: "gravatar-lookup",
        });
        relationships.push({
          fromType: "email", fromValue: profile.value, toType: "person", toValue: name.toLowerCase(),
          relationship: "registered_to", confidence: CONFIDENCE.GRAVATAR_LINKED, evidence: "Gravatar display name",
        });
      }
      return { entities, relationships };
    },
  },

  // gravatar-lookup: avatar found → image entity
  {
    module: "gravatar-lookup",
    match: (f) => f.raw_data?.avatarUrl && f.title?.includes("avatar"),
    extract: (f, profile) => ({
      entities: [
        { entity_type: "image", value: f.raw_data.avatarUrl, label: `Gravatar avatar (${profile.value})`, metadata: { type: "avatar", source: "gravatar" }, source_module: "gravatar-lookup" },
      ],
      relationships: [
        { fromType: "email", fromValue: profile.value, toType: "image", toValue: f.raw_data.avatarUrl, relationship: "uses", confidence: CONFIDENCE.GRAVATAR_LINKED, evidence: "Gravatar profile photo" },
      ],
    }),
  },

  // hibp-email: breach → organization entity per breach
  {
    module: "hibp-email",
    match: (f) => f.category === "breach" && f.raw_data?.Name,
    extract: (f, profile) => ({
      entities: [
        { entity_type: "organization", value: `breach:${f.raw_data.Name.toLowerCase()}`, label: `${f.raw_data.Name} (breach)`, metadata: { breachDate: f.raw_data.BreachDate, dataClasses: f.raw_data.DataClasses, pwnCount: f.raw_data.PwnCount }, source_module: "hibp-email" },
      ],
      relationships: [
        { fromType: "email", fromValue: profile.value, toType: "organization", toValue: `breach:${f.raw_data.Name.toLowerCase()}`, relationship: "found_on", confidence: CONFIDENCE.HIBP_VERIFIED, evidence: `HIBP verified breach: ${f.raw_data.Name} (${f.raw_data.BreachDate})` },
      ],
    }),
  },

  // email-domain: MX provider → organization entity
  {
    module: "email-domain",
    match: (f) => f.raw_data?.provider && f.raw_data.provider !== "Unknown",
    extract: (f, profile) => {
      const domain = profile.value.split("@")[1];
      return {
        entities: [
          { entity_type: "domain", value: domain, label: domain, metadata: { mxProvider: f.raw_data.provider, mxRecords: f.raw_data.mxRecords }, source_module: "email-domain" },
          { entity_type: "organization", value: `provider:${f.raw_data.provider.toLowerCase()}`, label: f.raw_data.provider, metadata: { type: "email_provider" }, source_module: "email-domain" },
        ],
        relationships: [
          { fromType: "email", fromValue: profile.value, toType: "domain", toValue: domain, relationship: "registered_to", confidence: CONFIDENCE.DNS_RESOLVED, evidence: `Email domain: ${domain}` },
          { fromType: "domain", fromValue: domain, toType: "organization", toValue: `provider:${f.raw_data.provider.toLowerCase()}`, relationship: "hosted_on", confidence: CONFIDENCE.DNS_RESOLVED, evidence: `MX provider: ${f.raw_data.provider}` },
        ],
      };
    },
  },

  // data-broker: hit → organization entity per broker
  {
    module: "data-broker",
    match: (f) => f.category === "exposure" && f.raw_data?.found === true && f.raw_data?.broker,
    extract: (f, profile) => ({
      entities: [
        { entity_type: "organization", value: `broker:${f.raw_data.broker.toLowerCase()}`, label: `${f.raw_data.broker} (data broker)`, metadata: { type: "data_broker", url: f.source_url }, source_module: "data-broker" },
      ],
      relationships: [
        { fromType: profile.profile_type, fromValue: profile.value, toType: "organization", toValue: `broker:${f.raw_data.broker.toLowerCase()}`, relationship: "found_on", confidence: CONFIDENCE.DATA_BROKER_HIT, evidence: `Data broker listing: ${f.raw_data.broker}` },
      ],
    }),
  },

  // phone-lookup: carrier info → organization entity
  {
    module: "phone-lookup",
    match: (f) => f.raw_data?.numverify?.carrier,
    extract: (f, profile) => ({
      entities: [
        { entity_type: "organization", value: `carrier:${f.raw_data.numverify.carrier.toLowerCase()}`, label: `${f.raw_data.numverify.carrier} (carrier)`, metadata: { lineType: f.raw_data.numverify.line_type, country: f.raw_data.numverify.country_name }, source_module: "phone-lookup" },
      ],
      relationships: [
        { fromType: "phone", fromValue: profile.value, toType: "organization", toValue: `carrier:${f.raw_data.numverify.carrier.toLowerCase()}`, relationship: "registered_to", confidence: CONFIDENCE.CARRIER_DATA, evidence: `NumVerify: ${f.raw_data.numverify.carrier} (${f.raw_data.numverify.line_type})` },
      ],
    }),
  },

  // phone-lookup: CallerID name → person entity
  {
    module: "phone-lookup",
    match: (f) => f.raw_data?.opencnam?.name && f.raw_data.opencnam.name !== "UNAVAILABLE",
    extract: (f, profile) => ({
      entities: [
        { entity_type: "person", value: f.raw_data.opencnam.name.toLowerCase(), label: f.raw_data.opencnam.name, metadata: { source: "opencnam", phone: profile.value }, source_module: "phone-lookup" },
      ],
      relationships: [
        { fromType: "phone", fromValue: profile.value, toType: "person", toValue: f.raw_data.opencnam.name.toLowerCase(), relationship: "registered_to", confidence: CONFIDENCE.CALLERID, evidence: `CallerID: ${f.raw_data.opencnam.name}` },
      ],
    }),
  },

  // phone-lookup: messaging platform found → social_account entity
  {
    module: "phone-lookup",
    match: (f) => f.category === "account_found" && f.raw_data?.found === true && f.raw_data?.platform,
    extract: (f, profile) => ({
      entities: [
        { entity_type: "social_account", value: `${f.raw_data.platform.toLowerCase()}:${profile.value}`, label: `${f.raw_data.platform} (${profile.value})`, metadata: { platform: f.raw_data.platform, url: f.raw_data.url }, source_module: "phone-lookup" },
      ],
      relationships: [
        { fromType: "phone", fromValue: profile.value, toType: "social_account", toValue: `${f.raw_data.platform.toLowerCase()}:${profile.value}`, relationship: "uses", confidence: CONFIDENCE.PLATFORM_CONFIRMED, evidence: `${f.raw_data.platform} account linked to phone number` },
      ],
    }),
  },

  // domain-recon: DNS records → ip entities
  {
    module: "domain-recon",
    match: (f) => f.raw_data?.recordType === "A" && f.raw_data?.records,
    extract: (f, profile) => {
      const entities = [];
      const relationships = [];
      for (const ip of (f.raw_data.records || [])) {
        entities.push({
          entity_type: "ip", value: ip, label: ip,
          metadata: { recordType: "A", domain: profile.value }, source_module: "domain-recon",
        });
        relationships.push({
          fromType: "domain", fromValue: profile.value, toType: "ip", toValue: ip,
          relationship: "resolves_to", confidence: CONFIDENCE.DNS_RESOLVED, evidence: `DNS A record: ${profile.value} → ${ip}`,
        });
      }
      return { entities, relationships };
    },
  },

  // domain-recon: WHOIS registrant → person/organization entity
  {
    module: "domain-recon",
    match: (f) => f.raw_data?.whois?.registrant,
    extract: (f, profile) => {
      const reg = f.raw_data.whois.registrant;
      const entities = [];
      const relationships = [];
      if (reg.name) {
        entities.push({
          entity_type: "person", value: reg.name.toLowerCase(), label: reg.name,
          metadata: { source: "whois", domain: profile.value }, source_module: "domain-recon",
        });
        relationships.push({
          fromType: "domain", fromValue: profile.value, toType: "person", toValue: reg.name.toLowerCase(),
          relationship: "registered_to", confidence: CONFIDENCE.WHOIS_DATA, evidence: `WHOIS registrant: ${reg.name}`,
        });
      }
      if (reg.organization) {
        entities.push({
          entity_type: "organization", value: `org:${reg.organization.toLowerCase()}`, label: reg.organization,
          metadata: { source: "whois", domain: profile.value }, source_module: "domain-recon",
        });
        relationships.push({
          fromType: "domain", fromValue: profile.value, toType: "organization", toValue: `org:${reg.organization.toLowerCase()}`,
          relationship: "owned_by", confidence: CONFIDENCE.WHOIS_DATA, evidence: `WHOIS org: ${reg.organization}`,
        });
      }
      return { entities, relationships };
    },
  },

  // domain-recon: subdomains → domain entities
  {
    module: "domain-recon",
    match: (f) => f.raw_data?.subdomains && Array.isArray(f.raw_data.subdomains),
    extract: (f, profile) => {
      const entities = [];
      const relationships = [];
      for (const sub of f.raw_data.subdomains.slice(0, 20)) { // Cap at 20
        entities.push({
          entity_type: "domain", value: sub, label: sub,
          metadata: { parentDomain: profile.value, source: f.raw_data.source || "discovery" }, source_module: "domain-recon",
        });
        relationships.push({
          fromType: "domain", fromValue: profile.value, toType: "domain", toValue: sub,
          relationship: "owns", confidence: CONFIDENCE.CERT_TRANSPARENCY, evidence: `Subdomain of ${profile.value}`,
        });
      }
      return { entities, relationships };
    },
  },

  // social-deep: GitHub profile → person + social_account entities
  {
    module: "social-deep",
    match: (f) => f.raw_data?.platform === "github" && f.raw_data?.profileData,
    extract: (f, profile) => {
      const d = f.raw_data.profileData;
      const entities = [];
      const relationships = [];

      entities.push({
        entity_type: "social_account", value: `github:${profile.value}`, label: `GitHub (${d.login || profile.value})`,
        metadata: { ...d, platform: "github" }, source_module: "social-deep",
      });
      relationships.push({
        fromType: "username", fromValue: profile.value, toType: "social_account", toValue: `github:${profile.value}`,
        relationship: "uses", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: "GitHub API profile data",
      });

      if (d.name) {
        entities.push({ entity_type: "person", value: d.name.toLowerCase(), label: d.name, metadata: { source: "github" }, source_module: "social-deep" });
        relationships.push({ fromType: "social_account", fromValue: `github:${profile.value}`, toType: "person", toValue: d.name.toLowerCase(), relationship: "linked_to", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `GitHub name: ${d.name}` });
      }
      if (d.email) {
        entities.push({ entity_type: "email", value: d.email.toLowerCase(), label: d.email, metadata: { source: "github" }, source_module: "social-deep" });
        relationships.push({ fromType: "social_account", fromValue: `github:${profile.value}`, toType: "email", toValue: d.email.toLowerCase(), relationship: "linked_to", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `GitHub public email` });
      }
      if (d.company) {
        entities.push({ entity_type: "organization", value: `org:${d.company.replace(/^@/, "").toLowerCase()}`, label: d.company, metadata: { source: "github" }, source_module: "social-deep" });
        relationships.push({ fromType: "social_account", fromValue: `github:${profile.value}`, toType: "organization", toValue: `org:${d.company.replace(/^@/, "").toLowerCase()}`, relationship: "member_of", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `GitHub company: ${d.company}` });
      }
      if (d.location) {
        entities.push({ entity_type: "location", value: d.location.toLowerCase(), label: d.location, metadata: { source: "github" }, source_module: "social-deep" });
        relationships.push({ fromType: "social_account", fromValue: `github:${profile.value}`, toType: "location", toValue: d.location.toLowerCase(), relationship: "associated_with", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `GitHub location: ${d.location}` });
      }
      if (d.blog) {
        const blogDomain = d.blog.replace(/^https?:\/\//, "").replace(/\/.*/, "");
        entities.push({ entity_type: "domain", value: blogDomain, label: d.blog, metadata: { source: "github", url: d.blog }, source_module: "social-deep" });
        relationships.push({ fromType: "social_account", fromValue: `github:${profile.value}`, toType: "domain", toValue: blogDomain, relationship: "owns", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `GitHub blog: ${d.blog}` });
      }

      return { entities, relationships };
    },
  },

  // social-deep: Reddit profile
  {
    module: "social-deep",
    match: (f) => f.raw_data?.platform === "reddit" && f.raw_data?.profileData,
    extract: (f, profile) => ({
      entities: [
        { entity_type: "social_account", value: `reddit:${profile.value}`, label: `Reddit (${profile.value})`, metadata: { ...f.raw_data.profileData, platform: "reddit" }, source_module: "social-deep" },
      ],
      relationships: [
        { fromType: "username", fromValue: profile.value, toType: "social_account", toValue: `reddit:${profile.value}`, relationship: "uses", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: "Reddit API profile data" },
      ],
    }),
  },
];

// ── Core Correlation Functions ──

async function correlateScanResults(profileId, scanId) {
  try {
    const profile = await db.getOsintProfile(profileId);
    if (!profile) return;

    // Get all findings for this profile (not just this scan — correlate everything)
    const findings = await db.getOsintFindings({ profileId, limit: 500 });
    if (!findings || findings.length === 0) return;

    // Create the profile's root entity
    const rootEntity = await db.upsertOsintEntity({
      entity_type: profile.profile_type,
      value: profile.value,
      label: profile.label,
      metadata: { profileId: profile.id, tags: profile.tags },
      source_module: "correlator",
      profile_id: profile.id,
    });

    let entitiesCreated = 0;
    let relationshipsCreated = 0;

    // Apply extraction rules to each finding
    for (const finding of findings) {
      for (const rule of EXTRACTION_RULES) {
        if (finding.module !== rule.module) continue;
        if (!rule.match(finding)) continue;

        try {
          const result = rule.extract(finding, profile);

          // Create entities
          for (const entityData of result.entities) {
            const entity = await db.upsertOsintEntity({
              ...entityData,
              source_finding_id: finding.id,
              profile_id: profile.id,
            });
            if (entity) entitiesCreated++;
          }

          // Create relationships
          for (const relData of result.relationships) {
            // Resolve source and target entity IDs
            const sourceEntities = await db.getOsintEntities({ type: relData.fromType, limit: 1 });
            const targetEntities = await db.getOsintEntities({ type: relData.toType, limit: 1 });

            // Find by value match
            const sourceEntity = sourceEntities.find((e) => e.value === relData.fromValue) ||
              await db.upsertOsintEntity({ entity_type: relData.fromType, value: relData.fromValue, label: relData.fromValue, profile_id: profile.id, source_module: rule.module });
            const targetEntity = targetEntities.find((e) => e.value === relData.toValue) ||
              await db.upsertOsintEntity({ entity_type: relData.toType, value: relData.toValue, label: relData.toValue, profile_id: profile.id, source_module: rule.module });

            if (sourceEntity && targetEntity) {
              const rel = await db.upsertOsintRelationship({
                source_entity_id: sourceEntity.id,
                target_entity_id: targetEntity.id,
                relationship: relData.relationship,
                confidence: relData.confidence,
                source_module: rule.module,
                evidence: relData.evidence,
              });
              if (rel) relationshipsCreated++;
            }
          }
        } catch (err) {
          console.error(`[correlator] Rule extraction error (${rule.module}):`, err.message);
        }
      }
    }

    // Cross-profile correlation: find shared entities
    await crossProfileCorrelation(profileId);

    console.log(`[correlator] Profile ${profileId}: ${entitiesCreated} entities, ${relationshipsCreated} relationships`);
  } catch (err) {
    console.error(`[correlator] Error correlating profile ${profileId}:`, err.message);
  }
}

async function crossProfileCorrelation(profileId) {
  try {
    // Find entities from this profile that also appear in other profiles
    const myEntities = await db.getOsintEntities({ profileId });

    for (const entity of myEntities) {
      // Check if the same entity value exists under other profiles
      const allMatches = await db.query(
        `SELECT DISTINCT profile_id FROM osint_entities WHERE entity_type = $1 AND value = $2 AND profile_id != $3`,
        [entity.entity_type, entity.value, profileId]
      );

      for (const match of allMatches.rows) {
        // Get the other profile's root entity
        const otherProfile = await db.getOsintProfile(match.profile_id);
        if (!otherProfile) continue;

        // Create cross-profile relationship
        const otherRootEntities = await db.getOsintEntities({ type: otherProfile.profile_type, profileId: match.profile_id, limit: 1 });
        const myRootEntities = await db.getOsintEntities({ type: (await db.getOsintProfile(profileId))?.profile_type, profileId, limit: 1 });

        const myRoot = myRootEntities.find((e) => e.profile_id === profileId);
        const otherRoot = otherRootEntities.find((e) => e.profile_id === match.profile_id);

        if (myRoot && otherRoot) {
          await db.upsertOsintRelationship({
            source_entity_id: myRoot.id,
            target_entity_id: otherRoot.id,
            relationship: "associated_with",
            confidence: CONFIDENCE.CROSS_PROFILE,
            source_module: "correlator",
            evidence: `Shared entity: ${entity.entity_type}:${entity.value}`,
          });
        }
      }
    }
  } catch (err) {
    console.error(`[correlator] Cross-profile correlation error:`, err.message);
  }
}

module.exports = {
  correlateScanResults,
  crossProfileCorrelation,
  CONFIDENCE,
};
