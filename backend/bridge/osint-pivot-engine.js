// OSINT Pivot Engine — auto-creates profiles from identity discoveries and triggers cascading scans
// Entry point: photo upload → face search → identity resolver → auto-pivot → full OSINT scan
const db = require("./db");

const MAX_PIVOTS_PER_INVESTIGATION = 20;
const MAX_DEPTH = 2;

// ── Investigation Management ──

async function createInvestigation(seedProfileId, name, config = {}) {
  return db.createOsintInvestigation({
    name: name || `Investigation ${Date.now()}`,
    seed_profile_id: seedProfileId,
    max_depth: config.maxDepth || MAX_DEPTH,
    config: {
      maxPivots: config.maxPivots || MAX_PIVOTS_PER_INVESTIGATION,
      autoScan: config.autoScan !== false,
      ...config,
    },
  });
}

async function getInvestigation(id) {
  return db.getOsintInvestigation(id);
}

async function getInvestigations() {
  return db.getOsintInvestigations();
}

// ── Pivot Execution ──

async function executePivots(profileId, scanId, osintEngine) {
  const profile = await db.getOsintProfile(profileId);
  if (!profile) return { pivoted: 0 };

  const investigationId = profile.investigation_id;
  const currentDepth = profile.pivot_depth || 0;

  // Check depth limit
  const maxDepth = investigationId
    ? (await db.getOsintInvestigation(investigationId))?.max_depth || MAX_DEPTH
    : MAX_DEPTH;

  if (currentDepth >= maxDepth) {
    console.log(`[pivot] Depth limit reached (${currentDepth}/${maxDepth}) for profile ${profileId}`);
    return { pivoted: 0, reason: "depth_limit" };
  }

  // Check pivot count limit
  if (investigationId) {
    const inv = await db.getOsintInvestigation(investigationId);
    const maxPivots = inv?.config?.maxPivots || MAX_PIVOTS_PER_INVESTIGATION;
    if ((inv?.pivot_count || 0) >= maxPivots) {
      console.log(`[pivot] Pivot limit reached (${inv.pivot_count}/${maxPivots})`);
      return { pivoted: 0, reason: "pivot_limit" };
    }
  }

  // Get pivot recommendations from findings
  const findings = await db.getOsintFindings({ profileId, scanId, limit: 500 });
  const pivotFindings = findings.filter(
    (f) => f.raw_data?.type === "pivot_recommendation" || f.raw_data?.pivotRecommended
  );

  let pivotCount = 0;
  const pivotedProfiles = [];

  for (const pf of pivotFindings) {
    const rd = pf.raw_data;

    // Only auto-execute high-confidence pivots
    if (rd.type === "pivot_recommendation" && !rd.autoExecute) continue;

    // Handle different pivot types
    if (rd.pivotType === "username" && rd.pivotValue) {
      const result = await createPivotProfile(
        rd.pivotValue, "username", rd.pivotValue,
        profileId, currentDepth + 1, investigationId,
        `identity_resolver:${rd.confidence}`, osintEngine
      );
      if (result) { pivotCount++; pivotedProfiles.push(result); }
    }

    if (rd.pivotType === "name_variants" && rd.variants) {
      for (const variant of rd.variants.slice(0, 3)) {
        const result = await createPivotProfile(
          `${rd.fullName} (${variant})`, "username", variant,
          profileId, currentDepth + 1, investigationId,
          `name_variant:${rd.fullName}`, osintEngine
        );
        if (result) { pivotCount++; pivotedProfiles.push(result); }
      }
    }

    if (rd.pivotType === "email" && rd.pivotValue) {
      const result = await createPivotProfile(
        rd.pivotValue, "email", rd.pivotValue,
        profileId, currentDepth + 1, investigationId,
        `email_pattern:${rd.confidence}`, osintEngine
      );
      if (result) { pivotCount++; pivotedProfiles.push(result); }
    }

    // Discovered social profiles from face search
    if (rd.type === "discovered_profile" && rd.username && rd.platform) {
      const result = await createPivotProfile(
        `${rd.platform}:${rd.username}`, "username", rd.username,
        profileId, currentDepth + 1, investigationId,
        `face_match:${rd.platform}:${rd.similarity}`, osintEngine
      );
      if (result) { pivotCount++; pivotedProfiles.push(result); }
    }
  }

  // Update investigation pivot count
  if (investigationId && pivotCount > 0) {
    await db.incrementInvestigationPivots(investigationId, pivotCount);
  }

  console.log(`[pivot] Created ${pivotCount} pivots from profile ${profileId} (depth ${currentDepth})`);
  return { pivoted: pivotCount, profiles: pivotedProfiles };
}

async function createPivotProfile(label, profileType, value, sourceProfileId, depth, investigationId, pivotSource, osintEngine) {
  // Check for existing profile with same type+value
  try {
    const existing = await db.getOsintProfileByValue(profileType, value);
    if (existing) {
      console.log(`[pivot] Profile already exists: ${profileType}:${value}`);
      return null;
    }
  } catch {}

  try {
    const id = await db.createOsintProfile(label, profileType, value, ["auto-pivot"]);
    if (!id) return null;

    // Set pivot metadata
    await db.updateOsintProfilePivot(id, {
      investigation_id: investigationId,
      pivot_depth: depth,
      pivot_source: pivotSource,
    });

    console.log(`[pivot] Created pivot profile: ${profileType}:${value} (depth ${depth})`);

    // Auto-trigger scan
    if (osintEngine) {
      try {
        const scanResult = await osintEngine.runScan(id, "full");
        console.log(`[pivot] Auto-scan triggered for ${value}: scan #${scanResult.scanId}`);
      } catch (scanErr) {
        console.error(`[pivot] Auto-scan failed for ${value}:`, scanErr.message);
      }
    }

    return { id, label, profileType, value, depth };
  } catch (err) {
    if (err.message.includes("duplicate key")) return null;
    console.error(`[pivot] Failed to create pivot profile ${value}:`, err.message);
    return null;
  }
}

module.exports = {
  createInvestigation,
  getInvestigation,
  getInvestigations,
  executePivots,
  createPivotProfile,
  MAX_PIVOTS_PER_INVESTIGATION,
  MAX_DEPTH,
};
