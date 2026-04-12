/**
 * Auto-Discovery Engine — given minimal seed data, discover everything
 *
 * Flow: email → holehe (platform detection) → collect profiles → enrich → spider connections
 *
 * This is the automated version of what an analyst does manually:
 * 1. Take an email → find which platforms it's registered on
 * 2. Find the username/handle on each platform
 * 3. Collect the profile (bio, photo, followers, location, etc.)
 * 4. Face-match against the DB
 * 5. NLP-extract entities, relationships, facts
 * 6. Spider connections to discover new subjects
 * 7. Repeat for each new subject
 *
 * Directive: dir_1775984764121
 */

"use strict";

const { execSync } = require("child_process");

const BRIDGE_URL = process.env.BRIDGE_URL || "http://localhost:3333";
const COLLECTOR_URL = process.env.COLLECTOR_URL || "http://localhost:3335";
const OSINT_CONTAINER = "osint-tools";

// ── Platform Resolution ──

/**
 * Use holehe to find which platforms an email is registered on.
 * Runs inside the osint-tools Docker container.
 *
 * @param {string} email
 * @returns {Promise<string[]>} List of platform names (e.g. ["twitter.com", "spotify.com"])
 */
async function resolveEmailToPlatforms(email) {
  try {
    const output = execSync(
      `docker exec ${OSINT_CONTAINER} holehe "${email}" --only-used --no-clear --no-color -NP 2>/dev/null`,
      { encoding: "utf8", timeout: 60000 }
    );

    const platforms = [];
    const lines = output.split("\n");
    for (const line of lines) {
      const match = line.match(/^\[.\]\s+(.+)$/);
      if (match && match[1].includes(".")) {
        platforms.push(match[1].trim().toLowerCase());
      }
    }

    console.log(`[auto-discover] holehe: ${email} → ${platforms.length} platforms: ${platforms.join(", ")}`);
    return platforms;
  } catch (err) {
    console.error(`[auto-discover] holehe failed for ${email}: ${err.message}`);
    return [];
  }
}

/**
 * Map holehe platform names to our collector platform names
 */
function mapPlatform(holehePlatform) {
  const map = {
    "twitter.com": "twitter",
    "instagram.com": "instagram",
    "linkedin.com": "linkedin",
    "tiktok.com": "tiktok",
    "reddit.com": "reddit",
    "facebook.com": "facebook",
    "github.com": "github",
    "spotify.com": "spotify",
    "amazon.com": "amazon",
    "office365.com": "microsoft",
    "pinterest.com": "pinterest",
    "tumblr.com": "tumblr",
    "flickr.com": "flickr",
  };
  return map[holehePlatform] || null;
}

// ── KG Helpers ──

async function getSubject(subjectId) {
  const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subjectId}`);
  return resp.json();
}

async function getAnchors(subjectId) {
  const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subjectId}/anchors`);
  return resp.json();
}

async function addAnchor(subjectId, anchor) {
  const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subjectId}/anchors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(anchor),
  });
  return resp.json();
}

async function addFact(subjectId, fact) {
  const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subjectId}/facts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fact),
  });
  return resp.json();
}

async function addTimeline(subjectId, event) {
  const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subjectId}/timeline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  return resp.json();
}

async function collectProfile(subjectId, platform, handle) {
  const resp = await fetch(`${COLLECTOR_URL}/collect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform,
      action: "profile",
      subject_id: subjectId,
      params: { handle },
    }),
    signal: AbortSignal.timeout(60000),
  });
  return resp.json();
}

async function discoverConnections(subjectId, handle, listType = "following") {
  const resp = await fetch(`${COLLECTOR_URL}/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subject_id: subjectId,
      handle,
      list_type: listType,
      max: 50,
      scroll_passes: 8,
      auto_collect: false,
    }),
    signal: AbortSignal.timeout(120000),
  });
  return resp.json();
}

// ── Auto-Discovery Pipeline ──

/**
 * Run full auto-discovery on a KG subject.
 *
 * Phase 1: Email → Platform detection (holehe)
 * Phase 2: Platform → Profile collection (ADB collector)
 * Phase 3: Profile → Face indexing + NLP (enricher + KAIROS)
 * Phase 4: Connections → Network spider (discovery crawler)
 *
 * @param {number} subjectId
 * @param {object} opts - { skipHolehe, skipCollect, skipDiscover, platforms }
 */
async function autoDiscover(subjectId, opts = {}) {
  const results = {
    subjectId,
    phases: {},
    platforms_found: [],
    profiles_collected: [],
    connections_discovered: 0,
    errors: [],
    started_at: new Date().toISOString(),
  };

  try {
    // Get subject and anchors
    const subject = await getSubject(subjectId);
    const anchors = await getAnchors(subjectId);

    const emails = anchors.filter(a => a.anchor_type === "email").map(a => a.value);
    const existingHandles = anchors.filter(a => a.anchor_type === "social_handle");

    console.log(`[auto-discover] Starting for "${subject.name}" (${emails.length} emails, ${existingHandles.length} existing handles)`);

    // ── Phase 1: Email → Platform detection ──
    if (!opts.skipHolehe && emails.length > 0) {
      console.log(`[auto-discover] Phase 1: Resolving ${emails.length} email(s)...`);
      const allPlatforms = new Set();

      for (const email of emails) {
        const platforms = await resolveEmailToPlatforms(email);
        for (const p of platforms) {
          allPlatforms.add(p);
          const mapped = mapPlatform(p);
          if (mapped) {
            // Store as fact: "email registered on platform"
            await addFact(subjectId, {
              category: "digital_footprint",
              key: `email_registered_${mapped}`,
              value: `${email} → ${p}`,
              source: "holehe",
              confidence: 90,
            });
          }
        }
      }

      results.platforms_found = Array.from(allPlatforms);
      results.phases.holehe = { emails_checked: emails.length, platforms_found: results.platforms_found.length };

      // Log timeline event
      await addTimeline(subjectId, {
        event_type: "discovery",
        title: `Email scan: ${results.platforms_found.length} platforms found`,
        description: `Platforms: ${results.platforms_found.join(", ")}`,
        source: "auto-discover:holehe",
      });

      console.log(`[auto-discover] Phase 1 done: ${results.platforms_found.length} platforms`);
    }

    // ── Phase 2: Collect profiles on discovered platforms ──
    if (!opts.skipCollect) {
      const twitterFound = results.platforms_found.includes("twitter.com") ||
                           existingHandles.some(h => h.platform === "twitter");

      // For Twitter: we need the handle. If we don't have it yet, we can't collect.
      // The handle comes from platform-specific resolution (future: username enumeration)
      // For now, if there's an existing Twitter anchor, collect it
      const twitterAnchor = existingHandles.find(h => h.platform === "twitter");

      if (twitterAnchor) {
        console.log(`[auto-discover] Phase 2: Collecting Twitter profile @${twitterAnchor.value}...`);
        try {
          const result = await collectProfile(subjectId, "twitter", twitterAnchor.value);
          if (result.ok) {
            results.profiles_collected.push("twitter");
            console.log(`[auto-discover] Twitter profile collected`);
          } else {
            results.errors.push(`Twitter collect: ${result.error}`);
          }
        } catch (err) {
          results.errors.push(`Twitter collect: ${err.message}`);
        }
      } else if (twitterFound) {
        // Twitter registered but no handle known — store as pending discovery
        await addFact(subjectId, {
          category: "digital_footprint",
          key: "twitter_registered_no_handle",
          value: "Email registered on Twitter but handle unknown — needs manual resolution or username enumeration",
          source: "auto-discover",
          confidence: 90,
        });
        console.log(`[auto-discover] Twitter registered but handle unknown — stored for manual resolution`);
      }

      // LinkedIn: similar pattern
      const linkedinAnchor = existingHandles.find(h => h.platform === "linkedin");
      if (linkedinAnchor) {
        console.log(`[auto-discover] Phase 2: Collecting LinkedIn profile...`);
        try {
          const result = await collectProfile(subjectId, "linkedin", linkedinAnchor.value);
          if (result.ok) results.profiles_collected.push("linkedin");
        } catch (err) {
          results.errors.push(`LinkedIn collect: ${err.message}`);
        }
      }

      results.phases.collect = { profiles: results.profiles_collected.length };
    }

    // ── Phase 3: NLP enrichment happens automatically via KAIROS cron ──
    results.phases.enrich = { status: "queued_for_kairos", note: "NLP enrichment runs every 15 min automatically" };

    // ── Phase 4: Spider connections ──
    if (!opts.skipDiscover) {
      const twitterAnchor = existingHandles.find(h => h.platform === "twitter") ||
                            anchors.find(a => a.anchor_type === "social_handle" && a.platform === "twitter");

      if (twitterAnchor) {
        console.log(`[auto-discover] Phase 4: Discovering connections from @${twitterAnchor.value}...`);
        try {
          const result = await discoverConnections(subjectId, twitterAnchor.value, "following");
          results.connections_discovered = result.discovered || 0;
          results.phases.discover = {
            new_subjects: result.discovered || 0,
            existing: result.existing || 0,
          };
          console.log(`[auto-discover] Phase 4 done: ${results.connections_discovered} new subjects`);
        } catch (err) {
          results.errors.push(`Discover: ${err.message}`);
        }
      }
    }

    results.completed_at = new Date().toISOString();
    console.log(`[auto-discover] Complete for "${subject.name}":`, JSON.stringify(results.phases));

    // Log completion timeline event
    await addTimeline(subjectId, {
      event_type: "discovery",
      title: `Auto-discovery complete`,
      description: JSON.stringify({
        platforms: results.platforms_found.length,
        profiles: results.profiles_collected.length,
        connections: results.connections_discovered,
        errors: results.errors.length,
      }),
      source: "auto-discover",
    });

  } catch (err) {
    results.errors.push(`Fatal: ${err.message}`);
    console.error(`[auto-discover] Fatal error:`, err.message);
  }

  return results;
}

/**
 * Run auto-discovery on ALL active subjects that haven't been collected yet.
 * Used by KAIROS scheduled task.
 */
async function autoDiscoverAll(opts = {}) {
  const resp = await fetch(`${BRIDGE_URL}/kg/subjects?status=active`);
  const subjects = await resp.json();

  const results = [];
  for (const subject of subjects) {
    if (subject.last_collected_at && !opts.force) continue; // already collected

    const result = await autoDiscover(subject.id, opts);
    results.push(result);

    // Delay between subjects
    await new Promise(r => setTimeout(r, opts.subjectDelay || 10000));
  }

  return results;
}

module.exports = {
  autoDiscover,
  autoDiscoverAll,
  resolveEmailToPlatforms,
  mapPlatform,
};
