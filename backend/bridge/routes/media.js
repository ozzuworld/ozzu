"use strict";

// /media/* — Ozzu broker lane (dir_1790443814736, P2: Ozzu-native broker client)
//
// Fully self-hosted resolver + broker + markers (research §9.2, KK data-sovereignty
// constraint — zero media bytes to third parties):
//   resolver: Prowlarr search (bridge-01, indexers 1337x/eztv/TPB/YTS via flaresolverr)
//             → ranked magnets → infoHash (magnet btih, or sha1 of a .torrent's info dict)
//   broker:   stremio-server (bridge-01 :11470) — torrent→HTTP with Range seek.
//             stats.json is the file-listing API BUT returns null until the engine
//             loads the torrent: kick the stream endpoint first, then poll (proven
//             2026-09-26 on Zero Day S01 pack c436a017…).
//   markers:  media_markers in ozzu-postgres — resume positions are PERMANENT, so
//             playback survives cache eviction (stremio refetches piece-deadline-
//             first from the offset when the client seeks).
//
// Media BYTES never traverse this bridge — clients stream direct from bridge-01
// (LAN http://192.168.1.9:11470, WG http://10.9.0.5:11470). This module only
// moves search JSON, resolve metadata, and marker rows.
//
// env (backend/.env):
//   PROWLARR_API_KEY   required for /media/search
//   PROWLARR_URL       default http://10.9.0.5:9696
//   STREMIO_URL        default http://10.9.0.5:11470
//   MEDIA_LAN_HOST     default 192.168.1.9  (stream URLs handed to LAN clients)
//   MEDIA_WG_HOST      default 10.9.0.5     (stream URLs handed to WG clients)

const crypto = require("crypto");

const PROWLARR_URL = (process.env.PROWLARR_URL || "http://10.9.0.5:9696").replace(/\/+$/, "");
const STREMIO_URL = (process.env.STREMIO_URL || "http://10.9.0.5:11470").replace(/\/+$/, "");
const MEDIA_LAN_HOST = process.env.MEDIA_LAN_HOST || "192.168.1.9";
const MEDIA_WG_HOST = process.env.MEDIA_WG_HOST || "10.9.0.5";

// Prowlarr torznab categories: 2000 = Movies, 5000 = TV.
const CATS = { movie: "2000", show: "5000" };

// ── small utils ──────────────────────────────────────────────────────────────

function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

const BANNED_RE = /\b(remux|bdmv|bd-?remux|br-?disk|bdrip-full|2160p|uhd|4k)\b/i;
const BAD_SRC_RE = /\b(cam|hd-?cam|camrip|ts|telesync|hd-?ts|scr|screener|workprint)\b/i;
const VIDEO_EXT_RE = /\.(mkv|mp4|avi|m4v|mov|webm)$/i;

function base32ToHex(b32) {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, out = "";
  for (const ch of b32.toUpperCase()) {
    const idx = alpha.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out += ((value >>> (bits - 8)) & 0xff).toString(16).padStart(2, "0");
      bits -= 8;
    }
  }
  return out.length === 40 ? out : null;
}

/** infoHash from a magnet URI (hex-40 or base32-32 btih). */
function magnetToInfoHash(magnet) {
  if (typeof magnet !== "string") return null;
  const m = magnet.match(/btih:([a-fA-F0-9]{40}|[A-Za-z2-7]{32})/);
  if (!m) return null;
  const v = m[1];
  return v.length === 40 ? v.toLowerCase() : base32ToHex(v);
}

// Minimal bencode walker — returns the exclusive end offset of the value at `i`.
function bencodeEnd(buf, i) {
  const t = buf[i];
  if (t === 0x64 || t === 0x6c) { // 'd' or 'l'
    i += 1;
    while (i < buf.length && buf[i] !== 0x65) i = bencodeEnd(buf, i); // 'e'
    return i + 1;
  }
  if (t === 0x69) { // 'i'
    const e = buf.indexOf(0x65, i);
    return e < 0 ? buf.length : e + 1;
  }
  if (t >= 0x30 && t <= 0x39) { // '<len>:'
    const colon = buf.indexOf(0x3a, i);
    if (colon < 0) return buf.length;
    const len = parseInt(buf.slice(i, colon).toString("ascii"), 10);
    return colon + 1 + len;
  }
  return i + 1; // unknown — crawl
}

/** infoHash (hex-40) from raw .torrent bytes: sha1 of the bencoded info dict. */
function infoHashFromTorrent(buf) {
  const key = Buffer.from("4:info");
  let from = 0;
  for (;;) {
    const at = buf.indexOf(key, from);
    if (at < 0) return null;
    const valStart = at + key.length;
    const valEnd = bencodeEnd(buf, valStart);
    if (valEnd > valStart) {
      return crypto.createHash("sha1").update(buf.slice(valStart, valEnd)).digest("hex");
    }
    from = at + 1;
  }
}

// ── resolver: Prowlarr → magnets → ranked infoHashes ────────────────────────

async function prowlarrSearch(q, type) {
  const key = process.env.PROWLARR_API_KEY;
  if (!key) {
    const err = new Error("PROWLARR_API_KEY not configured on the bridge");
    err.code = 503;
    throw err;
  }
  const cats = CATS[type] || CATS.movie;
  const url = `${PROWLARR_URL}/api/v1/search?query=${encodeURIComponent(q)}&categories=${cats}&limit=100`;
  // flaresolverr-backed indexers can be slow (cold browser ~140s) — long ceiling
  const res = await fetchWithTimeout(url, { headers: { "X-Api-Key": key, Accept: "application/json" } }, 120000);
  if (!res.ok) {
    const err = new Error(`prowlarr search HTTP ${res.status}`);
    err.code = 502;
    throw err;
  }
  return res.json();
}

/** Resolve a Prowlarr result to an infoHash.
 * ⚠️ Prowlarr quirk (verified 2026-09-26): `magnetUrl` is NOT a magnet — it's
 * Prowlarr's own proxied download URL (http://localhost:9696/N/download?apikey=…),
 * unreachable from this bridge AND unparseable as a magnet. The REAL magnet lives
 * in `guid`. Order: guid → magnetUrl (in case some version puts a magnet there)
 * → fetch the proxy downloadUrl (localhost rewritten to the WG host, with the
 * API key) which may 302 to a magnet or serve raw .torrent bytes. */
async function resultToInfoHash(r) {
  const fromMagnet = magnetToInfoHash(r.guid || "") || magnetToInfoHash(r.magnetUrl || "");
  if (fromMagnet) return fromMagnet;
  const dl = (r.downloadUrl || r.magnetUrl || "").replace(/^http:\/\/localhost(:\d+)?/, PROWLARR_URL);
  if (!dl) return null;
  try {
    const headers = { Accept: "*/*" };
    if (process.env.PROWLARR_API_KEY && dl.includes("/download?")) headers["X-Api-Key"] = process.env.PROWLARR_API_KEY;
    const res = await fetchWithTimeout(dl, { headers }, 20000);
    if (!res.ok) return null;
    const body = Buffer.from(await res.arrayBuffer());
    const asText = body.slice(0, 200).toString("utf8");
    if (asText.startsWith("magnet:")) return magnetToInfoHash(asText.split("\n")[0]);
    if (body[0] === 0x64 || asText.startsWith("d8:announce") || asText.startsWith("d10:magnet-uri")) {
      return infoHashFromTorrent(body);
    }
    return null;
  } catch {
    return null;
  }
}

function guessQuality(title) {
  if (/\b2160p|uhd\b/i.test(title)) return "2160p";
  if (/\b1080p\b/i.test(title)) return "1080p";
  if (/\b720p\b/i.test(title)) return "720p";
  return "sd";
}

function scoreResult(r, allow4k) {
  const title = r.title || "";
  // Remux/BR-DISK banned (50-60GB footgun, 2026-06-15); 4k only on explicit request
  if (BANNED_RE.test(title) && !(allow4k && /2160p|uhd|4k/i.test(title))) return null;
  let score = Math.min(r.seeders || 0, 200) * 2; // seeders dominate (indexer counts inflated — cap)
  if (BAD_SRC_RE.test(title)) score -= 500; // cams/telesyncs never worth it
  if (/\bweb-?dl\b/i.test(title)) score += 40;
  else if (/\bweb-?rip\b/i.test(title)) score += 30;
  else if (/\bbluray\b/i.test(title)) score += 25;
  else if (/\bhdtv\b/i.test(title)) score += 15;
  if (/\bx265|hevc\b/i.test(title)) score += 5; // same quality, fewer bytes
  const gb = (r.size || 0) / 1e9;
  if (gb > 0.4 && gb < 12) score += 20; // sane window for the rotation library
  if (gb >= 25) score -= 100;
  if (r.seeders > 0) score += 10; // alive beats dead regardless of count
  return score;
}

// ── broker: stremio-server file listing + stream URLs ───────────────────────

/** Kick the engine (the stream endpoint loads the torrent; stats.json alone does
 * NOT) then poll stats.json until metadata resolves.
 * Returns {name, files:[{idx,path,size?}], loading?}. */
async function stremioFiles(infoHash, { timeoutMs = 90000 } = {}) {
  // Kick: a short ranged GET on file 0 starts the swarm/engine. Abort fast — we
  // only need the side effect, not the bytes.
  try {
    await fetchWithTimeout(`${STREMIO_URL}/${infoHash}/0`, { headers: { Range: "bytes=0-0" } }, 2500);
  } catch { /* abort/timeout is the expected outcome */ }
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(`${STREMIO_URL}/${infoHash}/0/stats.json`, {}, 10000);
      if (res.ok) {
        const stats = await res.json();
        if (stats && Array.isArray(stats.files) && stats.files.length) {
          return {
            name: stats.name || null,
            files: stats.files.map((f, idx) => ({
              idx,
              path: f.path || f.name || `file-${idx}`,
              size: f.size ?? f.length ?? null,
            })),
          };
        }
        last = stats;
      }
    } catch { /* engine still loading */ }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return { name: last?.name || null, files: [], loading: true };
}

/** Pick the fileIdx to play. Episode: SxxEyy match on path. Movie: largest video file. */
function pickFile(files, { season, episode, movie } = {}) {
  if (!files.length) return null;
  if (!movie && (episode != null || season != null)) {
    const sNum = Number(season ?? 1);
    const eNum = episode != null ? Number(episode) : null;
    const re = eNum != null
      ? new RegExp(`s0?${sNum}[ ._\\-]?e0?${eNum}(?![0-9])`, "i")
      : new RegExp(`s0?${sNum}[ ._\\-]?e[0-9]{1,2}`, "i");
    const hit = files.find((f) => re.test(f.path));
    if (hit) return hit;
    // season-folder fallback: any video file under an Sxx dir
    const dirRe = new RegExp(`[/\\\\. _\\-]s0?${sNum}[/\\\\. _\\-]`, "i");
    const inSeason = files.filter((f) => dirRe.test(f.path) && VIDEO_EXT_RE.test(f.path));
    if (inSeason.length) return inSeason[0];
  }
  const videos = files.filter((f) => VIDEO_EXT_RE.test(f.path));
  const pool = videos.length ? videos : files;
  if (pool.length === 1) return pool[0];
  const sized = pool.filter((f) => typeof f.size === "number");
  if (sized.length) return sized.reduce((a, b) => (b.size > a.size ? b : a));
  return pool[0]; // no sizes yet — first video-ish file
}

function streamUrls(infoHash, fileIdx) {
  const path = `/${infoHash}/${fileIdx}`;
  return {
    lan: `http://${MEDIA_LAN_HOST}:11470${path}`,
    wg: `http://${MEDIA_WG_HOST}:11470${path}`,
    relative: path,
  };
}

// ── markers: media_markers (resume survives eviction) ───────────────────────

let _ensured = false;
async function ensureSchema(db) {
  if (_ensured) return;
  await db.query(`CREATE TABLE IF NOT EXISTS media_markers (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'kk',
    kind TEXT NOT NULL,                -- 'movie' | 'episode'
    title TEXT NOT NULL,               -- display title (movie or series)
    tmdb_id INTEGER,
    season INTEGER,
    episode INTEGER,
    info_hash TEXT NOT NULL,
    file_idx INTEGER NOT NULL DEFAULT 0,
    file_name TEXT,
    position_seconds INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER,
    watched BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // Upsert key: one marker per (user, kind, title, season, episode). Expression
  // index so ON CONFLICT can target it; season/episode default -1 for movies.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS media_markers_uq
    ON media_markers (user_id, kind, lower(title), COALESCE(season, -1), COALESCE(episode, -1))`);
  await db.query(`CREATE INDEX IF NOT EXISTS media_markers_updated ON media_markers (updated_at DESC)`);
  _ensured = true;
}

const MARKER_COLS = "id, user_id, kind, title, tmdb_id, season, episode, info_hash, file_idx, file_name, position_seconds, duration_seconds, watched, created_at, updated_at";

// ── routes ───────────────────────────────────────────────────────────────────

module.exports = function mediaRoutes(ctx) {
  const { sendJSON, parseBody, db, log } = ctx;

  return async function handleMediaRoutes(req, res, pathname, url) {
    if (!pathname.startsWith("/media")) return false;

    // GET /media/health — resolver/broker reachability from the bridge
    if (req.method === "GET" && pathname === "/media/health") {
      const out = { prowlarr: false, stremio: false, prowlarr_key: !!process.env.PROWLARR_API_KEY };
      try {
        const r = await fetchWithTimeout(`${PROWLARR_URL}/api/v1/health`, {
          headers: { "X-Api-Key": process.env.PROWLARR_API_KEY || "", Accept: "application/json" },
        }, 6000);
        out.prowlarr = r.ok;
      } catch { /* unreachable */ }
      try {
        const r = await fetchWithTimeout(`${STREMIO_URL}/`, {}, 6000);
        out.stremio = r.status > 0; // 307 to the web UI = alive
      } catch { /* unreachable */ }
      sendJSON(res, 200, out);
      return true;
    }

    // GET /media/search?q=&type=movie|show&limit=&allow4k=1 — resolver
    if (req.method === "GET" && pathname === "/media/search") {
      const q = (url.searchParams.get("q") || "").trim();
      const type = url.searchParams.get("type") === "show" ? "show" : "movie";
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "15", 10) || 15, 50);
      const allow4k = url.searchParams.get("allow4k") === "1";
      if (!q) { sendJSON(res, 400, { error: "q is required" }); return true; }
      try {
        const raw = await prowlarrSearch(q, type);
        const all = Array.isArray(raw) ? raw : [];
        const seen = new Set();
        const results = [];
        // Resolve hashes with bounded concurrency (downloadUrl fetches can be slow)
        const queue = [...all];
        const workers = Array.from({ length: 6 }, async () => {
          while (queue.length && results.length < limit * 3) {
            const r = queue.shift();
            const score = scoreResult(r, allow4k);
            if (score == null) continue;
            const infoHash = await resultToInfoHash(r);
            if (!infoHash || seen.has(infoHash)) continue;
            seen.add(infoHash);
            results.push({
              title: r.title,
              infoHash,
              magnet: r.magnetUrl || null,
              seeders: r.seeders ?? null,
              leechers: r.leechers ?? null,
              size: r.size ?? null,
              quality: guessQuality(r.title || ""),
              indexer: r.indexer || null,
              tmdbId: r.tmdbId ?? null,
              age: r.age ?? null,
              score,
            });
          }
        });
        await Promise.all(workers);
        results.sort((a, b) => b.score - a.score);
        sendJSON(res, 200, { query: q, type, count: results.length, results: results.slice(0, limit) });
        log?.info?.(`[media] search "${q}" (${type}) → ${results.length} resolvable of ${all.length}`);
      } catch (err) {
        sendJSON(res, err.code || 500, { error: err.message });
      }
      return true;
    }

    // GET /media/files?infoHash=&wait=0|1 — broker file listing (kick + poll)
    if (req.method === "GET" && pathname === "/media/files") {
      const infoHash = (url.searchParams.get("infoHash") || "").toLowerCase();
      if (!/^[a-f0-9]{40}$/.test(infoHash)) { sendJSON(res, 400, { error: "infoHash must be 40-hex" }); return true; }
      try {
        const timeoutMs = url.searchParams.get("wait") === "0" ? 8000 : 90000;
        const out = await stremioFiles(infoHash, { timeoutMs });
        sendJSON(res, 200, { infoHash, ...out });
      } catch (err) {
        sendJSON(res, 502, { error: `stremio: ${err.message}` });
      }
      return true;
    }

    // POST /media/resolve {infoHash, season?, episode?, movie?} — pick file, return stream URLs
    if (req.method === "POST" && pathname === "/media/resolve") {
      try {
        const body = await parseBody(req);
        const infoHash = String(body.infoHash || "").toLowerCase();
        if (!/^[a-f0-9]{40}$/.test(infoHash)) { sendJSON(res, 400, { error: "infoHash must be 40-hex" }); return true; }
        const listed = await stremioFiles(infoHash);
        const file = pickFile(listed.files, {
          season: body.season != null ? Number(body.season) : undefined,
          episode: body.episode != null ? Number(body.episode) : undefined,
          movie: !!body.movie,
        });
        if (!file) {
          sendJSON(res, 202, { infoHash, loading: true, name: listed.name, error: "torrent metadata still resolving — retry shortly" });
          return true;
        }
        sendJSON(res, 200, {
          infoHash,
          name: listed.name,
          file,
          stream: streamUrls(infoHash, file.idx),
          fileCount: listed.files.length,
        });
        log?.info?.(`[media] resolve ${infoHash} → file ${file.idx} (${file.path})`);
      } catch (err) {
        sendJSON(res, 502, { error: `resolve: ${err.message}` });
      }
      return true;
    }

    // GET /media/broker/stats?infoHash= — passthrough (swarm/piece state)
    if (req.method === "GET" && pathname === "/media/broker/stats") {
      const infoHash = (url.searchParams.get("infoHash") || "").toLowerCase();
      if (!/^[a-f0-9]{40}$/.test(infoHash)) { sendJSON(res, 400, { error: "infoHash must be 40-hex" }); return true; }
      try {
        const r = await fetchWithTimeout(`${STREMIO_URL}/${infoHash}/0/stats.json`, {}, 10000);
        sendJSON(res, r.ok ? 200 : 502, await r.json().catch(() => ({})));
      } catch (err) {
        sendJSON(res, 502, { error: `stremio: ${err.message}` });
      }
      return true;
    }

    // POST /media/broker/remove {infoHash} — client delete-after-watched hook
    if (req.method === "POST" && pathname === "/media/broker/remove") {
      try {
        const body = await parseBody(req);
        const infoHash = String(body.infoHash || "").toLowerCase();
        if (!/^[a-f0-9]{40}$/.test(infoHash)) { sendJSON(res, 400, { error: "infoHash must be 40-hex" }); return true; }
        const r = await fetchWithTimeout(`${STREMIO_URL}/${infoHash}/remove`, {}, 10000);
        sendJSON(res, r.ok ? 200 : 502, { ok: r.ok, infoHash });
        log?.info?.(`[media] broker remove ${infoHash} → ${r.status}`);
      } catch (err) {
        sendJSON(res, 502, { error: `stremio: ${err.message}` });
      }
      return true;
    }

    // PUT /media/markers — upsert a resume marker (the permanent half of resume)
    if (req.method === "PUT" && pathname === "/media/markers") {
      try {
        await ensureSchema(db);
        const b = await parseBody(req);
        const kind = b.kind === "episode" ? "episode" : "movie";
        const title = String(b.title || "").trim();
        const infoHash = String(b.infoHash || "").toLowerCase();
        if (!title) { sendJSON(res, 400, { error: "title is required" }); return true; }
        if (!/^[a-f0-9]{40}$/.test(infoHash)) { sendJSON(res, 400, { error: "infoHash must be 40-hex" }); return true; }
        const params = [
          b.userId || "kk", kind, title,
          b.tmdbId != null ? Number(b.tmdbId) : null,
          b.season != null ? Number(b.season) : null,
          b.episode != null ? Number(b.episode) : null,
          infoHash,
          b.fileIdx != null ? Number(b.fileIdx) : 0,
          b.fileName != null ? String(b.fileName) : null,
          b.positionSeconds != null ? Math.max(0, Math.floor(Number(b.positionSeconds))) : 0,
          b.durationSeconds != null ? Math.floor(Number(b.durationSeconds)) : null,
          !!b.watched,
        ];
        const { rows } = await db.query(
          `INSERT INTO media_markers (user_id, kind, title, tmdb_id, season, episode, info_hash, file_idx, file_name, position_seconds, duration_seconds, watched)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (user_id, kind, lower(title), COALESCE(season, -1), COALESCE(episode, -1))
           DO UPDATE SET tmdb_id = COALESCE(EXCLUDED.tmdb_id, media_markers.tmdb_id),
                         info_hash = EXCLUDED.info_hash,
                         file_idx = EXCLUDED.file_idx,
                         file_name = COALESCE(EXCLUDED.file_name, media_markers.file_name),
                         position_seconds = EXCLUDED.position_seconds,
                         duration_seconds = COALESCE(EXCLUDED.duration_seconds, media_markers.duration_seconds),
                         watched = EXCLUDED.watched,
                         updated_at = now()
           RETURNING ${MARKER_COLS}`,
          params
        );
        sendJSON(res, 200, rows[0]);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /media/markers?userId=&continue=1 — continue-watching rail / full list
    if (req.method === "GET" && pathname === "/media/markers") {
      try {
        await ensureSchema(db);
        const userId = url.searchParams.get("userId") || "kk";
        const cont = url.searchParams.get("continue") === "1";
        const where = cont
          ? "WHERE user_id = $1 AND watched = FALSE AND position_seconds >= 30"
          : "WHERE user_id = $1";
        const { rows } = await db.query(
          `SELECT ${MARKER_COLS} FROM media_markers ${where} ORDER BY updated_at DESC LIMIT 200`,
          [userId]
        );
        sendJSON(res, 200, { count: rows.length, markers: rows });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // DELETE /media/markers?id=N — forget a marker
    if (req.method === "DELETE" && pathname === "/media/markers") {
      try {
        await ensureSchema(db);
        const id = parseInt(url.searchParams.get("id") || "", 10);
        if (!Number.isFinite(id)) { sendJSON(res, 400, { error: "id is required" }); return true; }
        const { rowCount } = await db.query("DELETE FROM media_markers WHERE id = $1", [id]);
        sendJSON(res, 200, { ok: rowCount > 0, id });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    return false; // unknown /media path — let the 404 tail handle it
  };
};
