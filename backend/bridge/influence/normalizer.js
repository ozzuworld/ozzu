/**
 * OSINT Normalizer — structured entity extraction from raw scrapes
 *
 * Takes raw UI text dumps from ADB collectors and produces clean,
 * machine-readable structured data. Also captures profile photos
 * for face matching via Qdrant.
 *
 * Pipeline stage: COLLECT → [NORMALIZE] → ENRICH → STORE
 *
 * Directive: dir_1775980363354
 */

"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ADB_DEVICE = process.env.ADB_DEVICE || "localhost:5556";
const PHOTO_DIR = path.join(__dirname, "..", "..", "..", "data", "kg-photos");

// Ensure photo dir exists
if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true });

// ── Number Parsing ──

/**
 * Parse human-readable numbers: "237M" → 237000000, "1,312" → 1312, "720K" → 720000
 */
function parseCount(str) {
  if (!str || typeof str !== "string") return null;
  str = str.replace(/,/g, "").trim();

  const m = str.match(/^([\d.]+)\s*([KkMmBb])?$/);
  if (!m) return null;

  let num = parseFloat(m[1]);
  const suffix = (m[2] || "").toUpperCase();
  if (suffix === "K") num *= 1000;
  else if (suffix === "M") num *= 1000000;
  else if (suffix === "B") num *= 1000000000;

  return Math.round(num);
}

/**
 * Parse a "Joined" date string: "June 2009" → "2009-06", "Sep 2009" → "2009-09"
 */
function parseJoinedDate(str) {
  if (!str) return null;
  const months = {
    jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03",
    apr: "04", april: "04", may: "05", jun: "06", june: "06",
    jul: "07", july: "07", aug: "08", august: "08", sep: "09", september: "09",
    oct: "10", october: "10", nov: "11", november: "11", dec: "12", december: "12",
  };
  const m = str.match(/(\w+)\s+(\d{4})/);
  if (!m) return null;
  const month = months[m[1].toLowerCase()];
  if (!month) return null;
  return `${m[2]}-${month}`;
}

// ── Text Filtering ──

// UI noise that should never be treated as profile content
const NOISE_PATTERNS = [
  /^header image$/i, /^profile image$/i, /^navigate up$/i,
  /^search button$/i, /^more options$/i, /^new post$/i,
  /^posts?$/i, /^replies$/i, /^subs$/i, /^highlights$/i, /^media$/i,
  /^subscribe$/i, /^follow$/i,
  /^unfollow$/i, /^grok profile summary$/i, /^never miss a post/i,
  /^device follow/i, /^not followed by/i, /^pinned$/i,
  /^tab \d+ of \d+$/i, /^home$/i, /^back$/i,
];

function isNoise(text) {
  if (!text || text.length < 2) return true;
  return NOISE_PATTERNS.some((p) => p.test(text.trim()));
}

function cleanTexts(raw_texts) {
  return (raw_texts || []).filter((t) => !isNoise(t));
}

// ── Photo Capture ──

/**
 * Screenshot the current Redroid screen and crop the profile photo area.
 * Returns the local file path or null.
 */
function captureProfilePhoto(subjectId, platform) {
  try {
    const filename = `${platform}_${subjectId}_${Date.now()}.png`;
    const devicePath = "/sdcard/kg-screenshot.png";
    const localPath = path.join(PHOTO_DIR, filename);

    // Take screenshot
    execSync(`adb -s ${ADB_DEVICE} shell screencap -p ${devicePath}`, { timeout: 10000 });
    // Pull to local
    execSync(`adb -s ${ADB_DEVICE} pull ${devicePath} ${localPath}`, { timeout: 10000 });

    if (fs.existsSync(localPath)) {
      const stats = fs.statSync(localPath);
      if (stats.size > 1000) {
        console.log(`[normalizer] Screenshot saved: ${filename} (${Math.round(stats.size / 1024)}KB)`);
        return { path: localPath, filename };
      }
    }
    return null;
  } catch (err) {
    console.error(`[normalizer] Screenshot failed:`, err.message);
    return null;
  }
}

/**
 * Crop a profile photo from a full screenshot using ImageMagick or sharp.
 * Platform-specific crop regions based on standard app layouts.
 */
function cropProfilePhoto(screenshotPath, platform) {
  const cropRegions = {
    twitter: { x: 36, y: 260, w: 200, h: 200 },    // X profile avatar position
    linkedin: { x: 36, y: 300, w: 200, h: 200 },    // LinkedIn avatar
    tiktok: { x: 200, y: 200, w: 200, h: 200 },     // TikTok centered avatar
    instagram: { x: 36, y: 300, w: 200, h: 200 },   // IG avatar
  };

  const region = cropRegions[platform] || cropRegions.twitter;
  const croppedPath = screenshotPath.replace(".png", "_avatar.png");

  try {
    // Try convert (ImageMagick)
    execSync(
      `convert "${screenshotPath}" -crop ${region.w}x${region.h}+${region.x}+${region.y} +repage "${croppedPath}"`,
      { timeout: 10000 }
    );
    if (fs.existsSync(croppedPath) && fs.statSync(croppedPath).size > 500) {
      return croppedPath;
    }
  } catch {
    // ImageMagick not available — return full screenshot
    console.log("[normalizer] ImageMagick not available, using full screenshot");
  }
  return null;
}

// ── Platform Normalizers ──

const normalizers = {};

/**
 * Normalize X/Twitter profile data
 */
normalizers.twitter = {
  profile(rawContent) {
    let raw;
    try { raw = typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent; }
    catch { return { error: "Invalid JSON" }; }

    const allTexts = raw.raw_texts || [];
    const texts = cleanTexts(allTexts);
    const handle = raw.handle || null;

    const normalized = {
      platform: "twitter",
      type: "profile",
      handle,
      display_name: null,
      bio: null,
      location: null,
      joined: null,
      followers: null,
      following: null,
      verified: false,
      website: null,
      _raw_texts: texts,
    };

    // Check for verified badge in unfiltered texts (X puts "Verified" in various nodes)
    if (allTexts.some((t) => t.includes("Verified"))) normalized.verified = true;

    // Find handle position in text array
    let handleIdx = -1;
    for (let i = 0; i < texts.length; i++) {
      if (texts[i].includes(`@${handle}`)) { handleIdx = i; break; }
    }

    // Display name: text immediately before @handle that isn't noise
    if (handleIdx > 0) {
      for (let i = handleIdx - 1; i >= 0; i--) {
        const t = texts[i].replace(/[\u202f\u200b]/g, "").trim();
        if (t.length > 1 && !t.startsWith("@") && !isNoise(t)
            && !t.includes("Following") && !t.includes("Unfollow")) {
          normalized.display_name = t;
          break;
        }
      }
    }

    // Parse all texts for structured data — handle split text nodes
    // X app often puts "237M" and "Followers" in separate nodes
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      const next = texts[i + 1] || "";

      // Followers — same node ("237M Followers") or split ("237M" + "Followers")
      const fm = t.match(/([\d,.]+[KMB]?)\s*[Ff]ollowers/);
      if (fm) { normalized.followers = parseCount(fm[1]); }
      else if (next.match(/^[Ff]ollowers$/i) && t.match(/^[\d,.]+[KMB]?$/)) {
        normalized.followers = parseCount(t);
      }

      // Following — same node or split
      const fgm = t.match(/([\d,.]+[KMB]?)\s*[Ff]ollowing/);
      if (fgm) { normalized.following = parseCount(fgm[1]); }
      else if (next.match(/^[Ff]ollowing$/i) && t.match(/^[\d,.]+[KMB]?$/)) {
        normalized.following = parseCount(t);
      }

      // Joined
      const jm = t.match(/[Jj]oined\s+(\w+\s+\d{4})/);
      if (jm) normalized.joined = parseJoinedDate(jm[1]);

      // Location — either "Location: X" format or standalone between bio and Joined
      if (t.includes("Location:")) {
        normalized.location = t.replace(/Location:/i, "").trim();
      }

      // Verified
      if (t.includes("Verified")) normalized.verified = true;

      // Website/URL in bio area (after handle, before Joined)
      if (handleIdx >= 0 && i > handleIdx) {
        if (t.match(/^Joined /)) continue;
        const urlM = t.match(/^(https?:\/\/\S+|[\w]+\.(?:com|org|net|io|ai|co)\S*)/i);
        if (urlM && !normalized.website) normalized.website = urlM[1];
      }
    }

    // Bio + Location: text between @handle and "Joined"
    // Location is usually a short "City, ST" or "City, Country" text
    if (handleIdx >= 0) {
      const bioTexts = [];
      for (let i = handleIdx + 1; i < texts.length; i++) {
        const t = texts[i];
        if (t.match(/^Joined /)) break;
        if (t.match(/^\d/) && t.match(/[Ff]ollow/)) continue;
        if (t.match(/^(https?:\/\/|[\w]+\.(com|org|net|io|ai|co))/i)) continue;
        if (t === "Verified" || t.match(/^Verified\s*$/)) continue;
        if (isNoise(t) || t.length <= 3) continue;

        // Detect location: short text matching "City, State/Country" pattern
        if (!normalized.location && t.length < 50 &&
            t.match(/^[A-Z][\w\s]+,\s*[A-Z][\w\s]+$/)) {
          normalized.location = t;
          continue;
        }

        bioTexts.push(t);
      }
      if (bioTexts.length) normalized.bio = bioTexts.join(" ");
    }

    // Remove internal field
    delete normalized._raw_texts;
    return normalized;
  },

  post(rawContent) {
    let raw;
    try { raw = typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent; }
    catch { return { error: "Invalid JSON" }; }

    // Parse the content-desc formatted tweet text
    const text = raw.text || "";

    // Extract author — handle formats like "Elon Musk @elonmusk Verified X." or "Name @handle."
    const authorM = text.match(/^(.+?)\s+@(\w+)/);

    // Extract engagement
    const normalized = {
      platform: "twitter",
      type: "post",
      author_name: authorM ? authorM[1] : null,
      author_handle: authorM ? authorM[2] : null,
      content: null,
      mentions: raw.mentions || [],
      engagement: {
        likes: parseCount(raw.likes) || parseCount(text.match(/([\d,]+)\s*likes?/i)?.[1]),
        reposts: parseCount(raw.reposts) || parseCount(text.match(/([\d,]+)\s*reposts?/i)?.[1]),
        replies: parseCount(raw.replies) || parseCount(text.match(/([\d,]+)\s*repl(?:y|ies)/i)?.[1]),
        views: parseCount(text.match(/([\d,]+)\s*(?:verified\s+)?views?/i)?.[1]),
      },
      verified: text.includes("Verified"),
      is_pinned: text.includes("Pinned"),
      posted_ago: null,
      media: null,
    };

    // Extract post content (between author info and engagement stats)
    // Content-desc format: "Author @handle Verified.    Content here       Pinned.      4 days ago.  N replies..."
    const contentM = text.match(/@\w+[^.]*\.\s{2,}(.+?)(?:\s{2,}(?:Pinned|[\d,]+ (?:repl|repost|like|view)))/s);
    if (contentM) {
      normalized.content = contentM[1].replace(/&#10;/g, "\n").replace(/\s{2,}/g, " ").trim();
    }

    // Time ago
    const timeM = text.match(/(\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)/i);
    if (timeM) normalized.posted_ago = timeM[1];

    // Media
    if (text.includes("pic.x.com") || text.includes("pic.twitter.com")) {
      normalized.media = "image";
    }
    if (text.includes("video")) normalized.media = "video";

    return normalized;
  },
};

/**
 * Normalize LinkedIn profile data
 */
normalizers.linkedin = {
  profile(rawContent) {
    let raw;
    try { raw = typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent; }
    catch { return { error: "Invalid JSON" }; }

    const texts = cleanTexts(raw.raw_texts || []);

    const normalized = {
      platform: "linkedin",
      type: "profile",
      name: raw.name || null,
      headline: raw.headline || null,
      location: null,
      connections: parseCount(raw.connections),
      followers: parseCount(raw.followers),
      current_company: null,
      education: null,
      _raw_texts: texts,
    };

    // Scan texts for structured data
    for (const t of texts) {
      // Connection count
      const cm = t.match(/([\d,]+)\+?\s*connections?/i);
      if (cm) normalized.connections = parseCount(cm[1]);

      // Follower count
      const fm = t.match(/([\d,]+)\+?\s*followers?/i);
      if (fm) normalized.followers = parseCount(fm[1]);

      // Location patterns (usually "City, Country" or "Metropolitan Area")
      if (t.match(/,\s*(Colombia|Spain|USA|United|Mexico|Brazil|India|UK)/i)) {
        if (!normalized.location) normalized.location = t.trim();
      }
      if (t.match(/Metropolitan Area/i)) {
        if (!normalized.location) normalized.location = t.trim();
      }
    }

    // Extract headline from position after name if not already parsed
    if (!normalized.headline && normalized.name) {
      const nameIdx = texts.indexOf(normalized.name);
      if (nameIdx >= 0 && nameIdx + 1 < texts.length) {
        const candidate = texts[nameIdx + 1];
        if (candidate && candidate.length > 5 && !candidate.match(/^\d/) && !isNoise(candidate)) {
          normalized.headline = candidate;
        }
      }
    }

    // Try to extract company from headline
    if (normalized.headline) {
      const atM = normalized.headline.match(/(?:at|@)\s+(.+?)(?:\s*[|·]|$)/i);
      if (atM) normalized.current_company = atM[1].trim();
    }

    delete normalized._raw_texts;
    return normalized;
  },

  post(rawContent) {
    let raw;
    try { raw = typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent; }
    catch { return { error: "Invalid JSON" }; }

    return {
      platform: "linkedin",
      type: "post",
      author: raw.author || null,
      content: (raw.text || "").substring(0, 500),
      engagement: {},
    };
  },
};

// ── Main Normalize Function ──

/**
 * Normalize a raw observation into structured data.
 *
 * @param {string} platform - twitter|linkedin|tiktok|instagram|discord
 * @param {string} observationType - profile_update|post|activity|etc.
 * @param {string|object} rawContent - raw content from collector
 * @param {object} opts - { capturePhoto: bool, subjectId: number }
 * @returns {{ normalized: object, photo: object|null }}
 */
function normalize(platform, observationType, rawContent, opts = {}) {
  const normalizer = normalizers[platform];
  if (!normalizer) {
    // Fallback: return raw content as-is with basic parsing
    return {
      normalized: {
        platform,
        type: observationType,
        raw: typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent),
      },
      photo: null,
    };
  }

  // Map observation types to normalizer methods
  const typeMap = {
    profile_update: "profile",
    post: "post",
    comment: "post",
    activity: "post",
  };
  const method = typeMap[observationType] || "post";

  let normalized;
  if (normalizer[method]) {
    normalized = normalizer[method](rawContent);
  } else {
    normalized = {
      platform,
      type: observationType,
      raw: typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent),
    };
  }

  // Capture photo if requested and this is a profile observation
  let photo = null;
  if (opts.capturePhoto && observationType === "profile_update" && opts.subjectId) {
    const screenshot = captureProfilePhoto(opts.subjectId, platform);
    if (screenshot) {
      const cropped = cropProfilePhoto(screenshot.path, platform);
      photo = {
        screenshot: screenshot.path,
        screenshotFilename: screenshot.filename,
        avatar: cropped,
        subjectId: opts.subjectId,
        platform,
        capturedAt: new Date().toISOString(),
      };
    }
  }

  return { normalized, photo };
}

/**
 * Re-normalize an existing observation from the DB.
 * Useful for backfilling structured data from old raw observations.
 */
function renormalize(observation) {
  return normalize(
    observation.platform,
    observation.observation_type,
    observation.content,
    { capturePhoto: false }
  );
}

module.exports = {
  normalize,
  renormalize,
  normalizers,
  parseCount,
  parseJoinedDate,
  captureProfilePhoto,
  cropProfilePhoto,
  cleanTexts,
  isNoise,
  PHOTO_DIR,
};
