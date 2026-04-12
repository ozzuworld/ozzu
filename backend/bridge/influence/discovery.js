/**
 * Network Discovery Crawler — spider KG subjects through social connections
 *
 * Given a seed subject, crawls followers/following lists on Twitter via ADB.
 * Auto-creates KG subjects for discovered people. Indexes faces into kg_faces.
 *
 * Pipeline integration: feeds new subjects into COLLECT → NORMALIZE → ENRICH → STORE
 *
 * Directive: dir_1775984764121
 */

"use strict";

const { execSync } = require("child_process");
const path = require("path");

const ADB_DEVICE = process.env.ADB_DEVICE || "localhost:5556";
const BRIDGE_URL = process.env.BRIDGE_URL || "http://localhost:3333";

// ── Config ──

const DISCOVERY_DEFAULTS = {
  maxPerList: 50,         // max handles to extract per followers/following list
  scrollPasses: 10,       // number of scroll passes through the list
  scrollDelay: 2000,      // ms between scrolls
  profileDelay: 5000,     // ms between profile collections (rate limit)
  autoCollect: false,     // whether to auto-collect full profiles of discovered subjects
  depth: 1,               // crawl depth (1 = direct connections only)
};

// ── ADB Helpers (same as collector.js) ──

function adb(cmd, timeout = 10000) {
  try {
    return execSync(`adb -s ${ADB_DEVICE} ${cmd}`, {
      timeout, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    return err.stdout ? err.stdout.trim() : "";
  }
}

function shell(cmd, timeout = 10000) {
  return adb(`shell "${cmd.replace(/"/g, '\\"')}"`, timeout);
}

function tap(x, y) { shell(`input tap ${x} ${y}`); }
function swipe(x1, y1, x2, y2, ms = 300) { shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function dumpUI() {
  shell("uiautomator dump /sdcard/discovery-ui.xml");
  const xml = shell("cat /sdcard/discovery-ui.xml", 15000);
  if (!xml) return [];

  const nodes = [];
  const re = /text="([^"]*)"[^>]*content-desc="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  let m;
  while ((m = re.exec(xml))) {
    const [, text, desc, x1, y1, x2, y2] = m;
    if (text || desc) {
      nodes.push({ text: text || desc, bounds: { x1: +x1, y1: +y1, x2: +x2, y2: +y2 } });
    }
  }
  return nodes;
}

// ── Bridge API Helpers ──

async function kgGetSubjects() {
  const resp = await fetch(`${BRIDGE_URL}/kg/subjects`);
  return resp.json();
}

async function kgCreateSubject(data) {
  const resp = await fetch(`${BRIDGE_URL}/kg/subjects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return resp.json();
}

async function kgAddAnchor(subjectId, anchor) {
  const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subjectId}/anchors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(anchor),
  });
  return resp.json();
}

async function kgAddConnection(conn) {
  const resp = await fetch(`${BRIDGE_URL}/kg/connections`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(conn),
  });
  return resp.json();
}

async function kgCollect(subjectId, platform, handle) {
  const resp = await fetch(`${BRIDGE_URL}/kg/collect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ platform, action: "profile", subject_id: subjectId, target: handle }),
  });
  return resp.json();
}

// ── Discovery Core ──

/**
 * Extract handles from a Twitter followers/following list screen.
 * Scrolls through the list and collects unique @handles.
 */
async function extractHandlesFromList(opts = {}) {
  const maxPerList = opts.maxPerList || DISCOVERY_DEFAULTS.maxPerList;
  const scrollPasses = opts.scrollPasses || DISCOVERY_DEFAULTS.scrollPasses;
  const scrollDelay = opts.scrollDelay || DISCOVERY_DEFAULTS.scrollDelay;

  const handles = new Set();
  const displayNames = new Map(); // handle → display name

  for (let pass = 0; pass < scrollPasses; pass++) {
    const nodes = dumpUI();

    for (const node of nodes) {
      const text = node.text.trim();

      // Twitter followers/following list shows @handle format
      const handleMatch = text.match(/^@([A-Za-z0-9_]{1,15})$/);
      if (handleMatch) {
        const handle = handleMatch[1].toLowerCase();
        if (!handles.has(handle)) {
          handles.add(handle);

          // The display name is usually the node right before the @handle
          // Look for a text node immediately above this one (within 50px)
          const aboveNodes = nodes.filter(n =>
            n.bounds.y2 <= node.bounds.y1 + 5 &&
            n.bounds.y2 >= node.bounds.y1 - 50 &&
            Math.abs(n.bounds.x1 - node.bounds.x1) < 20 &&
            !n.text.startsWith("@") &&
            n.text !== "Follow" &&
            n.text !== "Following"
          );
          if (aboveNodes.length > 0) {
            displayNames.set(handle, aboveNodes[aboveNodes.length - 1].text);
          }
        }
      }
    }

    if (handles.size >= maxPerList) break;

    // Scroll down to load more
    swipe(540, 1600, 540, 400, 500);
    await sleep(scrollDelay);
  }

  return Array.from(handles).map(h => ({
    handle: h,
    displayName: displayNames.get(h) || null,
  }));
}

/**
 * Navigate to a user's followers or following list on Twitter.
 * @param {string} handle - Twitter handle
 * @param {string} listType - "followers" or "following"
 */
async function navigateToList(handle, listType = "followers") {
  // Open profile first
  shell(`am start -a android.intent.action.VIEW -d "twitter://user?screen_name=${handle}" -p com.twitter.android`);
  await sleep(5000);

  // Dump UI and find the followers/following button
  const nodes = dumpUI();

  let targetNode = null;
  for (const node of nodes) {
    const text = node.text.toLowerCase();
    if (listType === "followers" && text.includes("followers") && !text.includes("following")) {
      targetNode = node;
      break;
    }
    if (listType === "following" && text.includes("following") && !text.includes("followers")) {
      targetNode = node;
      break;
    }
  }

  if (!targetNode) {
    // Try content-desc based tap — followers is usually at specific coordinates
    // For typical Twitter layout: followers is around y=500, following slightly above
    console.log(`[discovery] Could not find ${listType} button, trying known coordinates...`);
    if (listType === "followers") {
      // Look for "NNN Followers" pattern in text
      const followerNode = nodes.find(n => /^\d[\d,.]*[KMB]?\s*$/i.test(n.text) || n.text.match(/followers/i));
      if (followerNode) {
        tap(Math.round((followerNode.bounds.x1 + followerNode.bounds.x2) / 2),
            Math.round((followerNode.bounds.y1 + followerNode.bounds.y2) / 2));
      } else {
        throw new Error(`Cannot find ${listType} button on @${handle}'s profile`);
      }
    } else {
      const followingNode = nodes.find(n => n.text.match(/following/i));
      if (followingNode) {
        tap(Math.round((followingNode.bounds.x1 + followingNode.bounds.x2) / 2),
            Math.round((followingNode.bounds.y1 + followingNode.bounds.y2) / 2));
      } else {
        throw new Error(`Cannot find ${listType} button on @${handle}'s profile`);
      }
    }
  } else {
    const cx = Math.round((targetNode.bounds.x1 + targetNode.bounds.x2) / 2);
    const cy = Math.round((targetNode.bounds.y1 + targetNode.bounds.y2) / 2);
    tap(cx, cy);
  }

  await sleep(3000);
  return true;
}

/**
 * Discover new subjects from a KG subject's social connections.
 *
 * @param {number} subjectId - KG subject ID
 * @param {string} handle - Twitter handle of the subject
 * @param {object} opts - { listType, maxPerList, scrollPasses, autoCollect, depth }
 * @returns {{ discovered: number, existing: number, collected: number, handles: string[] }}
 */
async function discoverFromSubject(subjectId, handle, opts = {}) {
  const listType = opts.listType || "following"; // "following" is usually more relevant than "followers"
  const autoCollect = opts.autoCollect ?? DISCOVERY_DEFAULTS.autoCollect;
  const profileDelay = opts.profileDelay || DISCOVERY_DEFAULTS.profileDelay;

  console.log(`[discovery] Starting discovery from @${handle} (${listType})...`);

  // Get existing subjects to dedup
  const existingSubjects = await kgGetSubjects();
  const existingHandles = new Set();
  // Build handle set from anchors
  for (const s of existingSubjects) {
    // Check anchors via dossier would be expensive, use simple name matching
    existingHandles.add(s.name.toLowerCase());
  }
  // Also fetch anchors for known twitter handles
  for (const s of existingSubjects) {
    try {
      const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${s.id}/anchors`);
      const anchors = await resp.json();
      for (const a of anchors) {
        if (a.anchor_type === "social_handle" && a.platform === "twitter") {
          existingHandles.add(a.value.toLowerCase());
        }
      }
    } catch {}
  }

  // Navigate to the followers/following list
  await navigateToList(handle, listType);

  // Extract handles from the list
  const discovered = await extractHandlesFromList(opts);
  console.log(`[discovery] Extracted ${discovered.length} handles from @${handle}'s ${listType}`);

  const results = {
    source: { subjectId, handle, listType },
    discovered: 0,
    existing: 0,
    collected: 0,
    errors: 0,
    handles: [],
  };

  for (const person of discovered) {
    const handleLower = person.handle.toLowerCase();

    // Skip if already known
    if (existingHandles.has(handleLower)) {
      results.existing++;
      continue;
    }

    // Create new KG subject
    try {
      const name = person.displayName || person.handle;
      const subjectResp = await kgCreateSubject({
        name,
        subject_type: "person",
        status: "active",
        metadata: {
          discovered_from: handle,
          discovered_via: listType,
          discovered_at: new Date().toISOString(),
        },
      });

      const newSubject = subjectResp.subject || subjectResp;
      if (!newSubject?.id) {
        console.log(`[discovery] Failed to create subject for @${person.handle}`);
        results.errors++;
        continue;
      }

      // Add Twitter anchor
      await kgAddAnchor(newSubject.id, {
        anchor_type: "social_handle",
        platform: "twitter",
        value: person.handle,
        confidence: 100,
        source: "discovery:twitter",
      });

      // Add connection: source → discovered (follows relationship)
      const relType = listType === "followers" ? "followed_by" : "follows";
      await kgAddConnection({
        source_id: subjectId,
        target_id: newSubject.id,
        relationship: relType,
        confidence: 100,
        source: "discovery:twitter",
      }).catch(() => {}); // ignore duplicate constraint

      existingHandles.add(handleLower);
      results.discovered++;
      results.handles.push(person.handle);

      console.log(`[discovery] + @${person.handle} (${name}) — subject #${newSubject.id}`);

      // Auto-collect profile if enabled
      if (autoCollect) {
        try {
          await kgCollect(newSubject.id, "twitter", person.handle);
          results.collected++;
          console.log(`[discovery] Collected profile for @${person.handle}`);
        } catch (err) {
          console.error(`[discovery] Collect failed for @${person.handle}: ${err.message}`);
        }
        // Rate limit between collections
        await sleep(profileDelay);
      }
    } catch (err) {
      console.error(`[discovery] Error processing @${person.handle}: ${err.message}`);
      results.errors++;
    }
  }

  console.log(`[discovery] Done: ${results.discovered} new, ${results.existing} existing, ${results.collected} collected, ${results.errors} errors`);
  return results;
}

/**
 * Run discovery across all active KG subjects that have Twitter anchors.
 * Used by KAIROS for scheduled discovery.
 */
async function discoverAll(opts = {}) {
  const subjects = await kgGetSubjects();
  const results = [];

  for (const subject of subjects) {
    if (subject.status !== "active") continue;

    // Get Twitter anchor
    try {
      const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subject.id}/anchors`);
      const anchors = await resp.json();
      const twitterAnchor = anchors.find(a => a.anchor_type === "social_handle" && a.platform === "twitter");

      if (twitterAnchor) {
        const result = await discoverFromSubject(subject.id, twitterAnchor.value, opts);
        results.push({ subject: subject.name, ...result });

        // Delay between subjects
        await sleep(opts.subjectDelay || 10000);
      }
    } catch (err) {
      console.error(`[discovery] Error discovering from ${subject.name}: ${err.message}`);
      results.push({ subject: subject.name, error: err.message });
    }
  }

  return results;
}

module.exports = {
  discoverFromSubject,
  discoverAll,
  extractHandlesFromList,
  navigateToList,
  DISCOVERY_DEFAULTS,
};
