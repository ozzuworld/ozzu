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
        const subValue = typeof sub === "string" ? sub : sub.subdomain || JSON.stringify(sub);
        entities.push({
          entity_type: "domain", value: subValue, label: subValue,
          metadata: { parentDomain: profile.value, source: f.raw_data.source || "discovery" }, source_module: "domain-recon",
        });
        relationships.push({
          fromType: "domain", fromValue: profile.value, toType: "domain", toValue: subValue,
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

  // social-deep: Instagram profile → social_account entity
  {
    module: "social-deep",
    match: (f) => f.raw_data?.platform === "instagram" && f.raw_data?.profileData,
    extract: (f, profile) => {
      const d = f.raw_data.profileData;
      const entities = [{
        entity_type: "social_account", value: `instagram:${d.username || profile.value}`, label: `Instagram (${d.username || profile.value})`,
        metadata: { ...d, platform: "instagram" }, source_module: "social-deep",
      }];
      const relationships = [{
        fromType: "username", fromValue: profile.value, toType: "social_account", toValue: `instagram:${d.username || profile.value}`,
        relationship: "uses", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: "Instagram profile data",
      }];
      if (d.full_name || d.name) {
        const name = d.full_name || d.name;
        entities.push({ entity_type: "person", value: name.toLowerCase(), label: name, metadata: { source: "instagram" }, source_module: "social-deep" });
        relationships.push({ fromType: "social_account", fromValue: `instagram:${d.username || profile.value}`, toType: "person", toValue: name.toLowerCase(), relationship: "linked_to", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `Instagram name: ${name}` });
      }
      return { entities, relationships };
    },
  },

  // social-deep: TikTok profile → social_account entity
  {
    module: "social-deep",
    match: (f) => f.raw_data?.platform === "tiktok" && f.raw_data?.profileData,
    extract: (f, profile) => {
      const d = f.raw_data.profileData;
      const entities = [{
        entity_type: "social_account", value: `tiktok:${d.uniqueId || profile.value}`, label: `TikTok (${d.uniqueId || profile.value})`,
        metadata: { ...d, platform: "tiktok" }, source_module: "social-deep",
      }];
      const relationships = [{
        fromType: "username", fromValue: profile.value, toType: "social_account", toValue: `tiktok:${d.uniqueId || profile.value}`,
        relationship: "uses", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: "TikTok profile data",
      }];
      if (d.nickname || d.name) {
        const name = d.nickname || d.name;
        entities.push({ entity_type: "person", value: name.toLowerCase(), label: name, metadata: { source: "tiktok" }, source_module: "social-deep" });
        relationships.push({ fromType: "social_account", fromValue: `tiktok:${d.uniqueId || profile.value}`, toType: "person", toValue: name.toLowerCase(), relationship: "linked_to", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `TikTok name: ${name}` });
      }
      return { entities, relationships };
    },
  },

  // social-deep: Twitter/X profile → social_account entity
  {
    module: "social-deep",
    match: (f) => f.raw_data?.platform === "twitter" && f.raw_data?.profileData,
    extract: (f, profile) => {
      const d = f.raw_data.profileData;
      const entities = [{
        entity_type: "social_account", value: `twitter:${d.screen_name || profile.value}`, label: `Twitter (${d.screen_name || profile.value})`,
        metadata: { ...d, platform: "twitter" }, source_module: "social-deep",
      }];
      const relationships = [{
        fromType: "username", fromValue: profile.value, toType: "social_account", toValue: `twitter:${d.screen_name || profile.value}`,
        relationship: "uses", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: "Twitter profile data",
      }];
      if (d.name) {
        entities.push({ entity_type: "person", value: d.name.toLowerCase(), label: d.name, metadata: { source: "twitter" }, source_module: "social-deep" });
        relationships.push({ fromType: "social_account", fromValue: `twitter:${d.screen_name || profile.value}`, toType: "person", toValue: d.name.toLowerCase(), relationship: "linked_to", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `Twitter name: ${d.name}` });
      }
      if (d.location) {
        entities.push({ entity_type: "location", value: d.location.toLowerCase(), label: d.location, metadata: { source: "twitter" }, source_module: "social-deep" });
        relationships.push({ fromType: "social_account", fromValue: `twitter:${d.screen_name || profile.value}`, toType: "location", toValue: d.location.toLowerCase(), relationship: "associated_with", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `Twitter location: ${d.location}` });
      }
      return { entities, relationships };
    },
  },

  // social-deep: GitHub twitter_username → linked social_account
  {
    module: "social-deep",
    match: (f) => f.raw_data?.platform === "github" && f.raw_data?.profileData?.twitter_username,
    extract: (f, profile) => {
      const tw = f.raw_data.profileData.twitter_username;
      return {
        entities: [{
          entity_type: "social_account", value: `twitter:${tw}`, label: `Twitter (@${tw})`,
          metadata: { platform: "twitter", linkedFrom: "github" }, source_module: "social-deep",
        }],
        relationships: [{
          fromType: "social_account", fromValue: `github:${profile.value}`, toType: "social_account", toValue: `twitter:${tw}`,
          relationship: "linked_to", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `GitHub profile links Twitter: @${tw}`,
        }],
      };
    },
  },

  // web-crawler: discovered social links → social_account entities
  {
    module: "web-crawler",
    match: (f) => f.raw_data?.socialLinks && Array.isArray(f.raw_data.socialLinks) && f.raw_data.socialLinks.length > 0,
    extract: (f, profile) => {
      const entities = [];
      const relationships = [];
      const platformPatterns = [
        { pattern: /twitter\.com\/(\w+)/i, platform: "twitter" },
        { pattern: /x\.com\/(\w+)/i, platform: "twitter" },
        { pattern: /instagram\.com\/(\w+)/i, platform: "instagram" },
        { pattern: /facebook\.com\/(\w+)/i, platform: "facebook" },
        { pattern: /linkedin\.com\/in\/([^/]+)/i, platform: "linkedin" },
        { pattern: /github\.com\/(\w+)/i, platform: "github" },
        { pattern: /tiktok\.com\/@?(\w+)/i, platform: "tiktok" },
        { pattern: /youtube\.com\/(channel|c|@)\/([^/]+)/i, platform: "youtube" },
      ];
      for (const link of f.raw_data.socialLinks.slice(0, 15)) {
        const url = typeof link === "string" ? link : link.url || link.href || "";
        for (const pp of platformPatterns) {
          const m = url.match(pp.pattern);
          if (m) {
            const username = pp.platform === "youtube" ? m[2] : m[1];
            entities.push({
              entity_type: "social_account", value: `${pp.platform}:${username}`, label: `${pp.platform} (${username})`,
              metadata: { platform: pp.platform, url, source: "web_crawler" }, source_module: "web-crawler",
            });
            relationships.push({
              fromType: profile.profile_type, fromValue: profile.value, toType: "social_account", toValue: `${pp.platform}:${username}`,
              relationship: "associated_with", confidence: 80, evidence: `Social link found on page: ${url}`,
            });
            break;
          }
        }
      }
      return { entities, relationships };
    },
  },

  // document-meta: author → person entity
  {
    module: "document-meta",
    match: (f) => f.raw_data?.metadata?.Author,
    extract: (f, profile) => ({
      entities: [{
        entity_type: "person", value: f.raw_data.metadata.Author.toLowerCase(), label: f.raw_data.metadata.Author,
        metadata: { source: "document_metadata", document: f.source_url || f.title }, source_module: "document-meta",
      }],
      relationships: [{
        fromType: profile.profile_type, fromValue: profile.value, toType: "person", toValue: f.raw_data.metadata.Author.toLowerCase(),
        relationship: "associated_with", confidence: 70, evidence: `Document author: ${f.raw_data.metadata.Author}`,
      }],
    }),
  },

  // shodan-lookup: SSL SANs → domain entities
  {
    module: "shodan-lookup",
    match: (f) => f.raw_data?.sslCert?.extensions?.subjectAltName,
    extract: (f, profile) => {
      const san = f.raw_data.sslCert.extensions.subjectAltName;
      const domains = (typeof san === "string" ? san.split(",") : Array.isArray(san) ? san : [])
        .map(s => s.replace(/^DNS:/i, "").trim()).filter(s => s && s.includes(".")).slice(0, 20);
      const entities = [];
      const relationships = [];
      for (const domain of domains) {
        entities.push({
          entity_type: "domain", value: domain.toLowerCase(), label: domain,
          metadata: { source: "ssl_san", ip: profile.value }, source_module: "shodan-lookup",
        });
        relationships.push({
          fromType: profile.profile_type, fromValue: profile.value, toType: "domain", toValue: domain.toLowerCase(),
          relationship: "associated_with", confidence: 85, evidence: `SSL SAN: ${domain}`,
        });
      }
      return { entities, relationships };
    },
  },

  // paste-monitor: source site → organization entity
  {
    module: "paste-monitor",
    match: (f) => f.raw_data?.source && f.severity !== "info",
    extract: (f, profile) => ({
      entities: [{
        entity_type: "organization", value: `pastesite:${(f.raw_data.source || "unknown").toLowerCase().replace(/\s+/g, "_")}`,
        label: `${f.raw_data.source} (paste site)`,
        metadata: { type: "paste_site", pasteId: f.raw_data.pasteId }, source_module: "paste-monitor",
      }],
      relationships: [{
        fromType: profile.profile_type, fromValue: profile.value,
        toType: "organization", toValue: `pastesite:${(f.raw_data.source || "unknown").toLowerCase().replace(/\s+/g, "_")}`,
        relationship: "found_on", confidence: 75, evidence: `Found in ${f.raw_data.source} paste`,
      }],
    }),
  },

  // shodan-lookup: open ports → ip entities
  {
    module: "shodan-lookup",
    match: (f) => f.raw_data?.ports && Array.isArray(f.raw_data.ports),
    extract: (f, profile) => {
      const entities = [];
      const relationships = [];
      const ip = f.raw_data.ip || profile.value;
      entities.push({
        entity_type: "ip", value: ip, label: ip,
        metadata: { ports: f.raw_data.ports, os: f.raw_data.os, hostnames: f.raw_data.hostnames },
        source_module: "shodan-lookup",
      });
      relationships.push({
        fromType: profile.profile_type, fromValue: profile.value, toType: "ip", toValue: ip,
        relationship: "resolves_to", confidence: 95, evidence: "Shodan host lookup: " + ip,
      });
      if (f.raw_data.org) {
        entities.push({
          entity_type: "organization", value: "hosting:" + f.raw_data.org.toLowerCase(), label: f.raw_data.org + " (hosting)",
          metadata: { type: "hosting_provider", isp: f.raw_data.isp }, source_module: "shodan-lookup",
        });
        relationships.push({
          fromType: "ip", fromValue: ip, toType: "organization", toValue: "hosting:" + f.raw_data.org.toLowerCase(),
          relationship: "hosted_on", confidence: 95, evidence: "Shodan org: " + f.raw_data.org,
        });
      }
      return { entities, relationships };
    },
  },

  // image-search: EXIF GPS coordinates → location entity
  {
    module: "image-search",
    match: (f) => f.raw_data?.exif?.latitude && f.raw_data?.exif?.longitude,
    extract: (f, profile) => {
      const lat = f.raw_data.exif.latitude;
      const lon = f.raw_data.exif.longitude;
      return {
        entities: [{
          entity_type: "location", value: lat.toFixed(4) + "," + lon.toFixed(4), label: "GPS: " + lat.toFixed(4) + ", " + lon.toFixed(4),
          metadata: { latitude: lat, longitude: lon, source: "exif", imageUrl: f.source_url }, source_module: "image-search",
        }],
        relationships: [{
          fromType: profile.profile_type, fromValue: profile.value, toType: "location", toValue: lat.toFixed(4) + "," + lon.toFixed(4),
          relationship: "associated_with", confidence: 99, evidence: "EXIF GPS from image: " + (f.source_url || "avatar"),
        }],
      };
    },
  },

  // web-crawler: discovered emails → email entities
  {
    module: "web-crawler",
    match: (f) => f.raw_data?.emails && Array.isArray(f.raw_data.emails) && f.raw_data.emails.length > 0,
    extract: (f, profile) => {
      const entities = [];
      const relationships = [];
      for (const email of f.raw_data.emails.slice(0, 10)) {
        entities.push({
          entity_type: "email", value: email.toLowerCase(), label: email,
          metadata: { source: "web_crawler", pageUrl: f.source_url }, source_module: "web-crawler",
        });
        relationships.push({
          fromType: profile.profile_type, fromValue: profile.value, toType: "email", toValue: email.toLowerCase(),
          relationship: "associated_with", confidence: 85, evidence: "Found on page: " + (f.source_url || profile.value),
        });
      }
      return { entities, relationships };
    },
  },

  // web-crawler: discovered phone numbers → phone entities
  {
    module: "web-crawler",
    match: (f) => f.raw_data?.phones && Array.isArray(f.raw_data.phones) && f.raw_data.phones.length > 0,
    extract: (f, profile) => {
      const entities = [];
      const relationships = [];
      for (const phone of f.raw_data.phones.slice(0, 5)) {
        entities.push({
          entity_type: "phone", value: phone, label: phone,
          metadata: { source: "web_crawler", pageUrl: f.source_url }, source_module: "web-crawler",
        });
        relationships.push({
          fromType: profile.profile_type, fromValue: profile.value, toType: "phone", toValue: phone,
          relationship: "associated_with", confidence: 85, evidence: "Found on page: " + (f.source_url || profile.value),
        });
      }
      return { entities, relationships };
    },
  },

  // secret-scanner: leaked API key → service entity
  {
    module: "secret-scanner",
    match: (f) => f.raw_data?.secretType && f.severity !== "info",
    extract: (f, profile) => ({
      entities: [{
        entity_type: "organization", value: "service:" + (f.raw_data.secretType || "unknown").toLowerCase().replace(/\s+/g, "_"),
        label: f.raw_data.secretType,
        metadata: { type: "leaked_credential", severity: f.severity, source: f.raw_data.source },
        source_module: "secret-scanner",
      }],
      relationships: [{
        fromType: profile.profile_type, fromValue: profile.value,
        toType: "organization", toValue: "service:" + (f.raw_data.secretType || "unknown").toLowerCase().replace(/\s+/g, "_"),
        relationship: "uses", confidence: 90, evidence: "Leaked " + f.raw_data.secretType + " credential found",
      }],
    }),
  },

  // email-domain: DKIM infrastructure → organization entity
  {
    module: "email-domain",
    match: (f) => f.raw_data?.dkimSelectors && Array.isArray(f.raw_data.dkimSelectors),
    extract: (f, profile) => {
      const domain = profile.value.split("@")[1] || profile.value;
      const entities = [];
      const relationships = [];
      const infraSet = new Set();
      for (const dk of f.raw_data.dkimSelectors) {
        if (dk.infrastructure && dk.infrastructure !== "Unknown" && !infraSet.has(dk.infrastructure)) {
          infraSet.add(dk.infrastructure);
          entities.push({
            entity_type: "organization", value: "mailinfra:" + dk.infrastructure.toLowerCase().replace(/\s+/g, "_"),
            label: dk.infrastructure + " (email)",
            metadata: { type: "email_infrastructure", selector: dk.selector, domain },
            source_module: "email-domain",
          });
          relationships.push({
            fromType: "domain", fromValue: domain,
            toType: "organization", toValue: "mailinfra:" + dk.infrastructure.toLowerCase().replace(/\s+/g, "_"),
            relationship: "uses", confidence: 90, evidence: 'DKIM selector "' + dk.selector + '" \u2192 ' + dk.infrastructure,
          });
        }
      }
      return { entities, relationships };
    },
  },

  // exif-extract: GPS coordinates → location entity
  {
    module: "exif-extract",
    match: (f) => f.raw_data?.latitude && f.raw_data?.longitude && f.raw_data?.gps,
    extract: (f, profile) => ({
      entities: [{
        entity_type: "location", value: f.raw_data.latitude.toFixed(4) + "," + f.raw_data.longitude.toFixed(4),
        label: "GPS: " + f.raw_data.latitude.toFixed(4) + ", " + f.raw_data.longitude.toFixed(4),
        metadata: { latitude: f.raw_data.latitude, longitude: f.raw_data.longitude, altitude: f.raw_data.altitude, source: "exif" },
        source_module: "exif-extract",
      }],
      relationships: [{
        fromType: "image", fromValue: profile.value, toType: "location",
        toValue: f.raw_data.latitude.toFixed(4) + "," + f.raw_data.longitude.toFixed(4),
        relationship: "associated_with", confidence: 99, evidence: "EXIF GPS from uploaded image",
      }],
    }),
  },

  // exif-extract: author/copyright → person entity
  {
    module: "exif-extract",
    match: (f) => f.raw_data?.author,
    extract: (f, profile) => ({
      entities: [{
        entity_type: "person", value: f.raw_data.author.toLowerCase(), label: f.raw_data.author,
        metadata: { source: "exif_author", copyright: f.raw_data.copyright }, source_module: "exif-extract",
      }],
      relationships: [{
        fromType: "image", fromValue: profile.value, toType: "person",
        toValue: f.raw_data.author.toLowerCase(),
        relationship: "created_by", confidence: 85, evidence: "EXIF author: " + f.raw_data.author,
      }],
    }),
  },

  // exif-extract: camera serial → device fingerprint entity
  {
    module: "exif-extract",
    match: (f) => f.raw_data?.serialNumber,
    extract: (f, profile) => ({
      entities: [{
        entity_type: "device", value: "camera:" + f.raw_data.serialNumber, label: "Camera S/N: " + f.raw_data.serialNumber,
        metadata: { serialNumber: f.raw_data.serialNumber, source: "exif" }, source_module: "exif-extract",
      }],
      relationships: [{
        fromType: "image", fromValue: profile.value, toType: "device",
        toValue: "camera:" + f.raw_data.serialNumber,
        relationship: "taken_with", confidence: 90, evidence: "EXIF camera serial: " + f.raw_data.serialNumber,
      }],
    }),
  },

  // reverse-image: web detection pages → domain entities
  {
    module: "reverse-image",
    match: (f) => f.raw_data?.fullMatches || f.raw_data?.partialMatches,
    extract: (f, profile) => {
      const entities = [];
      const relationships = [];
      const urls = [...(f.raw_data.fullMatches || []), ...(f.raw_data.partialMatches || [])];
      const seen = new Set();
      for (const url of urls.slice(0, 10)) {
        try {
          const domain = new URL(url).hostname.replace(/^www\./, "");
          if (seen.has(domain)) continue;
          seen.add(domain);
          entities.push({
            entity_type: "domain", value: domain, label: domain,
            metadata: { source: "reverse_image", imageUrl: url }, source_module: "reverse-image",
          });
          relationships.push({
            fromType: "image", fromValue: profile.value, toType: "domain", toValue: domain,
            relationship: "found_on", confidence: 90, evidence: "Image found on: " + url,
          });
        } catch { /* invalid URL */ }
      }
      return { entities, relationships };
    },
  },

  // reverse-image: web entities → person entities
  {
    module: "reverse-image",
    match: (f) => f.raw_data?.webEntities && Array.isArray(f.raw_data.webEntities),
    extract: (f, profile) => {
      const entities = [];
      const relationships = [];
      for (const we of f.raw_data.webEntities.slice(0, 5)) {
        if (!we.description) continue;
        entities.push({
          entity_type: "person", value: we.description.toLowerCase(), label: we.description,
          metadata: { score: we.score, source: "google_vision" }, source_module: "reverse-image",
        });
        relationships.push({
          fromType: "image", fromValue: profile.value, toType: "person",
          toValue: we.description.toLowerCase(),
          relationship: "associated_with", confidence: Math.round((we.score || 0.5) * 100),
          evidence: "Google Vision web entity: " + we.description,
        });
      }
      return { entities, relationships };
    },
  },

  // avatar-compare: pHash match → cross-profile relationship
  {
    module: "avatar-compare",
    match: (f) => f.raw_data?.pHashMatch && f.raw_data?.matchedProfileId,
    extract: (f, profile) => ({
      entities: [{
        entity_type: "image", value: f.raw_data.avatarUrl, label: "Matched avatar (" + (f.raw_data.matchedProfileLabel || f.raw_data.platform) + ")",
        metadata: { similarity: f.raw_data.similarity, platform: f.raw_data.platform, matchedProfileId: f.raw_data.matchedProfileId },
        source_module: "avatar-compare",
      }],
      relationships: [{
        fromType: "image", fromValue: profile.value, toType: "image", toValue: f.raw_data.avatarUrl,
        relationship: "same_as", confidence: f.raw_data.similarity,
        evidence: "pHash match " + f.raw_data.similarity + "% with " + (f.raw_data.matchedProfileLabel || "profile #" + f.raw_data.matchedProfileId),
      }],
    }),
  },

  // maigret-enum: found account → social_account entity
  {
    module: "maigret-enum",
    match: (f) => f.category === "account_found" && f.raw_data?.found === true,
    extract: (f, profile) => ({
      entities: [{
        entity_type: "social_account", value: (f.raw_data.platform || "unknown").toLowerCase() + ":" + profile.value,
        label: (f.raw_data.platform || "unknown") + " (" + profile.value + ")",
        metadata: { platform: f.raw_data.platform, url: f.raw_data.url, source: "maigret" },
        source_module: "maigret-enum",
      }],
      relationships: [{
        fromType: "username", fromValue: profile.value,
        toType: "social_account", toValue: (f.raw_data.platform || "unknown").toLowerCase() + ":" + profile.value,
        relationship: "uses", confidence: CONFIDENCE.PLATFORM_CONFIRMED,
        evidence: "Maigret: account found on " + (f.raw_data.platform || "unknown"),
      }],
    }),
  },

  // holehe-check: email registered → social_account entity
  {
    module: "holehe-check",
    match: (f) => f.category === "account_found" && f.raw_data?.found === true,
    extract: (f, profile) => ({
      entities: [{
        entity_type: "social_account", value: (f.raw_data.platform || "unknown").toLowerCase() + ":" + profile.value,
        label: (f.raw_data.platform || "unknown") + " (email)",
        metadata: { platform: f.raw_data.platform, emailRecovery: f.raw_data.emailRecovery, phoneRecovery: f.raw_data.phoneRecovery, source: "holehe" },
        source_module: "holehe-check",
      }],
      relationships: [{
        fromType: "email", fromValue: profile.value,
        toType: "social_account", toValue: (f.raw_data.platform || "unknown").toLowerCase() + ":" + profile.value,
        relationship: "registered_on", confidence: 85,
        evidence: "Holehe: email registered on " + (f.raw_data.platform || "unknown"),
      }],
    }),
  },

  // virustotal-lookup: detection → threat entity
  {
    module: "virustotal-lookup",
    match: (f) => f.raw_data?.stats && (f.raw_data.stats.malicious > 0 || f.raw_data.stats.suspicious > 0),
    extract: (f, profile) => ({
      entities: [{
        entity_type: "organization", value: "threat:virustotal_flagged",
        label: "VirusTotal Detection",
        metadata: { stats: f.raw_data.stats, source: "virustotal" },
        source_module: "virustotal-lookup",
      }],
      relationships: [{
        fromType: profile.profile_type, fromValue: profile.value,
        toType: "organization", toValue: "threat:virustotal_flagged",
        relationship: "flagged_by", confidence: 90,
        evidence: "VirusTotal: " + (f.raw_data.stats.malicious || 0) + " malicious detections",
      }],
    }),
  },

  // otx-intel: threat pulses → threat entity
  {
    module: "otx-intel",
    match: (f) => f.raw_data?.pulseCount > 0,
    extract: (f, profile) => ({
      entities: [{
        entity_type: "organization", value: "threat:otx_pulses",
        label: "OTX Threat Intelligence",
        metadata: { pulseCount: f.raw_data.pulseCount, source: "otx" },
        source_module: "otx-intel",
      }],
      relationships: [{
        fromType: profile.profile_type, fromValue: profile.value,
        toType: "organization", toValue: "threat:otx_pulses",
        relationship: "flagged_by", confidence: 80,
        evidence: "AlienVault OTX: " + f.raw_data.pulseCount + " threat pulse(s)",
      }],
    }),
  },

  // h8mail-breach: breach data → organization entity
  {
    module: "h8mail-breach",
    match: (f) => f.category === "breach" && f.raw_data?.breachSource,
    extract: (f, profile) => ({
      entities: [{
        entity_type: "organization", value: "breach:" + f.raw_data.breachSource.toLowerCase().replace(/\s+/g, "_"),
        label: f.raw_data.breachSource + " (breach)",
        metadata: { hasPassword: f.raw_data.hasPassword, source: "h8mail" },
        source_module: "h8mail-breach",
      }],
      relationships: [{
        fromType: "email", fromValue: profile.value,
        toType: "organization", toValue: "breach:" + f.raw_data.breachSource.toLowerCase().replace(/\s+/g, "_"),
        relationship: "found_on", confidence: 85,
        evidence: "h8mail breach: " + f.raw_data.breachSource,
      }],
    }),
  },

  // ── Defensive Intelligence (Epic 7) ──

  // ghunt-email: Google display name → person entity
  {
    module: "ghunt-email",
    match: (f) => f.raw_data?.tool === "ghunt" && f.raw_data?.displayName,
    extract: (f, profile) => ({
      entities: [{
        entity_type: "person", value: f.raw_data.displayName.toLowerCase().replace(/\s+/g, "_"),
        label: f.raw_data.displayName + " (Google)",
        metadata: { gaiaId: f.raw_data.gaiaId, source: "ghunt" },
        source_module: "ghunt-email",
      }],
      relationships: [{
        fromType: "email", fromValue: profile.value,
        toType: "person", toValue: f.raw_data.displayName.toLowerCase().replace(/\s+/g, "_"),
        relationship: "owns", confidence: 95,
        evidence: "GHunt: Google account display name",
      }],
    }),
  },

  // ghunt-email: YouTube channels → social_account entities
  {
    module: "ghunt-email",
    match: (f) => f.raw_data?.tool === "ghunt" && f.raw_data?.youtube,
    extract: (f, profile) => {
      const channels = Array.isArray(f.raw_data.youtube) ? f.raw_data.youtube : [f.raw_data.youtube];
      return {
        entities: channels.map((c) => ({
          entity_type: "social_account", value: `youtube:${(c.name || c.title || "channel").toLowerCase()}`,
          label: `YouTube (${c.name || c.title || "channel"})`,
          metadata: { url: c.url || c.channelUrl, source: "ghunt" },
          source_module: "ghunt-email",
        })),
        relationships: channels.map((c) => ({
          fromType: "email", fromValue: profile.value,
          toType: "social_account", toValue: `youtube:${(c.name || c.title || "channel").toLowerCase()}`,
          relationship: "linked_to", confidence: 90,
          evidence: "GHunt: YouTube channel linked to Google account",
        })),
      };
    },
  },

  // ghunt-email: Maps reviews → location entities
  {
    module: "ghunt-email",
    match: (f) => f.raw_data?.tool === "ghunt" && f.raw_data?.reviews && Array.isArray(f.raw_data.reviews),
    extract: (f, profile) => {
      const reviews = f.raw_data.reviews.slice(0, 10);
      return {
        entities: reviews.filter((r) => r.place || r.name || r.location).map((r) => ({
          entity_type: "location", value: (r.place || r.name || r.location).toLowerCase(),
          label: r.place || r.name || r.location,
          metadata: { source: "google_maps_review" },
          source_module: "ghunt-email",
        })),
        relationships: reviews.filter((r) => r.place || r.name || r.location).map((r) => ({
          fromType: "email", fromValue: profile.value,
          toType: "location", toValue: (r.place || r.name || r.location).toLowerCase(),
          relationship: "visited", confidence: 85,
          evidence: "GHunt: Google Maps review",
        })),
      };
    },
  },

  // dnstwist-scan: lookalike domains → domain entities
  {
    module: "dnstwist-scan",
    match: (f) => f.raw_data?.tool === "dnstwist" && f.raw_data?.domains && Array.isArray(f.raw_data.domains),
    extract: (f, profile) => {
      const domains = f.raw_data.domains.slice(0, 15);
      return {
        entities: domains.map((d) => ({
          entity_type: "domain", value: d.domain,
          label: d.domain + " (lookalike)",
          metadata: { fuzzer: d.fuzzer, registrar: d.whois_registrar, source: "dnstwist" },
          source_module: "dnstwist-scan",
        })),
        relationships: domains.map((d) => ({
          fromType: "domain", fromValue: profile.value,
          toType: "domain", toValue: d.domain,
          relationship: "impersonated_by", confidence: 80,
          evidence: "dnstwist: " + (d.fuzzer || "unknown") + " lookalike",
        })),
      };
    },
  },

  // crtsh-monitor: certificate subdomains → domain entities
  {
    module: "crtsh-monitor",
    match: (f) => f.raw_data?.tool === "crtsh" && f.raw_data?.subdomains && f.raw_data.subdomains.length > 0,
    extract: (f, profile) => {
      const subs = f.raw_data.subdomains.slice(0, 20);
      return {
        entities: subs.map((s) => ({
          entity_type: "domain", value: s,
          label: s + " (CT log)",
          metadata: { source: "crtsh" },
          source_module: "crtsh-monitor",
        })),
        relationships: subs.map((s) => ({
          fromType: "domain", fromValue: profile.value,
          toType: "domain", toValue: s,
          relationship: "has_subdomain", confidence: CONFIDENCE.CERT_TRANSPARENCY,
          evidence: "crt.sh certificate transparency log",
        })),
      };
    },
  },

  // darkweb-search: dark web mentions → threat entities
  {
    module: "darkweb-search",
    match: (f) => f.raw_data?.tool === "darkweb-search" && f.severity !== "info",
    extract: (f, profile) => {
      const results = f.raw_data.marketplaces || f.raw_data.forums || f.raw_data.results || [];
      return {
        entities: [{
          entity_type: "organization", value: "darkweb:ahmia_mention:" + profile.value.replace(/[^a-z0-9]/gi, "_"),
          label: "Dark Web Mention (" + profile.value + ")",
          metadata: { resultCount: results.length, source: "ahmia" },
          source_module: "darkweb-search",
        }],
        relationships: [{
          fromType: profile.profile_type, fromValue: profile.value,
          toType: "organization", toValue: "darkweb:ahmia_mention:" + profile.value.replace(/[^a-z0-9]/gi, "_"),
          relationship: "found_on", confidence: 75,
          evidence: results.length + " dark web result(s) via Ahmia",
        }],
      };
    },
  },

  // leak-search: IntelX leak records → breach entities
  {
    module: "leak-search",
    match: (f) => f.raw_data?.tool === "leak-search" && f.raw_data?.source === "intelx" && f.severity !== "info",
    extract: (f, profile) => {
      const records = f.raw_data.leaks || f.raw_data.pastes || f.raw_data.darknet || f.raw_data.other || [];
      return {
        entities: records.slice(0, 10).map((r) => ({
          entity_type: "organization", value: "intelx:" + (r.name || "unknown").toLowerCase().replace(/[^a-z0-9]/g, "_"),
          label: (r.name || "Unknown") + " (IntelX)",
          metadata: { bucket: r.bucket, date: r.date, source: "intelx" },
          source_module: "leak-search",
        })),
        relationships: records.slice(0, 10).map((r) => ({
          fromType: profile.profile_type, fromValue: profile.value,
          toType: "organization", toValue: "intelx:" + (r.name || "unknown").toLowerCase().replace(/[^a-z0-9]/g, "_"),
          relationship: "found_on", confidence: 85,
          evidence: "IntelX: found in " + (r.bucket || "unknown source"),
        })),
      };
    },
  },

  // ── Colombian OSINT (CO Epic) ──

  // co-adres: Health affiliation → person + location entities
  {
    module: "co-adres",
    match: (f) => f.severity !== "info" && f.raw_data && (f.raw_data.primerNombre || f.raw_data.nombre),
    extract: (f, profile) => {
      const d = f.raw_data;
      const entities = [];
      const relationships = [];
      const fullName = [d.primerNombre, d.segundoNombre, d.primerApellido, d.segundoApellido]
        .filter(Boolean).join(" ") || d.nombre;
      if (fullName) {
        entities.push({
          entity_type: "person", value: fullName.toLowerCase(), label: fullName,
          metadata: { source: "adres", eps: d.eps || d.entidad, regime: d.tipoAfiliado || d.regimen },
          source_module: "co-adres",
        });
        relationships.push({
          fromType: "cedula", fromValue: profile.value, toType: "person", toValue: fullName.toLowerCase(),
          relationship: "registered_to", confidence: 90, evidence: "ADRES health affiliation: " + fullName,
        });
      }
      const municipality = d.municipio || d.nombreMunicipio;
      const department = d.departamento || d.nombreDepartamento;
      if (municipality) {
        const loc = (municipality + (department ? ", " + department : "")).toLowerCase();
        entities.push({
          entity_type: "location", value: loc, label: municipality + (department ? ", " + department : ""),
          metadata: { source: "adres", type: "health_affiliation_municipality" }, source_module: "co-adres",
        });
        relationships.push({
          fromType: "cedula", fromValue: profile.value, toType: "location", toValue: loc,
          relationship: "associated_with", confidence: 80, evidence: "ADRES municipality: " + municipality,
        });
      }
      if (d.eps || d.entidad) {
        const eps = (d.eps || d.entidad || "").toLowerCase().replace(/\s+/g, "_");
        entities.push({
          entity_type: "organization", value: "eps:" + eps, label: d.eps || d.entidad,
          metadata: { type: "health_insurance", regime: d.tipoAfiliado }, source_module: "co-adres",
        });
        relationships.push({
          fromType: "cedula", fromValue: profile.value, toType: "organization", toValue: "eps:" + eps,
          relationship: "member_of", confidence: 90, evidence: "ADRES: affiliated with " + (d.eps || d.entidad),
        });
      }
      return { entities, relationships };
    },
  },

  // co-sigep: Public servant → person + organization entities
  {
    module: "co-sigep",
    match: (f) => f.severity !== "info" && f.raw_data && (f.raw_data.name || f.raw_data.entity),
    extract: (f, profile) => {
      const d = f.raw_data;
      const entities = [];
      const relationships = [];
      if (d.name) {
        entities.push({
          entity_type: "person", value: d.name.toLowerCase(), label: d.name,
          metadata: { source: "sigep", position: d.position, entity: d.entity }, source_module: "co-sigep",
        });
        relationships.push({
          fromType: "cedula", fromValue: profile.value, toType: "person", toValue: d.name.toLowerCase(),
          relationship: "registered_to", confidence: 90, evidence: "SIGEP: " + d.name,
        });
      }
      if (d.entity) {
        const org = d.entity.toLowerCase().replace(/\s+/g, "_");
        entities.push({
          entity_type: "organization", value: "gov:" + org, label: d.entity,
          metadata: { type: "government_entity", position: d.position }, source_module: "co-sigep",
        });
        relationships.push({
          fromType: "cedula", fromValue: profile.value, toType: "organization", toValue: "gov:" + org,
          relationship: "member_of", confidence: 90, evidence: "SIGEP: employed at " + d.entity,
        });
      }
      return { entities, relationships };
    },
  },

  // co-rues: Business registry → organization entities
  {
    module: "co-rues",
    match: (f) => f.severity !== "info" && f.raw_data && (f.raw_data.businesses || f.raw_data.razonSocial),
    extract: (f, profile) => {
      const businesses = f.raw_data.businesses || [f.raw_data];
      const entities = [];
      const relationships = [];
      for (const biz of businesses.slice(0, 10)) {
        const name = biz.razonSocial || biz.nombre || biz.name;
        if (!name) continue;
        const org = name.toLowerCase().replace(/\s+/g, "_");
        entities.push({
          entity_type: "organization", value: "rues:" + org, label: name,
          metadata: { nit: biz.nit, ciiu: biz.ciiu, estado: biz.estado, source: "rues" }, source_module: "co-rues",
        });
        relationships.push({
          fromType: profile.profile_type, fromValue: profile.value, toType: "organization", toValue: "rues:" + org,
          relationship: "owns", confidence: 85, evidence: "RUES: registered business " + name,
        });
      }
      return { entities, relationships };
    },
  },

  // co-secop: Government contracts → organization entities
  {
    module: "co-secop",
    match: (f) => f.severity !== "info" && f.raw_data && (f.raw_data.contracts || f.raw_data.totalContracts),
    extract: (f, profile) => {
      const contracts = f.raw_data.contracts || [];
      const entities = [];
      const relationships = [];
      const seenEntities = new Set();
      for (const c of contracts.slice(0, 10)) {
        const entity = c.entidad || c.nombre_entidad;
        if (!entity || seenEntities.has(entity.toLowerCase())) continue;
        seenEntities.add(entity.toLowerCase());
        const org = entity.toLowerCase().replace(/\s+/g, "_");
        entities.push({
          entity_type: "organization", value: "secop:" + org, label: entity,
          metadata: { type: "government_entity", source: "secop" }, source_module: "co-secop",
        });
        relationships.push({
          fromType: profile.profile_type, fromValue: profile.value, toType: "organization", toValue: "secop:" + org,
          relationship: "associated_with", confidence: 80, evidence: "SECOP: government contract with " + entity,
        });
      }
      return { entities, relationships };
    },
  },

  // co-dian: Tax registry → person entity
  {
    module: "co-dian",
    match: (f) => f.severity !== "info" && f.raw_data && (f.raw_data.name || f.raw_data.razonSocial),
    extract: (f, profile) => {
      const d = f.raw_data;
      const name = d.name || d.razonSocial;
      if (!name) return { entities: [], relationships: [] };
      return {
        entities: [{
          entity_type: "person", value: name.toLowerCase(), label: name,
          metadata: { source: "dian", status: d.status, nit: d.nit, type: d.tipoContribuyente },
          source_module: "co-dian",
        }],
        relationships: [{
          fromType: profile.profile_type, fromValue: profile.value, toType: "person", toValue: name.toLowerCase(),
          relationship: "registered_to", confidence: 90, evidence: "DIAN RUT: " + name,
        }],
      };
    },
  },

  // co-rama-judicial: Court cases → organization entities (courts)
  {
    module: "co-rama-judicial",
    match: (f) => f.severity !== "info" && f.raw_data && f.raw_data.cases,
    extract: (f, profile) => {
      const cases = f.raw_data.cases || [];
      const entities = [];
      const relationships = [];
      const seenCourts = new Set();
      for (const c of cases.slice(0, 5)) {
        const court = c.despacho || c.Despacho;
        if (!court || seenCourts.has(court.toLowerCase())) continue;
        seenCourts.add(court.toLowerCase());
        const org = court.toLowerCase().replace(/\s+/g, "_").substring(0, 80);
        entities.push({
          entity_type: "organization", value: "court:" + org, label: court,
          metadata: { type: "judicial_court", caseType: c.tipoProceso || c.TipoProceso }, source_module: "co-rama-judicial",
        });
        relationships.push({
          fromType: "cedula", fromValue: profile.value, toType: "organization", toValue: "court:" + org,
          relationship: "associated_with", confidence: 90, evidence: "Rama Judicial: case at " + court,
        });
      }
      return { entities, relationships };
    },
  },

  // bluesky-intel: Bluesky profile → social_account entity
  {
    module: "bluesky-intel",
    match: (f) => f.category === "account_found" && f.raw_data?.platform === "bluesky",
    extract: (f, profile) => {
      const pd = f.raw_data?.profileData || {};
      const entities = [
        { entity_type: "social_account", value: `bluesky:${pd.handle || profile.value}`, label: `Bluesky (${pd.handle || profile.value})`, metadata: { platform: "bluesky", handle: pd.handle, did: pd.did, avatar: pd.avatar, followers: pd.followersCount }, source_module: "bluesky-intel" },
      ];
      const relationships = [
        { fromType: "username", fromValue: profile.value, toType: "social_account", toValue: `bluesky:${pd.handle || profile.value}`, relationship: "uses", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `Bluesky profile: @${pd.handle}` },
      ];
      if (pd.displayName) {
        entities.push({ entity_type: "person", value: pd.displayName.toLowerCase(), label: pd.displayName, metadata: { source: "bluesky" }, source_module: "bluesky-intel" });
        relationships.push({ fromType: "social_account", fromValue: `bluesky:${pd.handle || profile.value}`, toType: "person", toValue: pd.displayName.toLowerCase(), relationship: "linked_to", confidence: 80, evidence: "Bluesky display name" });
      }
      return { entities, relationships };
    },
  },

  // youtube-intel: YouTube channel → social_account entity
  {
    module: "youtube-intel",
    match: (f) => f.category === "account_found" && f.raw_data?.platform === "youtube",
    extract: (f, profile) => {
      const pd = f.raw_data?.profileData || {};
      return {
        entities: [
          { entity_type: "social_account", value: `youtube:${pd.channelName || profile.value}`, label: `YouTube (${pd.channelName || profile.value})`, metadata: { platform: "youtube", channelId: pd.channelId, subscribers: pd.subscriberCount, url: pd.channelUrl }, source_module: "youtube-intel" },
        ],
        relationships: [
          { fromType: "username", fromValue: profile.value, toType: "social_account", toValue: `youtube:${pd.channelName || profile.value}`, relationship: "uses", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `YouTube channel: ${pd.channelName}` },
        ],
      };
    },
  },

  // reddit-intel: Reddit profile → social_account entity
  {
    module: "reddit-intel",
    match: (f) => f.category === "account_found" && f.raw_data?.platform === "reddit",
    extract: (f, profile) => {
      const pd = f.raw_data?.profileData || {};
      const entities = [
        { entity_type: "social_account", value: `reddit:${pd.name || profile.value}`, label: `Reddit (u/${pd.name || profile.value})`, metadata: { platform: "reddit", karma: pd.total_karma, created: pd.created_utc, avatar: pd.icon_img }, source_module: "reddit-intel" },
      ];
      const relationships = [
        { fromType: "username", fromValue: profile.value, toType: "social_account", toValue: `reddit:${pd.name || profile.value}`, relationship: "uses", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `Reddit profile: u/${pd.name}` },
      ];
      if (pd.displayName && pd.displayName !== pd.name) {
        entities.push({ entity_type: "person", value: pd.displayName.toLowerCase(), label: pd.displayName, metadata: { source: "reddit" }, source_module: "reddit-intel" });
      }
      return { entities, relationships };
    },
  },

  // mastodon-intel: Mastodon profile → social_account entity + linked URLs
  {
    module: "mastodon-intel",
    match: (f) => f.category === "account_found" && f.raw_data?.platform === "mastodon",
    extract: (f, profile) => {
      const pd = f.raw_data?.profileData || {};
      const entities = [
        { entity_type: "social_account", value: `mastodon:${pd.acct}@${f.raw_data.instance}`, label: `Mastodon (@${pd.acct}@${f.raw_data.instance})`, metadata: { platform: "mastodon", instance: f.raw_data.instance, followers: pd.followers_count, avatar: pd.avatar }, source_module: "mastodon-intel" },
      ];
      const relationships = [
        { fromType: "username", fromValue: profile.value, toType: "social_account", toValue: `mastodon:${pd.acct}@${f.raw_data.instance}`, relationship: "uses", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `Mastodon profile on ${f.raw_data.instance}` },
      ];
      // Extract linked URLs from profile fields
      for (const link of (f.raw_data.linkedUrls || [])) {
        if (link.url) {
          try {
            const hostname = new URL(link.url).hostname;
            entities.push({ entity_type: "domain", value: hostname, label: `${link.name}: ${hostname}`, metadata: { verified: link.verified, linkedFrom: "mastodon" }, source_module: "mastodon-intel" });
            relationships.push({ fromType: "social_account", fromValue: `mastodon:${pd.acct}@${f.raw_data.instance}`, toType: "domain", toValue: hostname, relationship: "linked_to", confidence: link.verified ? 90 : 70, evidence: `Mastodon profile field: ${link.name}` });
          } catch (_) {}
        }
      }
      return { entities, relationships };
    },
  },

  // telegram-intel: Telegram channel/user → social_account entity
  {
    module: "telegram-intel",
    match: (f) => f.category === "account_found" && f.raw_data?.platform === "telegram",
    extract: (f, profile) => ({
      entities: [
        { entity_type: "social_account", value: `telegram:${f.raw_data?.profileData?.username || profile.value}`, label: `Telegram (${f.raw_data?.profileData?.name || profile.value})`, metadata: { platform: "telegram", name: f.raw_data?.profileData?.name, memberCount: f.raw_data?.profileData?.memberCount }, source_module: "telegram-intel" },
      ],
      relationships: [
        { fromType: "username", fromValue: profile.value, toType: "social_account", toValue: `telegram:${f.raw_data?.profileData?.username || profile.value}`, relationship: "uses", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `Telegram: ${f.raw_data?.profileData?.name || profile.value}` },
      ],
    }),
  },

  // instagram-intel: Instagram profile → social_account entity
  {
    module: "instagram-intel",
    match: (f) => f.category === "account_found" && f.raw_data?.platform === "instagram",
    extract: (f, profile) => {
      const pd = f.raw_data?.profileData || {};
      const entities = [
        { entity_type: "social_account", value: `instagram:${pd.username || profile.value}`, label: `Instagram (@${pd.username || profile.value})`, metadata: { platform: "instagram", followers: pd.followersCount, verified: pd.isVerified, avatar: pd.profilePicUrl, fbid: pd.fbid }, source_module: "instagram-intel" },
      ];
      const relationships = [
        { fromType: "username", fromValue: profile.value, toType: "social_account", toValue: `instagram:${pd.username || profile.value}`, relationship: "uses", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `Instagram profile: @${pd.username}` },
      ];
      if (pd.fullName) {
        entities.push({ entity_type: "person", value: pd.fullName.toLowerCase(), label: pd.fullName, metadata: { source: "instagram" }, source_module: "instagram-intel" });
        relationships.push({ fromType: "social_account", fromValue: `instagram:${pd.username || profile.value}`, toType: "person", toValue: pd.fullName.toLowerCase(), relationship: "linked_to", confidence: 80, evidence: "Instagram display name" });
      }
      if (pd.externalUrl) {
        try {
          const hostname = new URL(pd.externalUrl).hostname;
          entities.push({ entity_type: "domain", value: hostname, label: hostname, metadata: { linkedFrom: "instagram" }, source_module: "instagram-intel" });
          relationships.push({ fromType: "social_account", fromValue: `instagram:${pd.username || profile.value}`, toType: "domain", toValue: hostname, relationship: "linked_to", confidence: 85, evidence: "Instagram external URL" });
        } catch (_) {}
      }
      return { entities, relationships };
    },
  },

  // tiktok-intel: TikTok profile → social_account entity
  {
    module: "tiktok-intel",
    match: (f) => f.category === "account_found" && f.raw_data?.platform === "tiktok",
    extract: (f, profile) => {
      const pd = f.raw_data?.profileData || {};
      const entities = [
        { entity_type: "social_account", value: `tiktok:${pd.uniqueId || profile.value}`, label: `TikTok (@${pd.uniqueId || profile.value})`, metadata: { platform: "tiktok", followers: pd.followerCount, verified: pd.verified, avatar: pd.avatarLarger }, source_module: "tiktok-intel" },
      ];
      const relationships = [
        { fromType: "username", fromValue: profile.value, toType: "social_account", toValue: `tiktok:${pd.uniqueId || profile.value}`, relationship: "uses", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `TikTok profile: @${pd.uniqueId}` },
      ];
      if (pd.nickname) {
        entities.push({ entity_type: "person", value: pd.nickname.toLowerCase(), label: pd.nickname, metadata: { source: "tiktok" }, source_module: "tiktok-intel" });
      }
      return { entities, relationships };
    },
  },

  // facebook-intel: Facebook profile/page → social_account entity
  {
    module: "facebook-intel",
    match: (f) => f.category === "account_found" && f.raw_data?.platform === "facebook",
    extract: (f, profile) => {
      const pd = f.raw_data?.profileData || {};
      const entities = [
        { entity_type: "social_account", value: `facebook:${profile.value}`, label: `Facebook (${pd.name || profile.value})`, metadata: { platform: "facebook", name: pd.name, avatar: pd.profileImage, followersText: pd.followersText }, source_module: "facebook-intel" },
      ];
      const relationships = [
        { fromType: "username", fromValue: profile.value, toType: "social_account", toValue: `facebook:${profile.value}`, relationship: "uses", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `Facebook: ${pd.name || profile.value}` },
      ];
      if (pd.name) {
        entities.push({ entity_type: "person", value: pd.name.toLowerCase(), label: pd.name, metadata: { source: "facebook" }, source_module: "facebook-intel" });
      }
      return { entities, relationships };
    },
  },

  // linkedin-intel: LinkedIn profile → social_account entity
  {
    module: "linkedin-intel",
    match: (f) => f.category === "account_found" && f.raw_data?.platform === "linkedin",
    extract: (f, profile) => {
      const pd = f.raw_data?.profileData || {};
      const entities = [
        { entity_type: "social_account", value: `linkedin:${profile.value}`, label: `LinkedIn (${pd.name || profile.value})`, metadata: { platform: "linkedin", name: pd.name, headline: pd.headline, location: pd.location, profileUrl: pd.profileUrl }, source_module: "linkedin-intel" },
      ];
      const relationships = [
        { fromType: profile.profile_type, fromValue: profile.value, toType: "social_account", toValue: `linkedin:${profile.value}`, relationship: "uses", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `LinkedIn: ${pd.name || profile.value}` },
      ];
      if (pd.name) {
        entities.push({ entity_type: "person", value: pd.name.toLowerCase(), label: pd.name, metadata: { source: "linkedin" }, source_module: "linkedin-intel" });
        relationships.push({ fromType: "social_account", fromValue: `linkedin:${profile.value}`, toType: "person", toValue: pd.name.toLowerCase(), relationship: "linked_to", confidence: 85, evidence: "LinkedIn profile name" });
      }
      if (pd.location) {
        entities.push({ entity_type: "location", value: pd.location.toLowerCase(), label: pd.location, metadata: { source: "linkedin" }, source_module: "linkedin-intel" });
      }
      return { entities, relationships };
    },
  },

  // twitter-intel: Twitter/X profile → social_account entity
  {
    module: "twitter-intel",
    match: (f) => f.category === "account_found" && f.raw_data?.platform === "twitter",
    extract: (f, profile) => {
      const pd = f.raw_data?.profileData || {};
      const entities = [
        { entity_type: "social_account", value: `twitter:${pd.username || profile.value}`, label: `Twitter/X (@${pd.username || profile.value})`, metadata: { platform: "twitter", followers: pd.followers, verified: pd.verified, avatar: pd.profile_image }, source_module: "twitter-intel" },
      ];
      const relationships = [
        { fromType: "username", fromValue: profile.value, toType: "social_account", toValue: `twitter:${pd.username || profile.value}`, relationship: "uses", confidence: CONFIDENCE.SOCIAL_DEEP, evidence: `Twitter/X: @${pd.username}` },
      ];
      if (pd.displayname) {
        entities.push({ entity_type: "person", value: pd.displayname.toLowerCase(), label: pd.displayname, metadata: { source: "twitter" }, source_module: "twitter-intel" });
      }
      if (pd.location) {
        entities.push({ entity_type: "location", value: pd.location.toLowerCase(), label: pd.location, metadata: { source: "twitter" }, source_module: "twitter-intel" });
      }
      return { entities, relationships };
    },
  },

  // face-match: facial recognition match → image entity + face_match relationship
  {
    module: "face-match",
    match: (f) => f.category === "identity" && f.raw_data?.faceMatch === true,
    extract: (f, profile) => {
      const entities = [];
      const relationships = [];
      const sim = f.raw_data.similarity || 0;
      const confidence = Math.round(sim * 100);

      // Create image entity for the matched avatar
      if (f.raw_data.avatarUrl) {
        entities.push({
          entity_type: "image",
          value: f.raw_data.avatarUrl,
          label: `Face from ${f.raw_data.platform || "unknown"}`,
          metadata: {
            faceMatch: true,
            similarity: sim,
            matchedProfileId: f.raw_data.matchedProfileId,
            platform: f.raw_data.platform,
          },
          source_module: "face-match",
        });
      }

      // Create cross-profile face_match relationship
      if (f.raw_data.matchedProfileId) {
        relationships.push({
          fromType: profile.profile_type,
          fromValue: profile.value,
          toType: "image",
          toValue: f.raw_data.avatarUrl || `face:${f.raw_data.matchedProfileId}`,
          relationship: "face_match",
          confidence,
          evidence: `ArcFace similarity: ${(sim * 100).toFixed(1)}% (${f.raw_data.matchedProfileLabel || f.raw_data.matchedProfileId})`,
        });
      }

      // Store embedding as entity metadata for future cross-profile comparison
      if (f.raw_data.embedding) {
        entities.push({
          entity_type: "image",
          value: `face_embedding:${profile.id}`,
          label: `Face embedding for ${profile.label}`,
          metadata: {
            faceEmbedding: f.raw_data.embedding,
            profileId: profile.id,
          },
          source_module: "face-match",
        });
      }

      return { entities, relationships };
    },
  },

  // face-search: verified face matches → discovered profile entities
  {
    module: "face-search",
    match: (f) => f.raw_data?.type === "discovered_profile",
    extract: (f, profile) => ({
      entities: [
        { entity_type: "social_account", value: `${f.raw_data.platform}:${f.raw_data.username}`, label: `${f.raw_data.platform} (${f.raw_data.username})`, metadata: { platform: f.raw_data.platform, similarity: f.raw_data.similarity, source: "face_search" }, source_module: "face-search" },
      ],
      relationships: [
        { fromType: profile.profile_type, fromValue: profile.value, toType: "social_account", toValue: `${f.raw_data.platform}:${f.raw_data.username}`, relationship: "face_match", confidence: Math.round((f.raw_data.similarity || 0.5) * 100), evidence: `Face match ${((f.raw_data.similarity || 0) * 100).toFixed(0)}% on ${f.raw_data.platform}` },
      ],
    }),
  },

  // face-search: identity candidates from search engines
  {
    module: "face-search",
    match: (f) => f.raw_data?.type === "identity_candidates" && f.raw_data?.identityGuesses?.length > 0,
    extract: (f, profile) => ({
      entities: f.raw_data.identityGuesses.map(name => ({
        entity_type: "person", value: name.toLowerCase(), label: name, metadata: { source: "face_search_guess" }, source_module: "face-search",
      })),
      relationships: f.raw_data.identityGuesses.map(name => ({
        fromType: profile.profile_type, fromValue: profile.value, toType: "person", toValue: name.toLowerCase(), relationship: "identity_guess", confidence: 70, evidence: `Search engine identity guess: ${name}`,
      })),
    }),
  },

  // scene-analysis: location detection
  {
    module: "scene-analysis",
    match: (f) => f.raw_data?.type === "location_detection" && f.raw_data?.location?.estimated_region,
    extract: (f, profile) => ({
      entities: [
        { entity_type: "location", value: f.raw_data.location.estimated_region.toLowerCase(), label: f.raw_data.location.estimated_region, metadata: { confidence: f.raw_data.location.confidence, indicators: f.raw_data.location.indicators }, source_module: "scene-analysis" },
      ],
      relationships: [
        { fromType: profile.profile_type, fromValue: profile.value, toType: "location", toValue: f.raw_data.location.estimated_region.toLowerCase(), relationship: "located_at", confidence: f.raw_data.location.confidence === "high" ? 85 : 60, evidence: `Scene analysis: ${f.raw_data.location.indicators?.join(", ") || "visual clues"}` },
      ],
    }),
  },

  // scene-analysis: organization detection
  {
    module: "scene-analysis",
    match: (f) => f.raw_data?.type === "org_detection" && f.raw_data?.organizations?.length > 0,
    extract: (f, profile) => ({
      entities: f.raw_data.organizations.map(org => ({
        entity_type: "organization", value: org.toLowerCase(), label: org, metadata: { source: "scene_analysis" }, source_module: "scene-analysis",
      })),
      relationships: f.raw_data.organizations.map(org => ({
        fromType: profile.profile_type, fromValue: profile.value, toType: "organization", toValue: org.toLowerCase(), relationship: "affiliated_with", confidence: 65, evidence: `Logo/branding visible in image`,
      })),
    }),
  },

  // scene-analysis: name tag detection
  {
    module: "scene-analysis",
    match: (f) => f.raw_data?.type === "name_tag_detection" && f.raw_data?.names?.length > 0,
    extract: (f, profile) => ({
      entities: f.raw_data.names.map(name => ({
        entity_type: "person", value: name.toLowerCase(), label: name, metadata: { source: "name_tag" }, source_module: "scene-analysis",
      })),
      relationships: f.raw_data.names.map(name => ({
        fromType: profile.profile_type, fromValue: profile.value, toType: "person", toValue: name.toLowerCase(), relationship: "identified_as", confidence: 80, evidence: `Name tag visible in image: ${name}`,
      })),
    }),
  },

  // identity-resolver: identity candidates
  {
    module: "identity-resolver",
    match: (f) => f.raw_data?.type === "identity_candidates" && f.raw_data?.candidates?.length > 0,
    extract: (f, profile) => {
      const top = f.raw_data.candidates.slice(0, 5);
      return {
        entities: top.map(c => ({
          entity_type: c.name.includes(" ") ? "person" : "username", value: c.name.toLowerCase(), label: c.name, metadata: { confidence: c.confidence, sources: c.sourceCount, platforms: c.platforms }, source_module: "identity-resolver",
        })),
        relationships: top.map(c => ({
          fromType: profile.profile_type, fromValue: profile.value, toType: c.name.includes(" ") ? "person" : "username", toValue: c.name.toLowerCase(), relationship: "resolved_identity", confidence: Math.round(c.confidence * 100), evidence: `${c.sourceCount} sources: ${c.platforms?.join(", ")}`,
        })),
      };
    },
  },

  // fullcontact-lookup: enriched person data
  {
    module: "fullcontact-lookup",
    match: (f) => f.raw_data?.type === "fullcontact_enrichment" && f.raw_data?.fullName,
    extract: (f, profile) => {
      const entities = [{ entity_type: "person", value: f.raw_data.fullName.toLowerCase(), label: f.raw_data.fullName, metadata: { source: "fullcontact" }, source_module: "fullcontact-lookup" }];
      const relationships = [{ fromType: profile.profile_type, fromValue: profile.value, toType: "person", toValue: f.raw_data.fullName.toLowerCase(), relationship: "identified_as", confidence: 90, evidence: "FullContact enrichment" }];
      if (f.raw_data.organization) {
        entities.push({ entity_type: "organization", value: f.raw_data.organization.toLowerCase(), label: f.raw_data.organization, metadata: { source: "fullcontact" }, source_module: "fullcontact-lookup" });
        relationships.push({ fromType: "person", fromValue: f.raw_data.fullName.toLowerCase(), toType: "organization", toValue: f.raw_data.organization.toLowerCase(), relationship: "works_at", confidence: 85, evidence: "FullContact enrichment" });
      }
      return { entities, relationships };
    },
  },

  // hunter-lookup: discovered emails at domain
  {
    module: "hunter-lookup",
    match: (f) => f.raw_data?.type === "hunter_domain_search" && f.raw_data?.emails?.length > 0,
    extract: (f, profile) => ({
      entities: f.raw_data.emails.slice(0, 10).map(e => ({
        entity_type: "email", value: e.email.toLowerCase(), label: `${e.firstName || ""} ${e.lastName || ""} <${e.email}>`.trim(), metadata: { confidence: e.confidence, position: e.position }, source_module: "hunter-lookup",
      })),
      relationships: f.raw_data.emails.slice(0, 10).map(e => ({
        fromType: "domain", fromValue: profile.value, toType: "email", toValue: e.email.toLowerCase(), relationship: "email_at_domain", confidence: Math.round(e.confidence || 70), evidence: `Hunter.io domain search`,
      })),
    }),
  },
];

// ── Core Correlation Functions ──

async function correlateScanResults(profileId, scanId) {
  try {
    const profile = await db.getOsintProfile(profileId);
    if (!profile) return;

    // Skip profile types that aren't valid entity types (e.g. "password")
    const VALID_ENTITY_TYPES = new Set(["person", "email", "username", "phone", "domain", "ip", "social_account", "organization", "location", "image", "device", "cedula", "nit"]);
    if (!VALID_ENTITY_TYPES.has(profile.profile_type)) return;

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

    // Extract location signals from findings
    let locationsExtracted = 0;
    try {
      locationsExtracted = await extractLocationSignals(profileId, findings, profile);
    } catch (locErr) {
      console.error(`[correlator] Location extraction error:`, locErr.message);
    }

    // Cross-profile correlation: find shared entities
    await crossProfileCorrelation(profileId);

    console.log(`[correlator] Profile ${profileId}: ${entitiesCreated} entities, ${relationshipsCreated} relationships, ${locationsExtracted} locations`);
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

// ── Location Signal Extraction ──

const LOCATION_EXTRACTORS = [
  { module: "image-search", match: (f) => f.raw_data?.exif?.latitude && f.raw_data?.exif?.longitude,
    extract: (f) => ({ latitude: f.raw_data.exif.latitude, longitude: f.raw_data.exif.longitude, location_type: "gps_exif", confidence: 0.95, raw_data: { camera: f.raw_data.exif.camera, imageUrl: f.source_url } }),
  },
  { module: "gravatar-lookup", match: (f) => f.raw_data?.currentLocation || f.raw_data?.location,
    extract: (f) => ({ location_text: f.raw_data.currentLocation || f.raw_data.location, location_type: "profile_text", confidence: 0.7, raw_data: { source: "gravatar" } }),
  },
  { module: "social-deep", match: (f) => f.raw_data?.platform === "github" && f.raw_data?.profileData?.location,
    extract: (f) => ({ location_text: f.raw_data.profileData.location, location_type: "profile_text", confidence: 0.7, raw_data: { source: "github" } }),
  },
  { module: "social-deep", match: (f) => f.raw_data?.platform === "twitter" && f.raw_data?.profileData?.location,
    extract: (f) => ({ location_text: f.raw_data.profileData.location, location_type: "profile_text", confidence: 0.6, raw_data: { source: "twitter" } }),
  },
  { module: "social-deep", match: (f) => f.raw_data?.platform === "instagram" && f.raw_data?.profileData?.location,
    extract: (f) => ({ location_text: f.raw_data.profileData.location, location_type: "profile_text", confidence: 0.6, raw_data: { source: "instagram" } }),
  },
  { module: "domain-recon", match: (f) => f.raw_data?.whois?.registrant?.city || f.raw_data?.whois?.registrant?.country,
    extract: (f) => {
      const reg = f.raw_data.whois.registrant;
      return { location_text: [reg.city, reg.state, reg.country].filter(Boolean).join(", "), location_type: "whois", confidence: 0.6, raw_data: { ...reg, source: "whois" } };
    },
  },
  { module: "domain-recon", match: (f) => f.raw_data?.geoip?.latitude && f.raw_data?.geoip?.longitude,
    extract: (f) => ({ latitude: f.raw_data.geoip.latitude, longitude: f.raw_data.geoip.longitude, location_text: [f.raw_data.geoip.city, f.raw_data.geoip.country].filter(Boolean).join(", ") || null, location_type: "ip_geo", confidence: 0.4, raw_data: f.raw_data.geoip }),
  },
  { module: "shodan-lookup", match: (f) => f.raw_data?.latitude && f.raw_data?.longitude,
    extract: (f) => ({ latitude: f.raw_data.latitude, longitude: f.raw_data.longitude, location_text: [f.raw_data.city, f.raw_data.country_name].filter(Boolean).join(", ") || null, location_type: "ip_geo", confidence: 0.4, raw_data: { ip: f.raw_data.ip, isp: f.raw_data.isp } }),
  },
  { module: "phone-lookup", match: (f) => f.raw_data?.numverify?.country_name,
    extract: (f) => ({ location_text: f.raw_data.numverify.country_name, location_type: "carrier", confidence: 0.5, raw_data: { carrier: f.raw_data.numverify.carrier } }),
  },
  { module: "exif-extract", match: (f) => f.raw_data?.latitude && f.raw_data?.longitude && f.raw_data?.gps,
    extract: (f) => ({ latitude: f.raw_data.latitude, longitude: f.raw_data.longitude, location_type: "gps_exif", confidence: 0.95, raw_data: { source: "exif_upload", fileHash: f.raw_data.fileHash } }),
  },
  { module: "exif-extract", match: (f) => f.raw_data?.city || f.raw_data?.country,
    extract: (f) => ({ location_text: [f.raw_data.city, f.raw_data.province, f.raw_data.country].filter(Boolean).join(", "), location_type: "iptc", confidence: 0.8, raw_data: { source: "iptc_metadata" } }),
  },
  // Social intel modules location extraction
  { module: "twitter-intel", match: (f) => f.raw_data?.profileData?.location,
    extract: (f) => ({ location_text: f.raw_data.profileData.location, location_type: "profile_text", confidence: 0.6, raw_data: { source: "twitter-intel" } }),
  },
  { module: "linkedin-intel", match: (f) => f.raw_data?.profileData?.location,
    extract: (f) => ({ location_text: f.raw_data.profileData.location, location_type: "profile_text", confidence: 0.7, raw_data: { source: "linkedin-intel" } }),
  },
  { module: "tiktok-intel", match: (f) => f.raw_data?.profileData?.region,
    extract: (f) => ({ location_text: f.raw_data.profileData.region, location_type: "profile_text", confidence: 0.5, raw_data: { source: "tiktok-intel" } }),
  },
];

async function extractLocationSignals(profileId, findings, profile) {
  let count = 0;
  for (const finding of findings) {
    for (const extractor of LOCATION_EXTRACTORS) {
      if (finding.module !== extractor.module) continue;
      if (!extractor.match(finding)) continue;
      try {
        const loc = extractor.extract(finding);
        await db.upsertOsintLocation(profileId, {
          latitude: loc.latitude || null,
          longitude: loc.longitude || null,
          location_text: loc.location_text || null,
          source_module: finding.module,
          source_finding_id: finding.id,
          confidence: loc.confidence || 0.5,
          location_type: loc.location_type || null,
          raw_data: loc.raw_data || {},
        });
        count++;
      } catch (err) {
        console.error(`[correlator] Location extraction error (${finding.module}):`, err.message);
      }
    }
  }
  return count;
}

module.exports = {
  correlateScanResults,
  crossProfileCorrelation,
  extractLocationSignals,
  CONFIDENCE,
};
