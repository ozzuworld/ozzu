/**
 * OSINT Collector — ADB-based social media scraper for KG observations
 * Uses Redroid Android instance to collect publicly visible profile data.
 *
 * Pipeline: COLLECT → NORMALIZE → STORE (into kg_observations)
 *
 * Directive: dir_1775974353093
 */

"use strict";

const { execSync } = require("child_process");
const captchaSolver = require("./captcha-solver");
const accountPool = require("./account-pool");
const normalizer = require("./normalizer");
const enricher = require("./enricher");

const ADB_DEVICE = process.env.ADB_DEVICE || "localhost:5556";
const BRIDGE_URL = process.env.BRIDGE_URL || "http://localhost:3333";
const COLLECTOR_PORT = parseInt(process.env.COLLECTOR_PORT || "3335");

// Track which account is currently active per platform on Redroid
const activeAccounts = {};

// ── ADB Helpers ──

function adb(cmd, timeout = 10000) {
  try {
    return execSync(`adb -s ${ADB_DEVICE} ${cmd}`, {
      timeout,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    return err.stdout ? err.stdout.trim() : "";
  }
}

function shell(cmd, timeout = 10000) {
  return adb(`shell "${cmd.replace(/"/g, '\\"')}"`, timeout);
}

function tap(x, y) {
  shell(`input tap ${x} ${y}`);
}

function swipe(x1, y1, x2, y2, ms = 300) {
  shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function launchApp(pkg) {
  shell(`am force-stop ${pkg}`);
  shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
}

function getForegroundPkg() {
  const out = shell("dumpsys activity activities | grep mFocusedApp");
  const m = out.match(/ActivityRecord\{[^ ]+ u\d+ ([^/]+)/);
  return m ? m[1] : null;
}

// Dump UI tree and extract all text/content-desc nodes with bounds
async function dumpUI() {
  shell("uiautomator dump /sdcard/collector-ui.xml");
  const xml = shell("cat /sdcard/collector-ui.xml", 15000);
  if (!xml) return [];

  const nodes = [];
  // Extract all nodes with text or content-desc
  const re =
    /text="([^"]*)"[^>]*content-desc="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  let m;
  while ((m = re.exec(xml))) {
    const [, text, desc, x1, y1, x2, y2] = m;
    if (text || desc) {
      nodes.push({
        text,
        desc,
        bounds: {
          x1: +x1,
          y1: +y1,
          x2: +x2,
          y2: +y2,
          cx: Math.round((+x1 + +x2) / 2),
          cy: Math.round((+y1 + +y2) / 2),
        },
      });
    }
  }
  return nodes;
}

// Get raw XML text content (simpler, for full-text extraction)
function dumpUIText() {
  shell("uiautomator dump /sdcard/collector-ui.xml");
  const xml = shell("cat /sdcard/collector-ui.xml", 15000);
  if (!xml) return [];

  const texts = [];
  const re = /text="([^"]+)"/g;
  let m;
  while ((m = re.exec(xml))) {
    texts.push(m[1]);
  }
  return texts;
}

// ── KG API Helpers ──

async function kgAddObservation(subjectId, observation) {
  const resp = await fetch(
    `${BRIDGE_URL}/kg/subjects/${subjectId}/observations`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(observation),
    }
  );
  return resp.json();
}

async function kgAddFact(subjectId, fact) {
  const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subjectId}/facts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fact),
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

async function kgCreateCollection(subjectId, platform, type) {
  const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subjectId}/observations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform,
      observation_type: "activity",
      content: `Started ${type} collection on ${platform}`,
    }),
  });
  return resp.json();
}

// ── Platform Collectors ──

const collectors = {};

// ── X/Twitter Collector ──

collectors.twitter = {
  pkg: "com.twitter.android",

  async collectProfile(subjectId, handle) {
    console.log(`[collector:x] Collecting profile for @${handle}...`);

    // Force-stop foreground app if not X
    const fg = getForegroundPkg();
    if (fg && fg !== "com.twitter.android") shell(`am force-stop ${fg}`);

    // Open X app and navigate to profile
    shell(`am start -a android.intent.action.VIEW -d "twitter://user?screen_name=${handle}" -p com.twitter.android`);
    await sleep(6000);

    const nodes = await dumpUI();
    if (!nodes.length) return { error: "Could not dump UI" };

    // Parse raw profile data from UI nodes
    const rawProfile = this._parseProfile(nodes, handle);

    // NORMALIZE: structured extraction + photo capture (pass UI nodes for avatar bounds)
    const { normalized: profile, photo } = normalizer.normalize(
      "twitter", "profile_update", rawProfile,
      { capturePhoto: true, subjectId, uiNodes: nodes }
    );

    // Store normalized observation
    await kgAddObservation(subjectId, {
      platform: "twitter",
      observation_type: "profile_update",
      content: JSON.stringify(profile),
      raw_data: rawProfile,
      entities_extracted: [handle],
      engagement: profile.engagement || {},
    });

    // Store key facts from normalized data
    if (profile.display_name) {
      await kgAddFact(subjectId, {
        category: "social",
        key: "twitter_display_name",
        value: profile.display_name,
        source: "collector:twitter",
        is_current: true,
      });
    }
    if (profile.bio) {
      await kgAddFact(subjectId, {
        category: "social",
        key: "twitter_bio",
        value: profile.bio,
        source: "collector:twitter",
        is_current: true,
      });
    }
    if (profile.followers) {
      await kgAddFact(subjectId, {
        category: "social",
        key: "twitter_followers",
        value: String(profile.followers),
        source: "collector:twitter",
        is_current: true,
      });
    }
    if (profile.location) {
      await kgAddFact(subjectId, {
        category: "location",
        key: "twitter_location",
        value: profile.location,
        source: "collector:twitter",
        is_current: true,
      });
    }
    if (profile.joined) {
      await kgAddFact(subjectId, {
        category: "social",
        key: "twitter_joined",
        value: profile.joined,
        source: "collector:twitter",
        is_current: true,
      });
    }

    // Store photo reference as fact
    if (photo) {
      await kgAddFact(subjectId, {
        category: "media",
        key: "profile_photo",
        value: JSON.stringify({ platform: "twitter", path: photo.screenshotFilename, avatar: photo.avatar }),
        source: "collector:twitter",
        is_current: true,
      });
    }

    // Add anchor
    await kgAddAnchor(subjectId, {
      anchor_type: "social_handle",
      platform: "twitter",
      value: handle,
      verified: profile.verified || false,
      confidence: 100,
      source: "collector:twitter",
    });

    console.log(`[collector:x] Profile collected (normalized):`, profile);

    // ENRICH (async — don't block collection)
    enricher.enrichAndStore(subjectId, profile, photo ? photo.screenshotFilename : null)
      .then((e) => console.log(`[collector:x] Enrichment complete for @${handle}`))
      .catch((err) => console.error(`[collector:x] Enrichment failed:`, err.message));

    return { ...profile, photo: photo ? photo.screenshotFilename : null };
  },

  async collectFeed(subjectId) {
    console.log(`[collector:x] Collecting home feed...`);

    // Force-stop any foreground app, then launch X
    const fg = getForegroundPkg();
    if (fg && fg !== "com.twitter.android") shell(`am force-stop ${fg}`);
    shell("am start -n com.twitter.android/.StartActivity");
    await sleep(6000);

    const observations = [];

    // Scroll through feed and collect visible tweets
    for (let scroll = 0; scroll < 3; scroll++) {
      const nodes = await dumpUI();
      const tweets = this._parseFeed(nodes);

      for (const tweet of tweets) {
        const { normalized } = normalizer.normalize("twitter", "post", tweet);
        const obs = await kgAddObservation(subjectId, {
          platform: "twitter",
          observation_type: "post",
          content: JSON.stringify(normalized),
          raw_data: tweet,
          author_handle: normalized.author_handle || null,
          entities_extracted: normalized.mentions || tweet.mentions || [],
          engagement: normalized.engagement || {},
          sentiment: null,
        });
        observations.push(obs);
      }

      // Scroll down
      swipe(540, 1400, 540, 400, 500);
      await sleep(3000);
    }

    console.log(`[collector:x] Collected ${observations.length} feed items`);
    return { items: observations.length };
  },

  _parseProfile(nodes, handle) {
    const profile = { handle, raw_texts: [] };
    let foundHandle = false;

    for (const n of nodes) {
      const t = n.text || n.desc || "";
      if (!t) continue;
      profile.raw_texts.push(t);

      // Display name is usually above the handle
      if (t.includes(`@${handle}`) || t.toLowerCase().includes(handle.toLowerCase())) {
        foundHandle = true;
      }

      // Look for follower/following counts
      const followerMatch = t.match(/([\d,.]+[KMB]?)\s*[Ff]ollowers/);
      if (followerMatch) profile.followers = followerMatch[1];

      const followingMatch = t.match(/([\d,.]+[KMB]?)\s*[Ff]ollowing/);
      if (followingMatch) profile.following = followingMatch[1];

      // Location
      if (n.desc && n.desc.includes("Location:")) {
        profile.location = n.desc.replace("Location:", "").trim();
      }

      // Joined date
      const joinedMatch = t.match(/[Jj]oined\s+(\w+\s+\d{4})/);
      if (joinedMatch) profile.joined = joinedMatch[1];
    }

    // Extract display name — look for text immediately before the @handle
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.text && n.text.includes(`@${handle}`)) {
        // The node before the handle is usually the display name
        for (let j = i - 1; j >= 0; j--) {
          const prev = nodes[j];
          if (prev.text && prev.text.length > 1 && !prev.text.startsWith("@")
              && !prev.text.includes("follow") && !prev.text.includes("SUBSCRIBE")
              && !prev.text.includes("Header")) {
            profile.displayName = prev.text.replace(/[\u202f\u200b]/g, "").trim();
            break;
          }
        }
        break;
      }
    }

    // Extract bio — text between handle and "Joined"
    let afterHandle = false;
    for (const n of nodes) {
      if (n.text && n.text.includes(`@${handle}`)) { afterHandle = true; continue; }
      if (afterHandle && n.text) {
        if (n.text.match(/^Joined /)) break;
        if (n.text.length > 3 && !n.text.match(/^\d/) && !n.text.includes("follow")) {
          profile.bio = n.text;
          break;
        }
      }
    }

    return profile;
  },

  _parseFeed(nodes) {
    const tweets = [];
    let current = null;

    for (const n of nodes) {
      const desc = n.desc || "";

      // Tweet content-desc usually contains the full tweet with metadata
      if (desc.includes("@") && desc.includes(".") && desc.length > 50) {
        // Extract mentions
        const mentions = [];
        const mentionRe = /@(\w+)/g;
        let mm;
        while ((mm = mentionRe.exec(desc))) {
          mentions.push(mm[1]);
        }

        // Extract engagement numbers
        const likes = desc.match(/([\d,]+)\s*likes?/i);
        const reposts = desc.match(/([\d,]+)\s*reposts?/i);
        const replies = desc.match(/([\d,]+)\s*repl(?:y|ies)/i);

        tweets.push({
          text: desc.substring(0, 500),
          mentions,
          likes: likes ? likes[1] : null,
          reposts: reposts ? reposts[1] : null,
          replies: replies ? replies[1] : null,
        });
      }
    }

    return tweets;
  },
};

// ── LinkedIn Collector ──

collectors.linkedin = {
  pkg: "com.linkedin.android",

  async _handleCaptcha() {
    const texts = dumpUIText();
    const hasCaptcha = texts.some(
      (t) =>
        t.includes("security check") ||
        t.includes("not a robot") ||
        t.includes("temporarily restricted")
    );
    if (!hasCaptcha) return false;

    console.log("[collector:li] CAPTCHA detected — solving with CapSolver...");
    const result = await captchaSolver.detectAndSolve(
      "https://www.linkedin.com/checkpoint/challenge/captchaInternal"
    );
    console.log("[collector:li] CAPTCHA result:", JSON.stringify(result));

    if (result.solved) {
      await sleep(5000); // Wait for page to process
      return true;
    }
    return false;
  },

  async collectProfile(subjectId, profileUrl) {
    console.log(`[collector:li] Collecting profile: ${profileUrl}...`);

    // Open LinkedIn profile via deep link
    shell(`am start -a android.intent.action.VIEW -d "${profileUrl}" -p com.linkedin.android`);
    await sleep(8000);

    // Check for CAPTCHA
    await this._handleCaptcha();

    const nodes = await dumpUI();
    if (!nodes.length) return { error: "Could not dump UI" };

    const rawProfile = this._parseProfile(nodes);

    // NORMALIZE: structured extraction + photo capture (pass UI nodes for avatar bounds)
    const { normalized: profile, photo } = normalizer.normalize(
      "linkedin", "profile_update", rawProfile,
      { capturePhoto: true, subjectId, uiNodes: nodes }
    );

    await kgAddObservation(subjectId, {
      platform: "linkedin",
      observation_type: "profile_update",
      content: JSON.stringify(profile),
      raw_data: rawProfile,
      entities_extracted: profile.name ? [profile.name] : [],
    });

    if (profile.headline) {
      await kgAddFact(subjectId, {
        category: "employment",
        key: "linkedin_headline",
        value: profile.headline,
        source: "collector:linkedin",
        is_current: true,
      });
    }
    if (profile.connections) {
      await kgAddFact(subjectId, {
        category: "social",
        key: "linkedin_connections",
        value: String(profile.connections),
        source: "collector:linkedin",
        is_current: true,
      });
    }
    if (profile.location) {
      await kgAddFact(subjectId, {
        category: "location",
        key: "linkedin_location",
        value: profile.location,
        source: "collector:linkedin",
        is_current: true,
      });
    }
    if (profile.current_company) {
      await kgAddFact(subjectId, {
        category: "employment",
        key: "current_company",
        value: profile.current_company,
        source: "collector:linkedin",
        is_current: true,
      });
    }
    if (photo) {
      await kgAddFact(subjectId, {
        category: "media",
        key: "profile_photo",
        value: JSON.stringify({ platform: "linkedin", path: photo.screenshotFilename, avatar: photo.avatar }),
        source: "collector:linkedin",
        is_current: true,
      });
    }

    console.log(`[collector:li] Profile collected (normalized):`, profile);

    // ENRICH (async — don't block collection)
    enricher.enrichAndStore(subjectId, profile, photo ? photo.screenshotFilename : null)
      .then((e) => console.log(`[collector:li] Enrichment complete`))
      .catch((err) => console.error(`[collector:li] Enrichment failed:`, err.message));

    return { ...profile, photo: photo ? photo.screenshotFilename : null };
  },

  async collectFeed(subjectId) {
    console.log(`[collector:li] Collecting LinkedIn feed...`);

    shell("am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n com.linkedin.android/.authenticator.LaunchActivityDefault");
    await sleep(8000);

    // Check for CAPTCHA
    await this._handleCaptcha();

    const observations = [];

    for (let scroll = 0; scroll < 3; scroll++) {
      const nodes = await dumpUI();
      const posts = this._parseFeed(nodes);

      for (const post of posts) {
        const { normalized } = normalizer.normalize("linkedin", "post", post);
        const obs = await kgAddObservation(subjectId, {
          platform: "linkedin",
          observation_type: "post",
          content: JSON.stringify(normalized),
          raw_data: post,
          author_handle: normalized.author || null,
          entities_extracted: normalized.author ? [normalized.author] : [],
        });
        observations.push(obs);
      }

      swipe(540, 1400, 540, 400, 500);
      await sleep(3000);
    }

    console.log(`[collector:li] Collected ${observations.length} feed items`);
    return { items: observations.length };
  },

  _parseProfile(nodes) {
    const profile = { raw_texts: [] };

    for (const n of nodes) {
      const t = n.text || n.desc || "";
      if (!t) continue;
      profile.raw_texts.push(t);

      // Connection count
      const connMatch = t.match(/([\d,]+)\+?\s*connections?/i);
      if (connMatch) profile.connections = connMatch[1];

      const followerMatch = t.match(/([\d,]+)\+?\s*followers?/i);
      if (followerMatch) profile.followers = followerMatch[1];
    }

    // Name is usually the first prominent text
    const nameNode = nodes.find(
      (n) => n.text && n.bounds.y1 > 200 && n.bounds.y1 < 600 && n.text.length > 2 && n.text.length < 50
    );
    if (nameNode) profile.name = nameNode.text;

    // Headline is usually below the name
    if (nameNode) {
      const headlineNode = nodes.find(
        (n) => n.text && n.bounds.y1 > nameNode.bounds.y2 && n.bounds.y1 < nameNode.bounds.y2 + 200 && n.text.length > 5
      );
      if (headlineNode) profile.headline = headlineNode.text;
    }

    return profile;
  },

  _parseFeed(nodes) {
    const posts = [];

    for (const n of nodes) {
      const desc = n.desc || "";
      // LinkedIn feed items have rich content-desc
      if (desc.length > 100) {
        posts.push({
          text: desc.substring(0, 500),
          author: null, // Hard to parse from content-desc
        });
      }
    }

    return posts;
  },
};

// ── Orchestrator ──

/**
 * Run a collection job
 * @param {string} platform - "twitter" | "linkedin"
 * @param {string} action - "profile" | "feed"
 * @param {number} subjectId - KG subject ID
 * @param {object} params - { handle, profileUrl, etc. }
 */
async function collect(platform, action, subjectId, params = {}) {
  const collector = collectors[platform];
  if (!collector) throw new Error(`Unknown platform: ${platform}`);

  // Get best available account for this platform
  const account = accountPool.getBestAccount(platform);
  if (!account) {
    const status = accountPool.getStatus();
    const platInfo = status.byPlatform[platform] || { total: 0 };
    return {
      ok: false,
      platform,
      action,
      error: `No available accounts for ${platform} (${platInfo.total} total, all in cooldown/restricted/banned)`,
    };
  }

  console.log(`[collector] Using account ${account.id} (tier ${account.tier}, owner: ${account.owner})`);
  activeAccounts[platform] = account.id;

  const startTime = Date.now();
  let result;

  try {
    if (action === "profile") {
      if (platform === "twitter") {
        result = await collector.collectProfile(subjectId, params.handle);
      } else if (platform === "linkedin") {
        result = await collector.collectProfile(subjectId, params.profileUrl);
      }
    } else if (action === "feed") {
      result = await collector.collectFeed(subjectId);
    } else {
      throw new Error(`Unknown action: ${action}`);
    }

    // Mark account as used
    accountPool.markUsed(account.id);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[collector] ${platform}/${action} completed in ${elapsed}s (account: ${account.id})`);
    return { ok: true, platform, action, account: account.id, elapsed: +elapsed, result };
  } catch (err) {
    // If it looks like a rate limit or restriction, put account on cooldown
    const msg = err.message.toLowerCase();
    if (msg.includes("rate") || msg.includes("limit") || msg.includes("restricted")) {
      accountPool.markCooldown(account.id, 60);
    }
    console.error(`[collector] ${platform}/${action} failed:`, err.message);
    return { ok: false, platform, action, account: account.id, error: err.message };
  }
}

/**
 * Get the current state of the Redroid device
 */
async function getDeviceState() {
  const pkg = getForegroundPkg();
  const texts = dumpUIText();
  return {
    foreground_app: pkg,
    visible_texts: texts.slice(0, 20),
    adb_connected: !!pkg,
  };
}

const discovery = require("./discovery");

module.exports = {
  collect,
  collectors,
  getDeviceState,
  captchaSolver,
  accountPool,
  normalizer,
  enricher,
  discovery,
  adb,
  shell,
  tap,
  swipe,
  sleep,
  dumpUI,
  dumpUIText,
};

// ── Standalone HTTP Server ──
// Run with: node collector.js
// Listens on COLLECTOR_PORT (default 3334) and proxies collection requests

if (require.main === module) {
  const http = require("http");

  function parseJSON(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try { resolve(body ? JSON.parse(body) : {}); }
        catch (e) { reject(e); }
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${COLLECTOR_PORT}`);
    const pathname = url.pathname;
    const send = (code, data) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };

    try {
      // GET /device — current device state
      if (req.method === "GET" && pathname === "/device") {
        const state = await getDeviceState();
        return send(200, state);
      }

      // POST /collect — run collection job
      if (req.method === "POST" && pathname === "/collect") {
        const body = await parseJSON(req);
        if (!body.platform || !body.action || !body.subject_id) {
          return send(400, { error: "platform, action, and subject_id required" });
        }
        const result = await collect(body.platform, body.action, body.subject_id, body.params || {});
        return send(200, result);
      }

      // POST /solve-captcha — detect and solve CAPTCHA on current WebView
      if (req.method === "POST" && pathname === "/solve-captcha") {
        const body = await parseJSON(req);
        const pageUrl = body.url || "https://www.linkedin.com";
        const result = await captchaSolver.detectAndSolve(pageUrl);
        return send(200, result);
      }

      // GET /pool — account pool status
      if (req.method === "GET" && pathname === "/pool") {
        return send(200, accountPool.getStatus());
      }

      // POST /pool/add — add account to pool
      if (req.method === "POST" && pathname === "/pool/add") {
        const body = await parseJSON(req);
        if (!body.email || !body.platform) {
          return send(400, { error: "email and platform required" });
        }
        const acct = accountPool.addAccount(body);
        return send(201, { ok: true, account: acct });
      }

      // POST /pool/health — update account health
      if (req.method === "POST" && pathname === "/pool/health") {
        const body = await parseJSON(req);
        if (!body.id || !body.health) {
          return send(400, { error: "id and health required" });
        }
        switch (body.health) {
          case "good": accountPool.markGood(body.id); break;
          case "cooldown": accountPool.markCooldown(body.id, body.minutes); break;
          case "restricted": accountPool.markRestricted(body.id, body.reason); break;
          case "banned": accountPool.markBanned(body.id); break;
          default: return send(400, { error: "health must be good|cooldown|restricted|banned" });
        }
        return send(200, { ok: true });
      }

      // POST /enrich — enrich a profile with face matching + NLP
      if (req.method === "POST" && pathname === "/enrich") {
        const body = await parseJSON(req);
        if (!body.subject_id) {
          return send(400, { error: "subject_id required" });
        }
        const result = await enricher.enrichAndStore(
          body.subject_id,
          body.normalized || {},
          body.photo_filename || null
        );
        return send(200, result);
      }

      // POST /face-match — match a photo against the face DB
      if (req.method === "POST" && pathname === "/face-match") {
        const body = await parseJSON(req);
        if (!body.photo_filename) {
          return send(400, { error: "photo_filename required" });
        }
        const photoPath = require("path").join(enricher.PHOTO_DIR, body.photo_filename);
        const result = body.all_faces
          ? await enricher.matchAllFaces(photoPath, body)
          : await enricher.matchFace(photoPath, body);
        return send(200, result);
      }

      // POST /normalize — normalize raw content without collecting
      if (req.method === "POST" && pathname === "/normalize") {
        const body = await parseJSON(req);
        if (!body.platform || !body.type || !body.content) {
          return send(400, { error: "platform, type, and content required" });
        }
        const result = normalizer.normalize(body.platform, body.type, body.content, {
          capturePhoto: false,
        });
        return send(200, result);
      }

      // POST /renormalize — re-normalize an existing observation by ID
      if (req.method === "POST" && pathname === "/renormalize") {
        const body = await parseJSON(req);
        if (!body.observation_id) {
          return send(400, { error: "observation_id required" });
        }
        // Fetch observation from bridge
        const resp = await fetch(`${BRIDGE_URL}/kg/subjects/1/observations?limit=200`);
        const observations = await resp.json();
        const obs = observations.find((o) => o.id === body.observation_id);
        if (!obs) return send(404, { error: "Observation not found" });
        const result = normalizer.renormalize(obs);
        return send(200, { original: obs, ...result });
      }

      // POST /discover — discover new subjects from a KG subject's social connections
      if (req.method === "POST" && pathname === "/discover") {
        const body = await parseJSON(req);
        if (!body.subject_id || !body.handle) {
          return send(400, { error: "subject_id and handle required" });
        }
        const result = await discovery.discoverFromSubject(
          body.subject_id, body.handle, {
            listType: body.list_type || "following",
            maxPerList: body.max || 50,
            scrollPasses: body.scroll_passes || 10,
            autoCollect: body.auto_collect || false,
          }
        );
        return send(200, { ok: true, ...result });
      }

      // POST /discover-all — discover from all active subjects
      if (req.method === "POST" && pathname === "/discover-all") {
        const body = await parseJSON(req);
        // Run in background — return immediately
        discovery.discoverAll(body).then(r => {
          console.log(`[collector] Discovery sweep complete:`, JSON.stringify(r));
        }).catch(err => {
          console.error(`[collector] Discovery sweep failed:`, err.message);
        });
        return send(202, { ok: true, message: "Discovery sweep started" });
      }

      // POST /adb — raw ADB command (for debugging)
      if (req.method === "POST" && pathname === "/adb") {
        const body = await parseJSON(req);
        if (!body.cmd) return send(400, { error: "cmd required" });
        const out = shell(body.cmd);
        return send(200, { output: out });
      }

      send(404, { error: "Not found" });
    } catch (err) {
      send(500, { error: err.message });
    }
  });

  server.listen(COLLECTOR_PORT, () => {
    console.log(`[collector] OSINT collector service running on port ${COLLECTOR_PORT}`);
    console.log(`[collector] ADB device: ${ADB_DEVICE}`);
    console.log(`[collector] Bridge URL: ${BRIDGE_URL}`);
  });
}
