// CIA-Style Intelligence Dossier Generator
// Aggregates all OSINT findings into structured intelligence reports
const db = require("./db");

const PLATFORM_CATEGORIES = {
  social: ["instagram", "tiktok", "facebook", "twitter", "bluesky", "mastodon", "reddit", "telegram"],
  professional: ["linkedin", "github"],
  media: ["youtube"],
  gaming: ["steam", "xbox", "playstation", "epicgames", "twitch"],
  messaging: ["telegram", "signal", "whatsapp", "discord"],
  dating: ["tinder", "bumble", "okcupid"],
  finance: ["paypal", "venmo", "cashapp"],
  other: [],
};

function categorizePlatform(platform) {
  const p = (platform || "").toLowerCase();
  for (const [cat, platforms] of Object.entries(PLATFORM_CATEGORIES)) {
    if (platforms.includes(p)) return cat;
  }
  return "other";
}

function severityWeight(severity) {
  const weights = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
  return weights[severity] || 0;
}

async function generateDossier(profileId, days = 30) {
  const cutoffDate = new Date(Date.now() - days * 86400000).toISOString();

  // Fetch all data
  const profile = profileId ? await db.getOsintProfile(profileId) : null;
  const allFindings = await db.getOsintFindings(profileId ? { profileId, limit: 1000 } : { limit: 2000 });
  const allProfiles = await db.getOsintProfiles();

  // Time-windowed findings
  const windowFindings = allFindings.filter(f => f.first_seen_at >= cutoffDate || f.created_at >= cutoffDate);
  const olderFindings = allFindings.filter(f => f.first_seen_at < cutoffDate && f.created_at < cutoffDate);

  // Fetch graph data
  let entities = [], relationships = [];
  try {
    const graphData = await db.getOsintGraph(profileId || undefined);
    entities = graphData?.entities || [];
    relationships = graphData?.relationships || [];
  } catch (_) {}

  // Fetch identity clusters
  let clusters = [];
  try {
    clusters = await db.getIdentityClusters();
  } catch (_) {}

  // Fetch locations
  let locations = [];
  try {
    if (profileId) {
      locations = await db.getOsintLocations(profileId);
    }
  } catch (_) {}

  // Build dossier sections
  const dossier = {
    metadata: {
      generatedAt: new Date().toISOString(),
      timeWindow: days,
      profileId: profileId || "all",
      profileLabel: profile?.label || "ALL PROFILES",
      profileType: profile?.profile_type || "combined",
      totalFindings: allFindings.length,
      windowFindings: windowFindings.length,
      classification: "CONFIDENTIAL",
    },

    // SECTION 1: SUBJECT OVERVIEW
    subjectOverview: buildSubjectOverview(profile, allProfiles, entities, clusters, locations),

    // SECTION 2: DIGITAL FOOTPRINT
    digitalFootprint: buildDigitalFootprint(allFindings, entities),

    // SECTION 3: EXPOSURE ASSESSMENT
    exposureAssessment: buildExposureAssessment(allFindings),

    // SECTION 4: SOCIAL INTELLIGENCE
    socialIntelligence: buildSocialIntelligence(allFindings),

    // SECTION 5: THREAT ASSESSMENT
    threatAssessment: buildThreatAssessment(allFindings),

    // SECTION 6: IDENTITY CORRELATION
    identityCorrelation: buildIdentityCorrelation(entities, relationships, clusters),

    // SECTION 7: REMEDIATION STATUS
    remediationStatus: buildRemediationStatus(allFindings),

    // SECTION 8: WHAT CHANGED (delta)
    whatChanged: buildWhatChanged(windowFindings, olderFindings, days),
  };

  return dossier;
}

function buildSubjectOverview(profile, allProfiles, entities, clusters, locations) {
  const identities = {
    names: new Set(),
    usernames: new Set(),
    emails: new Set(),
    phones: new Set(),
  };

  for (const e of entities) {
    if (e.entity_type === "person") identities.names.add(e.label || e.value);
    if (e.entity_type === "username") identities.usernames.add(e.value);
    if (e.entity_type === "email") identities.emails.add(e.value);
    if (e.entity_type === "phone") identities.phones.add(e.value);
  }

  for (const p of allProfiles) {
    if (p.profile_type === "username") identities.usernames.add(p.value);
    if (p.profile_type === "email") identities.emails.add(p.value);
    if (p.profile_type === "phone") identities.phones.add(p.value);
  }

  const topCluster = clusters.length > 0
    ? { confidence: clusters[0].confidence, entityCount: clusters[0].entity_count, profileCount: clusters[0].profile_count }
    : null;

  return {
    primaryIdentity: profile?.label || allProfiles[0]?.label || "Unknown",
    names: [...identities.names],
    usernames: [...identities.usernames],
    emails: [...identities.emails],
    phones: [...identities.phones],
    locations: locations.map(l => ({
      text: l.location_text,
      type: l.location_type,
      confidence: l.confidence,
      source: l.source_module,
    })).slice(0, 10),
    clusterConfidence: topCluster,
    profileCount: allProfiles.length,
  };
}

function buildDigitalFootprint(findings, entities) {
  const accounts = {};
  const socialAccounts = entities.filter(e => e.entity_type === "social_account");

  for (const sa of socialAccounts) {
    const platform = sa.metadata?.platform || sa.value.split(":")[0] || "unknown";
    const category = categorizePlatform(platform);
    if (!accounts[category]) accounts[category] = [];
    accounts[category].push({
      platform,
      value: sa.label || sa.value,
      followers: sa.metadata?.followers,
      verified: sa.metadata?.verified,
    });
  }

  // Also extract from findings
  for (const f of findings) {
    if (f.category === "account_found" && f.raw_data?.platform) {
      const platform = f.raw_data.platform;
      const category = categorizePlatform(platform);
      if (!accounts[category]) accounts[category] = [];
      // Avoid duplicates
      if (!accounts[category].some(a => a.platform === platform)) {
        accounts[category].push({
          platform,
          value: f.raw_data?.profileData?.username || f.raw_data?.profileData?.name || platform,
          followers: f.raw_data?.profileData?.followersCount || f.raw_data?.profileData?.followers || f.raw_data?.profileData?.subscriberCount,
          verified: f.raw_data?.profileData?.isVerified || f.raw_data?.profileData?.verified,
        });
      }
    }
  }

  const totalAccounts = Object.values(accounts).reduce((sum, arr) => sum + arr.length, 0);

  return {
    totalAccounts,
    byCategory: accounts,
    totalEntities: entities.length,
  };
}

function buildExposureAssessment(findings) {
  const breaches = findings.filter(f => f.module === "hibp-email" || f.module === "h8mail-cli" || f.module === "hibp-password");
  const dataBrokers = findings.filter(f => f.module === "data-broker" && f.severity !== "info");
  const pastes = findings.filter(f => f.module === "paste-monitor" && f.severity !== "info");
  const leaks = findings.filter(f => f.module === "leak-search" && f.severity !== "info");

  const exposureScore = (
    breaches.length * 3 +
    dataBrokers.length * 2 +
    pastes.length * 2 +
    leaks.length * 4
  );

  let exposureLevel = "LOW";
  if (exposureScore > 20) exposureLevel = "CRITICAL";
  else if (exposureScore > 10) exposureLevel = "HIGH";
  else if (exposureScore > 5) exposureLevel = "MODERATE";

  return {
    exposureLevel,
    exposureScore,
    breaches: breaches.map(b => ({
      title: b.title,
      severity: b.severity,
      source: b.module,
      date: b.first_seen_at || b.created_at,
    })).slice(0, 20),
    dataBrokerPresence: dataBrokers.map(d => d.title).slice(0, 15),
    pasteExposure: pastes.length,
    leakExposure: leaks.length,
    breachCount: breaches.length,
    dataBrokerCount: dataBrokers.length,
  };
}

function buildSocialIntelligence(findings) {
  const socialModules = [
    "social-deep", "bluesky-intel", "youtube-intel", "reddit-intel",
    "mastodon-intel", "telegram-intel", "instagram-intel", "tiktok-intel",
    "facebook-intel", "linkedin-intel", "twitter-intel",
  ];

  const socialFindings = findings.filter(f => socialModules.includes(f.module));
  const platforms = {};

  for (const f of socialFindings) {
    const platform = f.raw_data?.platform || f.module;
    if (platforms[platform]) continue; // First finding per platform

    const pd = f.raw_data?.profileData || {};
    platforms[platform] = {
      platform,
      displayName: pd.displayName || pd.displayname || pd.name || pd.nickname || pd.fullName || pd.channelName,
      followers: pd.followersCount || pd.followers || pd.followerCount || pd.subscriberCount,
      following: pd.followsCount || pd.following || pd.followingCount,
      posts: pd.postsCount || pd.statusesCount || pd.videoCount || pd.tweets_count,
      verified: pd.isVerified || pd.verified,
      bio: pd.description || pd.biography || pd.bio || pd.signature || pd.note,
      recentActivity: (f.raw_data?.recentPosts || f.raw_data?.recentTweets || f.raw_data?.recentVideos || []).slice(0, 5),
    };
  }

  // Content themes from active subreddits
  const redditFindings = findings.filter(f => f.module === "reddit-intel" && f.raw_data?.topSubreddits);
  const interests = [];
  for (const rf of redditFindings) {
    for (const [sub] of (rf.raw_data.topSubreddits || [])) {
      interests.push(sub);
    }
  }

  return {
    platformCount: Object.keys(platforms).length,
    platforms,
    interests: [...new Set(interests)].slice(0, 20),
    totalSocialFindings: socialFindings.length,
  };
}

function buildThreatAssessment(findings) {
  const critical = findings.filter(f => f.severity === "critical");
  const high = findings.filter(f => f.severity === "high");

  const vulnFindings = findings.filter(f => f.module === "nuclei-cli" || f.module === "shodan-lookup");
  const darkWebFindings = findings.filter(f => f.module === "darkweb-search" && f.severity !== "info");
  const typosquatFindings = findings.filter(f => f.module === "dnstwist-scan" && f.severity !== "info");

  let threatLevel = "LOW";
  if (critical.length > 0 || darkWebFindings.length > 0) threatLevel = "HIGH";
  else if (high.length > 3 || vulnFindings.length > 0) threatLevel = "MODERATE";

  return {
    threatLevel,
    criticalFindings: critical.map(f => ({ title: f.title, module: f.module, date: f.first_seen_at })).slice(0, 10),
    highFindings: high.map(f => ({ title: f.title, module: f.module, date: f.first_seen_at })).slice(0, 10),
    vulnerabilities: vulnFindings.length,
    darkWebMentions: darkWebFindings.length,
    typosquatAlerts: typosquatFindings.length,
    criticalCount: critical.length,
    highCount: high.length,
  };
}

function buildIdentityCorrelation(entities, relationships, clusters) {
  const crossProfileLinks = relationships.filter(r =>
    r.relationship === "associated_with" || r.relationship === "face_match"
  );

  const faceMatches = relationships.filter(r => r.relationship === "face_match");

  return {
    totalEntities: entities.length,
    totalRelationships: relationships.length,
    crossProfileLinks: crossProfileLinks.length,
    faceMatches: faceMatches.map(f => ({
      confidence: f.confidence,
      evidence: f.evidence,
    })),
    clusters: clusters.map(c => ({
      label: c.cluster_label,
      confidence: c.confidence,
      entityCount: c.entity_count,
      profileCount: c.profile_count,
    })).slice(0, 5),
    entityBreakdown: entities.reduce((acc, e) => {
      acc[e.entity_type] = (acc[e.entity_type] || 0) + 1;
      return acc;
    }, {}),
  };
}

function buildRemediationStatus(findings) {
  const byStatus = { new: 0, acknowledged: 0, false_positive: 0, remediated: 0, monitoring: 0 };
  for (const f of findings) {
    byStatus[f.status || "new"] = (byStatus[f.status || "new"] || 0) + 1;
  }

  const actionable = findings.filter(f => f.status === "new" && (f.severity === "critical" || f.severity === "high"));
  const withRemediation = findings.filter(f => f.remediation);

  return {
    statusBreakdown: byStatus,
    actionableCount: actionable.length,
    remediationAvailable: withRemediation.length,
    topActions: actionable.slice(0, 10).map(f => ({
      title: f.title,
      severity: f.severity,
      remediation: f.remediation,
      module: f.module,
    })),
  };
}

function buildWhatChanged(windowFindings, olderFindings, days) {
  const newFindings = windowFindings.filter(f => f.status === "new");
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of newFindings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  }

  const newModules = {};
  for (const f of newFindings) {
    newModules[f.module] = (newModules[f.module] || 0) + 1;
  }

  return {
    period: `${days} days`,
    newFindingsCount: newFindings.length,
    bySeverity,
    byModule: newModules,
    highlights: newFindings
      .sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity))
      .slice(0, 10)
      .map(f => ({
        title: f.title,
        severity: f.severity,
        module: f.module,
        date: f.first_seen_at || f.created_at,
      })),
  };
}

// Generate markdown export
function dossierToMarkdown(dossier) {
  const d = dossier;
  const lines = [];

  lines.push(`# INTELLIGENCE DOSSIER`);
  lines.push(`**Classification:** ${d.metadata.classification}`);
  lines.push(`**Subject:** ${d.metadata.profileLabel}`);
  lines.push(`**Generated:** ${d.metadata.generatedAt}`);
  lines.push(`**Time Window:** ${d.metadata.timeWindow} days`);
  lines.push(`**Total Findings:** ${d.metadata.totalFindings}`);
  lines.push("");

  // Subject Overview
  lines.push(`## 1. SUBJECT OVERVIEW`);
  lines.push(`**Primary Identity:** ${d.subjectOverview.primaryIdentity}`);
  if (d.subjectOverview.names.length) lines.push(`**Known Names:** ${d.subjectOverview.names.join(", ")}`);
  if (d.subjectOverview.usernames.length) lines.push(`**Usernames:** ${d.subjectOverview.usernames.join(", ")}`);
  if (d.subjectOverview.emails.length) lines.push(`**Emails:** ${d.subjectOverview.emails.join(", ")}`);
  if (d.subjectOverview.locations.length) lines.push(`**Locations:** ${d.subjectOverview.locations.map(l => l.text).filter(Boolean).join("; ")}`);
  lines.push("");

  // Digital Footprint
  lines.push(`## 2. DIGITAL FOOTPRINT`);
  lines.push(`**Total Accounts Found:** ${d.digitalFootprint.totalAccounts}`);
  for (const [cat, accounts] of Object.entries(d.digitalFootprint.byCategory)) {
    if (accounts.length === 0) continue;
    lines.push(`\n### ${cat.toUpperCase()} (${accounts.length})`);
    for (const a of accounts) {
      lines.push(`- **${a.platform}**: ${a.value}${a.followers ? ` (${a.followers.toLocaleString()} followers)` : ""}${a.verified ? " ✓" : ""}`);
    }
  }
  lines.push("");

  // Exposure Assessment
  lines.push(`## 3. EXPOSURE ASSESSMENT`);
  lines.push(`**Exposure Level:** ${d.exposureAssessment.exposureLevel}`);
  lines.push(`**Breaches:** ${d.exposureAssessment.breachCount}`);
  lines.push(`**Data Broker Presence:** ${d.exposureAssessment.dataBrokerCount} sites`);
  lines.push(`**Paste/Leak Exposure:** ${d.exposureAssessment.pasteExposure + d.exposureAssessment.leakExposure}`);
  lines.push("");

  // Social Intelligence
  lines.push(`## 4. SOCIAL INTELLIGENCE`);
  lines.push(`**Platforms Active:** ${d.socialIntelligence.platformCount}`);
  for (const [, pd] of Object.entries(d.socialIntelligence.platforms)) {
    lines.push(`- **${pd.platform}**: ${pd.displayName || "?"}${pd.followers ? ` — ${pd.followers.toLocaleString()} followers` : ""}${pd.verified ? " ✓" : ""}`);
  }
  if (d.socialIntelligence.interests.length) {
    lines.push(`\n**Interests/Topics:** ${d.socialIntelligence.interests.join(", ")}`);
  }
  lines.push("");

  // Threat Assessment
  lines.push(`## 5. THREAT ASSESSMENT`);
  lines.push(`**Threat Level:** ${d.threatAssessment.threatLevel}`);
  lines.push(`**Critical Findings:** ${d.threatAssessment.criticalCount}`);
  lines.push(`**High Findings:** ${d.threatAssessment.highCount}`);
  lines.push(`**Dark Web Mentions:** ${d.threatAssessment.darkWebMentions}`);
  lines.push("");

  // Identity Correlation
  lines.push(`## 6. IDENTITY CORRELATION`);
  lines.push(`**Entities:** ${d.identityCorrelation.totalEntities}`);
  lines.push(`**Relationships:** ${d.identityCorrelation.totalRelationships}`);
  lines.push(`**Cross-Profile Links:** ${d.identityCorrelation.crossProfileLinks}`);
  lines.push(`**Face Matches:** ${d.identityCorrelation.faceMatches.length}`);
  lines.push("");

  // Remediation
  lines.push(`## 7. REMEDIATION STATUS`);
  const rs = d.remediationStatus.statusBreakdown;
  lines.push(`New: ${rs.new} | Acknowledged: ${rs.acknowledged} | Remediated: ${rs.remediated} | FP: ${rs.false_positive}`);
  lines.push(`**Action Required:** ${d.remediationStatus.actionableCount} findings need attention`);
  lines.push("");

  // What Changed
  lines.push(`## 8. WHAT CHANGED (${d.whatChanged.period})`);
  lines.push(`**New Findings:** ${d.whatChanged.newFindingsCount}`);
  if (d.whatChanged.highlights.length) {
    lines.push(`\n### Top Changes:`);
    for (const h of d.whatChanged.highlights) {
      lines.push(`- [${h.severity.toUpperCase()}] ${h.title} (${h.module})`);
    }
  }

  return lines.join("\n");
}

module.exports = { generateDossier, dossierToMarkdown };
