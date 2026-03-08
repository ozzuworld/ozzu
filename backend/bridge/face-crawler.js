// Face Crawler — 24/7 background service that builds a face database
//
// Runs continuously, crawling public sources for face images,
// embedding them via ArcFace, and indexing into Qdrant.
//
// Sources (in priority order):
//   1. Wikipedia Living People (1.5M+ bios with photos)
//   2. Wikimedia Commons People categories (deep photo archives)
//   3. Reddit face subreddits (public posts)
//   4. News sites (OG images from RSS feeds)
//   5. Named people lists (curated from crawl discoveries)
//
// The crawler runs as a loop with configurable intervals.
// It persists state so it resumes where it left off after restarts.
// Rate-limited to be polite to source APIs.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FACE_API = "http://127.0.0.1:5555";
const CRAWL_STATE_FILE = "/tmp/osint-data/crawl-state.json";
const CRAWL_NAMES_FILE = "/tmp/osint-data/crawl-names.json";

// Tuning — be aggressive but not abusive
const WIKI_BATCH = 100;        // pages per Wikipedia API call
const COMMONS_BATCH = 200;     // files per Commons category
const REDDIT_BATCH = 50;       // posts per subreddit
const NEWS_ARTICLES = 20;      // articles per RSS feed
const DELAY_MS = 500;          // between individual image indexing
const CYCLE_INTERVAL = 5 * 60 * 1000;  // 5 min between crawl cycles
const CYCLE_ITEMS = 200;       // target items per cycle (prevents runaway)

let _state = null;
let _running = false;
let _stopRequested = false;
let _cycleTimer = null;
let _stats = { cyclesCompleted: 0, totalIndexed: 0, totalProcessed: 0, startedAt: null, lastCycleAt: null, errors: 0 };

// ── State persistence ──────────────────────────

function getState() {
  if (_state) return _state;
  try {
    if (fs.existsSync(CRAWL_STATE_FILE)) {
      _state = JSON.parse(fs.readFileSync(CRAWL_STATE_FILE, "utf8"));
    }
  } catch {}
  // Ensure all fields exist (handles old state format)
  const defaults = {
    wikipedia: { lastContinue: "", pagesProcessed: 0, facesIndexed: 0 },
    commons: { categoriesProcessed: [], facesIndexed: 0 },
    reddit: { lastAfter: {}, facesIndexed: 0 },
    news: { sourcesProcessed: 0, facesIndexed: 0 },
    named: { queue: [], processed: [], facesIndexed: 0 },
    totalFacesIndexed: 0,
  };
  if (!_state) {
    _state = defaults;
  } else {
    // Merge defaults into existing state
    for (const [key, val] of Object.entries(defaults)) {
      if (typeof val === "object" && val !== null && !Array.isArray(val)) {
        _state[key] = { ...val, ...(_state[key] || {}) };
        // Ensure arrays exist
        for (const [k, v] of Object.entries(val)) {
          if (Array.isArray(v) && !Array.isArray(_state[key][k])) _state[key][k] = v;
          if (typeof v === "object" && v !== null && !Array.isArray(v) && typeof _state[key][k] !== "object") _state[key][k] = v;
        }
      } else if (_state[key] === undefined) {
        _state[key] = val;
      }
    }
  }
  return _state;
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(CRAWL_STATE_FILE), { recursive: true });
    fs.writeFileSync(CRAWL_STATE_FILE, JSON.stringify(_state, null, 2));
  } catch {}
}

// ── Face API helpers ───────────────────────────

async function indexImageUrl(imageUrl, metadata = {}) {
  try {
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2000) return null;

    const form = new FormData();
    form.append("base64_image", buf.toString("base64"));
    if (metadata.source_url) form.append("source_url", metadata.source_url);
    if (metadata.source_platform) form.append("source_platform", metadata.source_platform);
    if (metadata.label) form.append("label", metadata.label);

    const apiRes = await fetch(`${FACE_API}/index`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    if (!apiRes.ok) return null;
    return await apiRes.json();
  } catch {
    return null;
  }
}

function md5(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}

function commonsUrl(filename) {
  const fn = filename.replace(/ /g, "_");
  const hash = md5(fn);
  return `https://upload.wikimedia.org/wikipedia/commons/${hash[0]}/${hash.slice(0, 2)}/${encodeURIComponent(fn)}`;
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Source 1: Wikipedia Living People ──────────
// 1.5M+ articles, each potentially with a photo.
// We page through the category 100 at a time.

async function crawlWikipedia() {
  const state = getState();
  let indexed = 0;
  let processed = 0;

  try {
    const cont = state.wikipedia.lastContinue || "";
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=categorymembers&cmtitle=Category:Living_people&cmlimit=${WIKI_BATCH}&cmtype=page&format=json${cont ? `&cmcontinue=${cont}` : ""}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { indexed: 0, processed: 0 };
    const data = await res.json();

    const pages = data.query?.categorymembers || [];
    state.wikipedia.lastContinue = data.continue?.cmcontinue || "";

    // Batch fetch page images (50 at a time — MediaWiki limit)
    for (let i = 0; i < pages.length; i += 50) {
      if (_stopRequested) break;
      const batch = pages.slice(i, i + 50);
      const titles = batch.map(p => p.title).join("|");
      const imgUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(titles)}&prop=pageimages&piprop=original&format=json`;

      try {
        const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(15000) });
        if (!imgRes.ok) continue;
        const imgData = await imgRes.json();

        for (const page of Object.values(imgData.query?.pages || {})) {
          if (_stopRequested) break;
          const imageUrl = page.original?.source;
          if (!imageUrl) continue;
          if (imageUrl.match(/\.(svg|gif)$/i)) continue;

          processed++;
          const result = await indexImageUrl(imageUrl, {
            source_url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`,
            source_platform: "wikipedia",
            label: page.title,
          });

          if (result?.indexed > 0) {
            indexed++;
            state.wikipedia.facesIndexed++;
            state.totalFacesIndexed++;
            // Add to named people queue for deeper crawling later
            _addToNameQueue(page.title);
          }
          await wait(DELAY_MS);
        }
      } catch {}
    }

    state.wikipedia.pagesProcessed += pages.length;
  } catch (err) {
    console.error("[crawler] Wikipedia error:", err.message);
    _stats.errors++;
  }

  saveState();
  return { indexed, processed };
}

// ── Source 2: Wikimedia Commons People Categories ──
// Deep dive into Commons categories for known people.
// Each category can have 100+ photos of the same person.

async function crawlCommons() {
  const state = getState();
  let indexed = 0;
  let processed = 0;

  // Get people categories we haven't processed yet
  try {
    // Search for people categories
    const searchUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=incategory:"People by name"&srnamespace=14&srlimit=20&sroffset=${state.commons.categoriesProcessed.length}&format=json`;
    const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(10000) });
    if (!searchRes.ok) return { indexed: 0, processed: 0 };
    const searchData = await searchRes.json();

    for (const cat of (searchData.query?.search || [])) {
      if (_stopRequested) break;
      if (!Array.isArray(state.commons.categoriesProcessed)) state.commons.categoriesProcessed = [];
      if (state.commons.categoriesProcessed.includes(cat.title)) continue;

      // Get files in this category
      const filesUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=categorymembers&cmtitle=${encodeURIComponent(cat.title)}&cmtype=file&cmlimit=${COMMONS_BATCH}&format=json`;
      const filesRes = await fetch(filesUrl, { signal: AbortSignal.timeout(10000) });
      if (!filesRes.ok) continue;
      const filesData = await filesRes.json();

      const personName = cat.title.replace("Category:", "");

      for (const file of (filesData.query?.categorymembers || [])) {
        if (_stopRequested) break;
        if (!file.title.match(/\.(jpg|jpeg|png)$/i)) continue;

        const imgName = file.title.replace("File:", "");
        const imageUrl = commonsUrl(imgName);

        processed++;
        const result = await indexImageUrl(imageUrl, {
          source_url: `https://commons.wikimedia.org/wiki/${encodeURIComponent(file.title)}`,
          source_platform: "wikimedia_commons",
          label: personName,
        });

        if (result?.indexed > 0) {
          indexed++;
          state.commons.facesIndexed++;
          state.totalFacesIndexed++;
        }
        await wait(DELAY_MS);
      }

      state.commons.categoriesProcessed.push(cat.title);
      // Keep processed list manageable
      if (state.commons.categoriesProcessed.length > 10000) {
        state.commons.categoriesProcessed = state.commons.categoriesProcessed.slice(-5000);
      }
    }
  } catch (err) {
    console.error("[crawler] Commons error:", err.message);
    _stats.errors++;
  }

  saveState();
  return { indexed, processed };
}

// ── Source 3: Reddit Face Subreddits ───────────
// Cycle through subreddits with face photos.

const REDDIT_SUBS = [
  "pics", "selfies", "HumanPorn", "portraits", "headshots",
  "OldSchoolCool", "MakeupAddiction", "FreeCompliments",
  "Faces", "redditgetsdrawn", "RoastMe",
];

async function crawlReddit() {
  const state = getState();
  let indexed = 0;
  let processed = 0;

  for (const sub of REDDIT_SUBS) {
    if (_stopRequested) break;
    try {
      if (!state.reddit.lastAfter) state.reddit.lastAfter = {};
      const after = state.reddit.lastAfter[sub] || "";
      const url = `https://www.reddit.com/r/${sub}/hot.json?limit=${REDDIT_BATCH}${after ? `&after=${after}` : ""}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "OzzuIntel/1.0 (face indexing research)" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const data = await res.json();

      // Save pagination cursor
      if (!state.reddit.lastAfter) state.reddit.lastAfter = {};
      state.reddit.lastAfter[sub] = data.data?.after || "";

      for (const post of (data.data?.children || [])) {
        if (_stopRequested) break;
        const d = post.data;
        if (!d) continue;

        const imageUrl = d.url_overridden_by_dest || d.url || "";
        if (!imageUrl.match(/\.(jpg|jpeg|png)($|\?)/i) && !imageUrl.includes("i.redd.it") && !imageUrl.includes("i.imgur.com")) continue;

        processed++;
        const result = await indexImageUrl(imageUrl, {
          source_url: `https://reddit.com${d.permalink}`,
          source_platform: "reddit",
          label: d.title?.substring(0, 100) || d.author || "",
        });

        if (result?.indexed > 0) {
          indexed++;
          state.reddit.facesIndexed++;
          state.totalFacesIndexed++;
        }
        await wait(DELAY_MS);
      }
    } catch (err) {
      console.error(`[crawler] Reddit r/${sub} error:`, err.message);
      _stats.errors++;
    }
  }

  saveState();
  return { indexed, processed };
}

// ── Source 4: News Sites ──────────────────────
// Crawl news RSS feeds for article images.
// Many news photos are of public figures.

const NEWS_FEEDS = [
  "https://news.google.com/rss/search?q=celebrity+OR+politician+OR+CEO&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=actor+OR+actress+OR+musician&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=athlete+OR+sports+star&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=business+leader+OR+entrepreneur&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=world+leader+OR+president+OR+prime+minister&hl=en-US&gl=US&ceid=US:en",
];

async function crawlNews() {
  const state = getState();
  let indexed = 0;
  let processed = 0;

  if (typeof state.news.sourcesProcessed !== "number") state.news.sourcesProcessed = 0;
  const feedIndex = state.news.sourcesProcessed % NEWS_FEEDS.length;
  const feedUrl = NEWS_FEEDS[feedIndex];

  try {
    const res = await fetch(feedUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { indexed: 0, processed: 0 };
    const xml = await res.text();

    // Extract article URLs and titles
    const items = [];
    const itemRegex = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const title = match[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim();
      const url = match[2].trim();
      if (url.startsWith("http") && !url.includes("news.google.com")) {
        items.push({ title, url });
      }
    }

    for (const item of items.slice(0, NEWS_ARTICLES)) {
      if (_stopRequested) break;
      try {
        const pageRes = await fetch(item.url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
          signal: AbortSignal.timeout(8000),
          redirect: "follow",
        });
        if (!pageRes.ok) continue;
        const html = await pageRes.text();

        // Extract og:image
        const ogMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i) ||
                        html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:image"/i);
        if (!ogMatch?.[1]) continue;

        // Try to extract the person's name from the title
        const label = item.title.substring(0, 100);

        processed++;
        const result = await indexImageUrl(ogMatch[1], {
          source_url: item.url,
          source_platform: "news",
          label,
        });

        if (result?.indexed > 0) {
          indexed++;
          state.news.facesIndexed++;
          state.totalFacesIndexed++;
          // Extract potential names from the title for the queue
          _extractNamesFromTitle(item.title);
        }
        await wait(DELAY_MS);
      } catch {}
    }

    state.news.sourcesProcessed++;
  } catch (err) {
    console.error("[crawler] News error:", err.message);
    _stats.errors++;
  }

  saveState();
  return { indexed, processed };
}

// ── Source 5: Named People Deep Crawl ─────────
// For people discovered during crawling, do a deeper search
// via Wikipedia + Wikidata + Commons categories.

async function crawlNamedPeople() {
  const state = getState();
  let indexed = 0;
  let processed = 0;

  // Get next batch of names from queue
  const queue = state.named.queue || [];
  const batch = queue.splice(0, 10);
  if (batch.length === 0) return { indexed: 0, processed: 0 };

  for (const name of batch) {
    if (_stopRequested) break;
    if (state.named.processed.includes(name)) continue;

    try {
      // Search Wikipedia for this person
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(name)}&gsrlimit=2&prop=pageimages|images&piprop=original&imlimit=20&format=json`;
      const res = await fetch(searchUrl, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const data = await res.json();

      for (const page of Object.values(data.query?.pages || {})) {
        // Main page image
        if (page.original?.source) {
          processed++;
          const result = await indexImageUrl(page.original.source, {
            source_url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`,
            source_platform: "wikipedia",
            label: page.title || name,
          });
          if (result?.indexed > 0) {
            indexed++;
            state.named.facesIndexed++;
            state.totalFacesIndexed++;
          }
          await wait(DELAY_MS);
        }

        // Article images
        for (const img of (page.images || [])) {
          if (_stopRequested) break;
          if (!img.title.match(/\.(jpg|jpeg|png)$/i)) continue;
          if (img.title.match(/Commons-logo|Flag_of|Icon|Map_of|Coat_of|Seal_of|Logo/i)) continue;

          const imgName = img.title.replace("File:", "");
          const imageUrl = commonsUrl(imgName);

          processed++;
          const result = await indexImageUrl(imageUrl, {
            source_url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title || name)}`,
            source_platform: "wikipedia",
            label: page.title || name,
          });
          if (result?.indexed > 0) {
            indexed++;
            state.named.facesIndexed++;
            state.totalFacesIndexed++;
          }
          await wait(DELAY_MS);
        }
      }

      // Search Commons categories for this person
      try {
        const catUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&srnamespace=14&srlimit=2&format=json`;
        const catRes = await fetch(catUrl, { signal: AbortSignal.timeout(8000) });
        if (catRes.ok) {
          const catData = await catRes.json();
          for (const cat of (catData.query?.search || [])) {
            const filesUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=categorymembers&cmtitle=${encodeURIComponent(cat.title)}&cmtype=file&cmlimit=50&format=json`;
            const filesRes = await fetch(filesUrl, { signal: AbortSignal.timeout(8000) });
            if (!filesRes.ok) continue;
            const filesData = await filesRes.json();

            for (const file of (filesData.query?.categorymembers || [])) {
              if (_stopRequested) break;
              if (!file.title.match(/\.(jpg|jpeg|png)$/i)) continue;
              const imgName = file.title.replace("File:", "");

              processed++;
              const result = await indexImageUrl(commonsUrl(imgName), {
                source_url: `https://commons.wikimedia.org/wiki/${encodeURIComponent(file.title)}`,
                source_platform: "wikimedia_commons",
                label: name,
              });
              if (result?.indexed > 0) {
                indexed++;
                state.named.facesIndexed++;
                state.totalFacesIndexed++;
              }
              await wait(DELAY_MS);
            }
          }
        }
      } catch {}

      state.named.processed.push(name);
      // Keep processed list manageable
      if (state.named.processed.length > 50000) {
        state.named.processed = state.named.processed.slice(-25000);
      }
    } catch (err) {
      console.error(`[crawler] Named "${name}" error:`, err.message);
      _stats.errors++;
    }
  }

  saveState();
  return { indexed, processed };
}

// ── Helper: add names to the crawl queue ──────

function _addToNameQueue(name) {
  const state = getState();
  if (!state.named.queue) state.named.queue = [];
  if (!state.named.processed) state.named.processed = [];
  if (!state.named.queue.includes(name) && !state.named.processed.includes(name)) {
    state.named.queue.push(name);
  }
}

function _extractNamesFromTitle(title) {
  // Simple heuristic: capitalized words that look like names
  const words = title.replace(/[^a-zA-Z\s'-]/g, "").split(/\s+/);
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i].length > 1 && words[i][0] === words[i][0].toUpperCase() &&
        words[i + 1].length > 1 && words[i + 1][0] === words[i + 1][0].toUpperCase()) {
      const name = `${words[i]} ${words[i + 1]}`;
      if (name.length > 4 && name.length < 40) {
        _addToNameQueue(name);
      }
    }
  }
}

// ══════════════════════════════════════════════
// CRAWLER SERVICE — runs continuously
// ══════════════════════════════════════════════

async function runCycle() {
  if (_stopRequested) return;

  const cycleStart = Date.now();
  console.log(`[crawler] ═══ Cycle ${_stats.cyclesCompleted + 1} starting ═══`);

  // Check if face API is healthy
  try {
    const health = await fetch(`${FACE_API}/health`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) {
      console.log("[crawler] Face API not healthy, skipping cycle");
      return;
    }
  } catch {
    console.log("[crawler] Face API unreachable, skipping cycle");
    return;
  }

  // Run sources in sequence (to control resource usage)
  const results = {};

  // Wikipedia — biggest source, always run
  results.wikipedia = await crawlWikipedia();
  if (_stopRequested) return;

  // Commons — deep photos for known people
  results.commons = await crawlCommons();
  if (_stopRequested) return;

  // Reddit — diverse face photos
  results.reddit = await crawlReddit();
  if (_stopRequested) return;

  // News — public figures in current events
  results.news = await crawlNews();
  if (_stopRequested) return;

  // Named people — deep crawl for discovered names
  results.named = await crawlNamedPeople();

  // Update stats
  const cycleIndexed = Object.values(results).reduce((s, r) => s + (r?.indexed || 0), 0);
  const cycleProcessed = Object.values(results).reduce((s, r) => s + (r?.processed || 0), 0);
  _stats.cyclesCompleted++;
  _stats.totalIndexed += cycleIndexed;
  _stats.totalProcessed += cycleProcessed;
  _stats.lastCycleAt = new Date().toISOString();

  const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);

  // Get DB size
  let dbSize = "?";
  try {
    const statsRes = await fetch(`${FACE_API}/stats`, { signal: AbortSignal.timeout(5000) });
    if (statsRes.ok) {
      const s = await statsRes.json();
      dbSize = s.points_count;
    }
  } catch {}

  console.log(`[crawler] ═══ Cycle ${_stats.cyclesCompleted} complete: ${cycleIndexed}/${cycleProcessed} indexed in ${elapsed}s | DB: ${dbSize} faces | Queue: ${getState().named.queue?.length || 0} names ═══`);

  // Log per-source breakdown
  for (const [name, r] of Object.entries(results)) {
    if (r && (r.indexed > 0 || r.processed > 0)) {
      console.log(`[crawler]   ${name}: ${r.indexed}/${r.processed}`);
    }
  }
}

// Start the background service
function start() {
  if (_running) {
    console.log("[crawler] Already running");
    return;
  }

  _running = true;
  _stopRequested = false;
  _stats.startedAt = new Date().toISOString();
  console.log("[crawler] ══════════════════════════════════════");
  console.log("[crawler] 24/7 Face Crawler Service STARTED");
  console.log(`[crawler] Cycle interval: ${CYCLE_INTERVAL / 1000}s`);
  console.log("[crawler] ══════════════════════════════════════");

  // Run first cycle immediately
  runCycle().then(() => {
    if (!_stopRequested) {
      _cycleTimer = setInterval(() => {
        runCycle().catch(err => {
          console.error("[crawler] Cycle error:", err.message);
          _stats.errors++;
        });
      }, CYCLE_INTERVAL);
    }
  }).catch(err => {
    console.error("[crawler] First cycle error:", err.message);
    _stats.errors++;
  });
}

// Stop the background service
function stop() {
  if (!_running) return;
  _stopRequested = true;
  if (_cycleTimer) {
    clearInterval(_cycleTimer);
    _cycleTimer = null;
  }
  _running = false;
  console.log("[crawler] Service STOPPED");
}

// Get service status
function getStatus() {
  return {
    running: _running,
    stats: _stats,
    crawlState: getState(),
    nameQueueSize: getState().named?.queue?.length || 0,
  };
}

// Manual crawl (one-time, for API endpoint)
async function runManualCycle(opts = {}) {
  const results = {};
  if (opts.wikipedia !== false) results.wikipedia = await crawlWikipedia();
  if (opts.commons !== false) results.commons = await crawlCommons();
  if (opts.reddit !== false) results.reddit = await crawlReddit();
  if (opts.news !== false) results.news = await crawlNews();
  if (opts.named !== false) results.named = await crawlNamedPeople();

  // Inject names into queue if provided
  if (opts.names?.length) {
    for (const name of opts.names) _addToNameQueue(name);
    saveState();
  }

  const totalIndexed = Object.values(results).reduce((s, r) => s + (r?.indexed || 0), 0);
  const totalProcessed = Object.values(results).reduce((s, r) => s + (r?.processed || 0), 0);

  let dbStats = null;
  try {
    const statsRes = await fetch(`${FACE_API}/stats`, { signal: AbortSignal.timeout(5000) });
    if (statsRes.ok) dbStats = await statsRes.json();
  } catch {}

  return { results, totalIndexed, totalProcessed, dbStats, crawlState: getState() };
}

// Add names to the crawl queue
function addNames(names) {
  for (const name of names) _addToNameQueue(name);
  saveState();
  return { queued: names.length, queueSize: getState().named.queue.length };
}

module.exports = {
  start,
  stop,
  getStatus,
  runManualCycle,
  addNames,
};
