// Face Crawler — background service that scrapes social media profile photos
// and indexes face embeddings into Qdrant for future face searches.
//
// Sources:
//   1. Wikipedia "People" categories — high-quality, public domain photos
//   2. Reddit user avatars (via public JSON API)
//   3. Twitter/X profile photos (via browser automation)
//   4. VK public profiles (relatively open API)
//   5. Web crawl: given a list of names, fetch images from search + social
//
// Each crawled image: detect face → generate ArcFace embedding → store in Qdrant
// The face DB grows over time, making searches more effective for non-celebrities.

const fs = require("fs");
const path = require("path");

const FACE_API = "http://127.0.0.1:5555";
const BROWSER_API = "http://127.0.0.1:3334";
const CRAWL_STATE_FILE = "/tmp/osint-data/crawl-state.json";
const BATCH_SIZE = 10;
const DELAY_BETWEEN_ITEMS = 1000; // 1s between requests (be polite)

let _crawlState = null;

function getCrawlState() {
  if (_crawlState) return _crawlState;
  try {
    if (fs.existsSync(CRAWL_STATE_FILE)) {
      _crawlState = JSON.parse(fs.readFileSync(CRAWL_STATE_FILE, "utf8"));
    }
  } catch {}
  if (!_crawlState) {
    _crawlState = {
      wikipedia: { lastContinue: "", totalIndexed: 0, lastRun: null },
      reddit: { subreddits: [], offset: 0, totalIndexed: 0, lastRun: null },
      twitter: { totalIndexed: 0, lastRun: null },
      web: { totalIndexed: 0, lastRun: null },
      totalFacesIndexed: 0,
    };
  }
  return _crawlState;
}

function saveCrawlState() {
  try {
    fs.mkdirSync(path.dirname(CRAWL_STATE_FILE), { recursive: true });
    fs.writeFileSync(CRAWL_STATE_FILE, JSON.stringify(_crawlState, null, 2));
  } catch {}
}

async function faceFetch(endpoint, formData, timeout = 20000) {
  try {
    const res = await fetch(`${FACE_API}${endpoint}`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function indexImageUrl(imageUrl, metadata = {}) {
  try {
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2000) return null; // too small

    const form = new FormData();
    form.append("base64_image", buf.toString("base64"));
    if (metadata.profile_id) form.append("profile_id", metadata.profile_id);
    if (metadata.source_url) form.append("source_url", metadata.source_url);
    if (metadata.source_platform) form.append("source_platform", metadata.source_platform);
    if (metadata.label) form.append("label", metadata.label);
    return await faceFetch("/index", form);
  } catch {
    return null;
  }
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════
// CRAWLER 1: Wikipedia People (high quality, public domain)
// ═══════════════════════════════════════════════

async function crawlWikipediaPeople(limit = 50) {
  const state = getCrawlState();
  let indexed = 0;
  let processed = 0;

  console.log(`[face-crawler] Wikipedia: starting (last indexed: ${state.wikipedia.totalIndexed})`);

  try {
    // Get members of "Living people" category (largest people category)
    let continueParam = state.wikipedia.lastContinue || "";
    const categoryUrl = `https://en.wikipedia.org/w/api.php?action=query&list=categorymembers&cmtitle=Category:Living_people&cmlimit=${limit}&cmtype=page&format=json${continueParam ? `&cmcontinue=${continueParam}` : ""}`;

    const catRes = await fetch(categoryUrl, { signal: AbortSignal.timeout(15000) });
    if (!catRes.ok) return { indexed: 0, error: "Wikipedia API error" };
    const catData = await catRes.json();

    const pages = catData.query?.categorymembers || [];
    state.wikipedia.lastContinue = catData.continue?.cmcontinue || "";

    // For each person, get their main image
    for (const page of pages) {
      processed++;
      try {
        const imgUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(page.title)}&prop=pageimages&piprop=original&format=json`;
        const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(8000) });
        if (!imgRes.ok) continue;
        const imgData = await imgRes.json();

        const pageData = Object.values(imgData.query?.pages || {})[0];
        const imageUrl = pageData?.original?.source;
        if (!imageUrl) continue;

        // Skip SVGs and non-photo images
        if (imageUrl.match(/\.(svg|gif|png)$/i) && !imageUrl.match(/photo|portrait|headshot/i)) continue;

        const result = await indexImageUrl(imageUrl, {
          source_url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`,
          source_platform: "wikipedia",
          label: page.title,
        });

        if (result?.indexed > 0) {
          indexed++;
          state.wikipedia.totalIndexed++;
          state.totalFacesIndexed++;
        }

        await wait(DELAY_BETWEEN_ITEMS);
      } catch {}
    }
  } catch (err) {
    console.error("[face-crawler] Wikipedia error:", err.message);
  }

  state.wikipedia.lastRun = new Date().toISOString();
  saveCrawlState();
  console.log(`[face-crawler] Wikipedia: indexed ${indexed}/${processed} faces`);
  return { indexed, processed };
}

// ═══════════════════════════════════════════════
// CRAWLER 2: Reddit User Avatars
// ═══════════════════════════════════════════════

async function crawlRedditAvatars(subreddits = ["pics", "selfies", "amiugly", "roastme", "rateme"], limit = 30) {
  const state = getCrawlState();
  let indexed = 0;
  let processed = 0;

  console.log(`[face-crawler] Reddit: starting (subs: ${subreddits.join(", ")})`);

  for (const sub of subreddits) {
    try {
      // Get posts with images (Reddit JSON API — no auth needed)
      const url = `https://www.reddit.com/r/${sub}/hot.json?limit=${limit}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "OzzuIntel/1.0 (face indexing)" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const data = await res.json();

      for (const post of (data.data?.children || [])) {
        const d = post.data;
        if (!d) continue;

        // Get direct image URLs
        const imageUrl = d.url_overridden_by_dest || d.url || "";
        if (!imageUrl.match(/\.(jpg|jpeg|png)($|\?)/i) && !imageUrl.includes("i.redd.it")) continue;

        processed++;
        const result = await indexImageUrl(imageUrl, {
          source_url: `https://reddit.com${d.permalink}`,
          source_platform: "reddit",
          label: d.author || "",
        });

        if (result?.indexed > 0) {
          indexed++;
          state.reddit.totalIndexed++;
          state.totalFacesIndexed++;
        }

        await wait(DELAY_BETWEEN_ITEMS);
      }
    } catch (err) {
      console.error(`[face-crawler] Reddit r/${sub} error:`, err.message);
    }
  }

  state.reddit.lastRun = new Date().toISOString();
  saveCrawlState();
  console.log(`[face-crawler] Reddit: indexed ${indexed}/${processed} faces`);
  return { indexed, processed };
}

// ═══════════════════════════════════════════════
// CRAWLER 3: Name-based web image search
// Given a list of names, search for their photos and index faces
// ═══════════════════════════════════════════════

async function crawlNamedPeople(names, maxPerName = 5) {
  let indexed = 0;
  let processed = 0;
  const state = getCrawlState();

  console.log(`[face-crawler] Named people: ${names.length} names, max ${maxPerName} images each`);

  for (const name of names) {
    try {
      // Use Wikipedia to find images for this person
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(name)}&gsrlimit=3&prop=pageimages&piprop=original&format=json`;
      const res = await fetch(searchUrl, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const data = await res.json();

      let nameIndexed = 0;
      for (const page of Object.values(data.query?.pages || {})) {
        if (nameIndexed >= maxPerName) break;
        const imageUrl = page.original?.source;
        if (!imageUrl) continue;

        processed++;
        const result = await indexImageUrl(imageUrl, {
          source_url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title || name)}`,
          source_platform: "wikipedia",
          label: page.title || name,
        });

        if (result?.indexed > 0) {
          indexed++;
          nameIndexed++;
          state.web.totalIndexed++;
          state.totalFacesIndexed++;
        }
        await wait(500);
      }

      // Also try Wikidata for additional images
      try {
        const wdSearch = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&format=json&limit=2`;
        const wdRes = await fetch(wdSearch, { signal: AbortSignal.timeout(8000) });
        if (wdRes.ok) {
          const wdData = await wdRes.json();
          for (const entity of (wdData.search || []).slice(0, 1)) {
            if (nameIndexed >= maxPerName) break;
            const entUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${entity.id}&props=claims&format=json`;
            const entRes = await fetch(entUrl, { signal: AbortSignal.timeout(8000) });
            if (!entRes.ok) continue;
            const entData = await entRes.json();
            const claims = entData.entities?.[entity.id]?.claims || {};

            // P18 = image, P154 = logo
            for (const prop of ["P18"]) {
              for (const claim of (claims[prop] || []).slice(0, 2)) {
                if (nameIndexed >= maxPerName) break;
                const filename = claim.mainsnak?.datavalue?.value;
                if (!filename) continue;
                const fn = filename.replace(/ /g, "_");
                const crypto = require("crypto");
                const md5 = crypto.createHash("md5").update(fn).digest("hex");
                const commonsUrl = `https://upload.wikimedia.org/wikipedia/commons/${md5[0]}/${md5.slice(0, 2)}/${encodeURIComponent(fn)}`;

                processed++;
                const result = await indexImageUrl(commonsUrl, {
                  source_url: `https://www.wikidata.org/wiki/${entity.id}`,
                  source_platform: "wikidata",
                  label: entity.label || name,
                });
                if (result?.indexed > 0) {
                  indexed++;
                  nameIndexed++;
                  state.web.totalIndexed++;
                  state.totalFacesIndexed++;
                }
                await wait(500);
              }
            }
          }
        }
      } catch {}

      await wait(DELAY_BETWEEN_ITEMS);
    } catch (err) {
      console.error(`[face-crawler] Named "${name}" error:`, err.message);
    }
  }

  state.web.lastRun = new Date().toISOString();
  saveCrawlState();
  console.log(`[face-crawler] Named people: indexed ${indexed}/${processed} faces`);
  return { indexed, processed };
}

// ═══════════════════════════════════════════════
// CRAWLER 4: Twitter/X profile photos via browser
// ═══════════════════════════════════════════════

async function crawlTwitterProfiles(usernames, sessionId = null) {
  let indexed = 0;
  let processed = 0;
  const state = getCrawlState();
  const ownSession = !sessionId;

  if (ownSession) {
    sessionId = `crawl-tw-${Date.now()}`;
    await fetch(`${BROWSER_API}/session/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    }).catch(() => {});
  }

  console.log(`[face-crawler] Twitter: ${usernames.length} profiles`);

  try {
    for (const username of usernames) {
      try {
        // Navigate to profile
        const nav = await fetch(`${BROWSER_API}/navigate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: `https://x.com/${username}`, session_id: sessionId }),
          signal: AbortSignal.timeout(20000),
        });
        if (!nav.ok) continue;
        await wait(3000);

        // Extract profile photo URL
        const extract = await fetch(`${BROWSER_API}/evaluate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionId,
            script: `(() => {
              // Profile photo is the large avatar
              const img = document.querySelector('img[src*="profile_images"][src*="400x400"], img[src*="profile_images"][src*="200x200"], a[href$="/photo"] img');
              if (img) {
                // Get highest resolution
                return img.src.replace(/_normal|_bigger|_mini|_200x200|_reasonably_small/g, '_400x400');
              }
              return null;
            })()`,
          }),
          signal: AbortSignal.timeout(10000),
        });
        const extractData = await extract.json();
        const profilePhotoUrl = extractData?.result;

        if (profilePhotoUrl && profilePhotoUrl.startsWith("http")) {
          processed++;
          const result = await indexImageUrl(profilePhotoUrl, {
            source_url: `https://x.com/${username}`,
            source_platform: "twitter",
            label: username,
          });
          if (result?.indexed > 0) {
            indexed++;
            state.twitter.totalIndexed++;
            state.totalFacesIndexed++;
          }
        }

        await wait(2000);
      } catch {}
    }
  } finally {
    if (ownSession) {
      await fetch(`${BROWSER_API}/session/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      }).catch(() => {});
    }
  }

  state.twitter.lastRun = new Date().toISOString();
  saveCrawlState();
  console.log(`[face-crawler] Twitter: indexed ${indexed}/${processed} faces`);
  return { indexed, processed };
}

// ═══════════════════════════════════════════════
// ORCHESTRATOR: Run a full crawl cycle
// ═══════════════════════════════════════════════

async function runCrawlCycle(opts = {}) {
  const startTime = Date.now();
  const results = {};

  console.log("[face-crawler] === Starting crawl cycle ===");

  // 1. Wikipedia people (most reliable, highest quality)
  if (opts.wikipedia !== false) {
    results.wikipedia = await crawlWikipediaPeople(opts.wikiLimit || 50);
  }

  // 2. Reddit (public posts with face photos)
  if (opts.reddit !== false) {
    results.reddit = await crawlRedditAvatars(
      opts.subreddits || ["pics", "selfies", "HumanPorn", "portraits"],
      opts.redditLimit || 20
    );
  }

  // 3. Named people (if provided)
  if (opts.names?.length) {
    results.named = await crawlNamedPeople(opts.names, opts.maxPerName || 5);
  }

  // 4. Twitter profiles (if provided)
  if (opts.twitterUsers?.length) {
    results.twitter = await crawlTwitterProfiles(opts.twitterUsers);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalIndexed = Object.values(results).reduce((sum, r) => sum + (r?.indexed || 0), 0);
  const totalProcessed = Object.values(results).reduce((sum, r) => sum + (r?.processed || 0), 0);

  console.log(`[face-crawler] === Crawl cycle complete: ${totalIndexed}/${totalProcessed} faces indexed in ${elapsed}s ===`);

  // Get current DB size
  let dbStats = null;
  try {
    const statsRes = await fetch(`${FACE_API}/stats`, { signal: AbortSignal.timeout(5000) });
    if (statsRes.ok) dbStats = await statsRes.json();
  } catch {}

  return {
    results,
    totalIndexed,
    totalProcessed,
    elapsed: parseFloat(elapsed),
    dbStats,
    crawlState: getCrawlState(),
  };
}

// Get crawl status
function getStatus() {
  return getCrawlState();
}

module.exports = {
  crawlWikipediaPeople,
  crawlRedditAvatars,
  crawlNamedPeople,
  crawlTwitterProfiles,
  runCrawlCycle,
  getStatus,
};
