"use strict";

// /media/discover/* — Seerr discovery + request proxy (dir_1790443814736)
//
// KK's architecture (2026-09-27): "jellyseerr should be the actual one providing
// everything and jellyfin will be the one of the actual playback." Seerr (the
// maintained Jellyseerr fork, v3.4.1 on bridge-01 :5055) is the TMDB-powered
// catalog brain: trending/search/details/availability + requests that flow
// Sonarr/Radarr → Prowlarr/qbit → disk → Jellyfin import. Jellyfin stays the
// playback engine (its items are reachable from Seerr's jellyfinMediaId).
//
// The Seerr API key stays server-side; app clients authenticate with the normal
// bridge key (public path) or keyless LAN/WG trust — same contract as /media/*.
//
// env:
//   SEERR_URL       default http://127.0.0.1:5055 (bridge container is network_mode host ON bridge-01)
//   SEERR_API_KEY   required (from /srv/media-stack/config/jellyseerr/settings.json → .main.apiKey)
//
// Seerr 3.4 quirks (all verified live 2026-09-27):
//   - strict zod query validation: unknown params (take/skip on /discover/*) → 400. Only send params the endpoint documents.
//   - POST /request body is FLAT: {mediaId, mediaType, seasons: number[] | "all"}.
//     The Jellyseerr-2.x shape tv:{seasons:[{seasonNumber}]} → 500 ("Cannot read properties of undefined (reading 'filter')").
//   - arr servers need syncEnabled:true or availability scanners skip them (fixed via PUT /settings/{sonarr,radarr}/{id}).
//   - MediaStatus: 1 unknown, 2 pending, 3 processing, 4 partially available, 5 AVAILABLE.
//     MediaRequestStatus: 1 pending, 2 approved, 3 declined, 4 media available, 5 failed.

const SEERR_URL = (process.env.SEERR_URL || "http://127.0.0.1:5055").replace(/\/+$/, "");

// ── utils ────────────────────────────────────────────────────────────────────

function fetchWithTimeout(url, opts = {}, ms = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function seerrHeaders() {
  return {
    "X-Api-Key": process.env.SEERR_API_KEY || "",
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function seerrGet(path, ms = 12000) {
  const res = await fetchWithTimeout(`${SEERR_URL}/api/v1${path}`, { headers: seerrHeaders() }, ms);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.messages?.[0] || data?.error || `Seerr HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Normalize Seerr's mediaInfo (field names drift between list/detail serializers). */
function availabilityOf(mediaInfo) {
  if (!mediaInfo) return null;
  const status = mediaInfo.status ?? mediaInfo.mediaStatus ?? null;
  const jellyfinId = mediaInfo.jellyfinMediaId ?? null;
  const requests = mediaInfo.mediaRequests || mediaInfo.requests || [];
  return { status, jellyfinId, requested: requests.length > 0 };
}

/** Slim a TMDB-ish list result to what the TV app renders (posters, meta, availability). */
function slimResult(r) {
  if (!r || typeof r !== "object") return null;
  return {
    tmdbId: r.id,
    mediaType: r.mediaType || (r.title ? "movie" : "tv"),
    title: r.title || r.name || "",
    overview: r.overview || "",
    posterPath: r.posterPath || null,
    backdropPath: r.backdropPath || null,
    voteAverage: typeof r.voteAverage === "number" ? r.voteAverage : null,
    releaseDate: r.releaseDate || r.firstAirDate || null,
    availability: availabilityOf(r.mediaInfo),
  };
}

function slimList(results) {
  return (results || []).map(slimResult).filter(Boolean);
}

function slimCast(credits, n = 15) {
  return ((credits && credits.cast) || []).slice(0, n).map((c) => ({
    name: c.name || "",
    character: c.character || "",
    profilePath: c.profilePath || null,
  }));
}

function slimGenres(d) {
  return (d.genres || []).map((g) => ({ id: g.id, name: g.name }));
}

// ── Watch orchestration (dir_1790443814736, KK 2026-10-02: "click watch →
// everything happens behind → jellyfin plays") ────────────────────────────────
// The Watch button needs THREE truths in one call: Seerr availability (is it
// playable now?), Seerr request state (is it in the pipeline?), and the REAL
// download progress from Sonarr/Radarr's queue (Seerr only knows coarse media
// status). When the arrs report "imported" but Seerr/Jellyfin haven't noticed,
// the bridge nudges both (JF library refresh + Seerr jellyfin scan) so the app's
// poll loop sees a playable jellyfinId within seconds instead of ≤5 minutes.
//
// env (optional — progress degrades to availability-only when absent):
//   SONARR_URL/RADARR_URL/JELLYFIN_URL  default http://127.0.0.1:{8989,7878,8096}
//   SONARR_API_KEY / RADARR_API_KEY     from /srv/media-stack/config/*/config.xml
//   JELLYFIN_API_KEY                    admin API key (/etc/ozzu/jellyfin-token)

const SONARR_URL = (process.env.SONARR_URL || "http://127.0.0.1:8989").replace(/\/+$/, "");
const RADARR_URL = (process.env.RADARR_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
const JELLYFIN_URL = (process.env.JELLYFIN_URL || "http://127.0.0.1:8096").replace(/\/+$/, "");

async function arrGet(base, key, path, ms = 8000) {
  const res = await fetchWithTimeout(`${base}/api/v3${path}`, {
    headers: { "X-Api-Key": key, Accept: "application/json" },
  }, ms);
  if (!res.ok) throw new Error(`arr HTTP ${res.status}`);
  return res.json();
}

/** Radarr state for a TMDB movie id → {stage, percent, …} or null (not in Radarr). */
async function radarrProgress(tmdbId) {
  const key = process.env.RADARR_API_KEY;
  if (!key) return null;
  const lookup = await arrGet(RADARR_URL, key, `/movie/lookup?term=tmdb:${tmdbId}`);
  const movie = (Array.isArray(lookup) ? lookup : []).find((m) => m.tmdbId === Number(tmdbId));
  if (!movie) return null;
  let row = null;
  try {
    const q = await arrGet(RADARR_URL, key, "/queue?page=1&pageSize=100");
    row = (q.records || []).find((r) => r.movieId === movie.id) || null;
  } catch { /* queue hiccup — fall through to static state */ }
  if (row) {
    const size = row.size || 0;
    const left = row.sizeleft ?? size;
    return {
      stage: "downloading",
      percent: size > 0 ? Math.round(((size - left) / size) * 100) : 0,
      sizeLeft: left,
      size,
      eta: row.estimatedCompletionTime || null,
      statusText: row.status || null,
      title: row.title || null,
    };
  }
  if (movie.hasFile) return { stage: "imported", percent: 100 };
  if (movie.status && movie.status !== "released") return { stage: "unreleased", percent: 0 };
  return { stage: movie.monitored ? "wanted" : "unmonitored", percent: 0 };
}

/** Sonarr state for a TVDB series id → aggregate queue + episode counts, or null. */
async function sonarrProgress(tvdbId) {
  const key = process.env.SONARR_API_KEY;
  if (!key || !tvdbId) return null;
  const lookup = await arrGet(SONARR_URL, key, `/series/lookup?term=tvdb:${tvdbId}`);
  const series = (Array.isArray(lookup) ? lookup : []).find((s) => s.tvdbId === Number(tvdbId));
  if (!series) return null;
  let queue = [];
  try {
    const q = await arrGet(SONARR_URL, key, `/queue?page=1&pageSize=200&seriesId=${series.id}&includeSeries=false&includeEpisode=false`);
    queue = q.records || [];
  } catch { /* queue hiccup — episode counts below still work */ }
  let have = 0;
  let aired = 0;
  try {
    const eps = await arrGet(SONARR_URL, key, `/episode?seriesId=${series.id}`, 10000);
    const rows = Array.isArray(eps) ? eps : [];
    const now = Date.now();
    for (const ep of rows) {
      if ((ep.seasonNumber ?? 0) < 1) continue; // specials don't count
      if (ep.hasFile) have += 1;
      if (ep.airDateUtc && new Date(ep.airDateUtc).getTime() <= now) aired += 1;
    }
  } catch { /* episode list optional */ }
  if (queue.length) {
    const size = queue.reduce((a, r) => a + (r.size || 0), 0);
    const left = queue.reduce((a, r) => a + (r.sizeleft ?? r.size ?? 0), 0);
    return {
      stage: "downloading",
      percent: size > 0 ? Math.round(((size - left) / size) * 100) : 0,
      sizeLeft: left,
      size,
      eta: queue.map((r) => r.estimatedCompletionTime).filter(Boolean).sort()[0] || null,
      queued: queue.length,
      have,
      aired,
      statusText: queue[0]?.status || null,
      title: queue[0]?.title || null,
    };
  }
  if (aired > 0 && have >= aired) return { stage: "imported", percent: 100, have, aired };
  if (have > 0) return { stage: "partial", percent: aired ? Math.round((have / aired) * 100) : 0, have, aired };
  return { stage: series.monitored ? "wanted" : "unmonitored", percent: 0, have, aired };
}

// Rate-limited (90s per title) double nudge: Jellyfin library refresh + Seerr's
// jellyfin-recently-added scan. Fire-and-forget; the poll loop re-checks state.
const refreshNudges = new Map();
function maybeNudgeRefresh(tmdbId, mediaType, logFn) {
  const k = `${mediaType}:${tmdbId}`;
  const now = Date.now();
  if (now - (refreshNudges.get(k) || 0) < 90000) return false;
  refreshNudges.set(k, now);
  const jfKey = process.env.JELLYFIN_API_KEY;
  if (jfKey) {
    fetchWithTimeout(`${JELLYFIN_URL}/Library/Refresh`, {
      method: "POST",
      headers: { Authorization: `MediaBrowser Token=${jfKey}` }, // JF12: only this header works
    }, 6000).catch(() => {});
  }
  fetchWithTimeout(`${SEERR_URL}/api/v1/settings/jobs/jellyfin-recently-added-scan/run`, {
    method: "POST",
    headers: seerrHeaders(),
  }, 6000).catch(() => {});
  if (logFn) logFn("info", `discover watch: nudged JF refresh + Seerr scan for ${mediaType} ${tmdbId}`);
  return true;
}

// ── routes ───────────────────────────────────────────────────────────────────

module.exports = function discoverRoutes(ctx) {
  const { sendJSON, parseBody, log } = ctx;

  // ctx.log is a REGISTRY of named loggers (log.bridge.info(…), log.ws.warn(…)…),
  // not a callable — the original log("info", …) calls here threw "log is not a
  // function" on the 201 path (never exercised until the Watch lane, 2026-10-02).
  const dlog = (level, msg) => {
    const l = log && log.bridge;
    if (l && typeof l[level] === "function") l[level](`[discover] ${msg}`);
  };

  return async function handleDiscoverRoutes(req, res, pathname, url) {
    if (!pathname.startsWith("/media/discover")) return false;

    if (!process.env.SEERR_API_KEY) {
      sendJSON(res, 503, { error: "Seerr API key not configured on the bridge (SEERR_API_KEY)" }, req);
      return true;
    }

    const route = pathname.replace(/^\/media\/discover\/?/, "");

    try {
      // GET /media/discover/health — Seerr reachability + version
      if (req.method === "GET" && route === "health") {
        try {
          const st = await seerrGet("/status", 6000);
          sendJSON(res, 200, { ok: true, version: st.version || null }, req);
        } catch (e) {
          sendJSON(res, 200, { ok: false, error: e.message }, req);
        }
        return true;
      }

      // GET /media/discover/trending?mediaType=movie|tv&page=N
      if (req.method === "GET" && route === "trending") {
        const mediaType = url.searchParams.get("mediaType") || "";
        const page = url.searchParams.get("page") || "1";
        const d = await seerrGet(`/discover/trending${mediaType ? `/${mediaType}` : ""}?page=${page}`);
        sendJSON(res, 200, { page: d.page, totalPages: d.totalPages, results: slimList(d.results) }, req);
        return true;
      }

      // GET /media/discover/movies?page=N   — popular movies
      if (req.method === "GET" && route === "movies") {
        const page = url.searchParams.get("page") || "1";
        const d = await seerrGet(`/discover/movies?page=${page}`);
        sendJSON(res, 200, { page: d.page, totalPages: d.totalPages, results: slimList(d.results) }, req);
        return true;
      }

      // GET /media/discover/tv?page=N       — popular series
      if (req.method === "GET" && route === "tv") {
        const page = url.searchParams.get("page") || "1";
        const d = await seerrGet(`/discover/tv?page=${page}`);
        sendJSON(res, 200, { page: d.page, totalPages: d.totalPages, results: slimList(d.results) }, req);
        return true;
      }

      // GET /media/discover/search?q=&page= — mixed movie/tv results (client filters by mediaType)
      if (req.method === "GET" && route === "search") {
        const q = url.searchParams.get("q") || "";
        const page = url.searchParams.get("page") || "1";
        if (!q) {
          sendJSON(res, 400, { error: "q is required" }, req);
          return true;
        }
        const d = await seerrGet(`/search?query=${encodeURIComponent(q)}&page=${page}`);
        const results = slimList(d.results || d).filter((r) => r.mediaType === "movie" || r.mediaType === "tv");
        sendJSON(res, 200, { page: d.page || Number(page), totalPages: d.totalPages || 1, results }, req);
        return true;
      }

      // GET /media/discover/detail?type=movie|tv&tmdbId=N — full detail (cast, genres, similar, availability)
      if (req.method === "GET" && route === "detail") {
        const type = url.searchParams.get("type") === "tv" ? "tv" : "movie";
        const tmdbId = url.searchParams.get("tmdbId");
        if (!tmdbId || !/^\d+$/.test(tmdbId)) {
          sendJSON(res, 400, { error: "tmdbId (numeric) is required" }, req);
          return true;
        }
        const d = await seerrGet(`/${type}/${tmdbId}`);
        const out = {
          tmdbId: d.id,
          mediaType: type,
          title: d.title || d.name || "",
          tagline: d.tagline || "",
          overview: d.overview || "",
          posterPath: d.posterPath || null,
          backdropPath: d.backdropPath || null,
          voteAverage: typeof d.voteAverage === "number" ? d.voteAverage : null,
          genres: slimGenres(d),
          cast: slimCast(d.credits),
          similar: slimList(d.similar?.results).slice(0, 15),
          recommendations: slimList(d.recommendations?.results).slice(0, 15),
          availability: availabilityOf(d.mediaInfo),
        };
        if (type === "movie") {
          out.releaseDate = d.releaseDate || null;
          out.runtime = d.runtime || null;
        } else {
          out.firstAirDate = d.firstAirDate || null;
          out.showStatus = d.status || null; // "Ended" / "Returning Series"
          out.numberOfSeasons = d.numberOfSeasons || null;
          out.episodeRunTime = Array.isArray(d.episodeRunTime) ? d.episodeRunTime[0] || null : null;
          out.seasons = (d.seasons || [])
            .map((s) => ({
              seasonNumber: s.seasonNumber ?? s.season_number ?? null,
              name: s.name || "",
              episodeCount: s.episodeCount ?? null,
              airDate: s.airDate ?? s.air_date ?? null,
            }))
            .filter((s) => s.seasonNumber === null || s.seasonNumber >= 1) // drop specials
            .sort((a, b) => (a.seasonNumber || 0) - (b.seasonNumber || 0));
        }
        sendJSON(res, 200, out, req);
        return true;
      }

      // POST /media/discover/request — body {tmdbId, mediaType, seasons?: number[] | "all"}
      // Maps to Seerr's FLAT request schema. 201 = request created; 202 = nothing to
      // request (already available / no seasons); 409 = duplicate pending request.
      if (req.method === "POST" && route === "request") {
        const body = await parseBody(req);
        const tmdbId = Number(body.tmdbId);
        const mediaType = body.mediaType === "tv" ? "tv" : "movie";
        if (!tmdbId) {
          sendJSON(res, 400, { error: "tmdbId (numeric) is required" }, req);
          return true;
        }
        const payload = { mediaId: tmdbId, mediaType };
        if (mediaType === "tv") payload.seasons = Array.isArray(body.seasons) && body.seasons.length ? body.seasons : "all";
        const r = await fetchWithTimeout(`${SEERR_URL}/api/v1/request`, {
          method: "POST",
          headers: seerrHeaders(),
          body: JSON.stringify(payload),
        }, 15000);
        const d = await r.json().catch(() => null);
        if (r.status === 201) {
          dlog("info", `discover: request created — ${mediaType} ${tmdbId} (seerr request ${d?.id})`);
          sendJSON(res, 200, { ok: true, created: true, requestId: d?.id ?? null, status: d?.status ?? null }, req);
          return true;
        }
        if (r.status === 202) {
          sendJSON(res, 200, { ok: true, created: false, reason: "nothing_to_request", message: d?.message || d?.error || "Already available (or no requestable seasons)." }, req);
          return true;
        }
        if (r.status === 409) {
          sendJSON(res, 200, { ok: true, created: false, reason: "duplicate", message: d?.messages?.[0] || d?.error || "A request already exists." }, req);
          return true;
        }
        const msg = d?.messages?.[0] || d?.error || `Seerr HTTP ${r.status}`;
        dlog("warn", `discover: request failed ${mediaType} ${tmdbId} — ${msg}`);
        sendJSON(res, 502, { error: msg }, req);
        return true;
      }

      // GET /media/discover/requests — recent requests (list screen / status pill)
      if (req.method === "GET" && route === "requests") {
        const d = await seerrGet("/request?take=50&sort=added");
        const results = (d.results || []).map((rq) => ({
          id: rq.id,
          status: rq.status ?? null, // MediaRequestStatus 1-5
          createdAt: rq.createdAt || null,
          mediaType: rq.media?.mediaType || rq.mediaType || null,
          tmdbId: rq.media?.tmdbId ?? rq.mediaId ?? null,
          requestedBy: rq.requestedBy?.displayName || null,
          is4k: !!rq.is4k,
        }));
        sendJSON(res, 200, { count: results.length, results }, req);
        return true;
      }

      // GET /media/discover/watch?type=movie|tv&tmdbId=N — one-stop orchestration
      // state for the Watch button: availability + request rows + REAL arr progress.
      if (req.method === "GET" && route === "watch") {
        const type = url.searchParams.get("type") === "tv" ? "tv" : "movie";
        const tmdbId = url.searchParams.get("tmdbId");
        if (!tmdbId || !/^\d+$/.test(tmdbId)) {
          sendJSON(res, 400, { error: "tmdbId (numeric) is required" }, req);
          return true;
        }
        const d = await seerrGet(`/${type}/${tmdbId}`);
        const mi = d.mediaInfo || null;
        const availability = availabilityOf(mi);
        const requests = ((mi && (mi.mediaRequests || mi.requests)) || []).map((r) => ({
          id: r.id ?? null,
          status: r.status ?? null,
        }));
        const tvdbId = d.externalIds?.tvdbId ?? mi?.tvdbId ?? null;
        let progress = null;
        try {
          progress = type === "movie" ? await radarrProgress(tmdbId) : await sonarrProgress(tvdbId);
        } catch (e) {
          dlog("warn", `discover watch: arr progress failed ${type} ${tmdbId} — ${e.message}`);
        }
        const avail = !!availability && (availability.status === 4 || availability.status === 5);
        let nudged = false;
        if (!avail && progress && (progress.stage === "imported" || progress.stage === "partial")) {
          nudged = maybeNudgeRefresh(tmdbId, type, dlog);
        }
        sendJSON(res, 200, { availability, requests, progress, nudged }, req);
        return true;
      }

      // POST /media/discover/watch — body {tmdbId, mediaType, seasons?}: the Watch
      // click. Already playable → {action:"play", availability(jellyfinId)}; else
      // fires the Seerr request (admin API key → auto-approved → arrs grab it)
      // and the app polls GET watch until it can auto-play.
      if (req.method === "POST" && route === "watch") {
        const body = await parseBody(req);
        const tmdbId = Number(body.tmdbId);
        const mediaType = body.mediaType === "tv" ? "tv" : "movie";
        if (!tmdbId) {
          sendJSON(res, 400, { error: "tmdbId (numeric) is required" }, req);
          return true;
        }
        const d = await seerrGet(`/${mediaType}/${tmdbId}`);
        const availability = availabilityOf(d.mediaInfo);
        if (availability && (availability.status === 4 || availability.status === 5) && availability.jellyfinId) {
          sendJSON(res, 200, { action: "play", availability }, req);
          return true;
        }
        const payload = { mediaId: tmdbId, mediaType };
        if (mediaType === "tv") {
          payload.seasons = Array.isArray(body.seasons) && body.seasons.length ? body.seasons : "all";
        }
        const r = await fetchWithTimeout(`${SEERR_URL}/api/v1/request`, {
          method: "POST",
          headers: seerrHeaders(),
          body: JSON.stringify(payload),
        }, 15000);
        const rd = await r.json().catch(() => null);
        if (r.status === 201) {
          dlog("info", `discover: watch-orchestrate ${mediaType} ${tmdbId} → seerr request ${rd?.id}`);
          sendJSON(res, 200, { action: "requested", created: true, requestId: rd?.id ?? null, status: rd?.status ?? null, availability }, req);
          return true;
        }
        if (r.status === 202) {
          sendJSON(res, 200, { action: "none", reason: "nothing_to_request", message: rd?.message || rd?.error || "Already available (or no requestable seasons).", availability }, req);
          return true;
        }
        if (r.status === 409) {
          sendJSON(res, 200, { action: "requested", created: false, reason: "duplicate", availability }, req);
          return true;
        }
        const msg = rd?.messages?.[0] || rd?.error || `Seerr HTTP ${r.status}`;
        dlog("warn", `discover: watch request failed ${mediaType} ${tmdbId} — ${msg}`);
        sendJSON(res, 502, { error: msg }, req);
        return true;
      }

      sendJSON(res, 404, { error: `Unknown discover route: ${pathname}` }, req);
      return true;
    } catch (e) {
      const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
      dlog("error", `discover route error ${pathname}: ${e.message}`);
      sendJSON(res, status, { error: e.message || "Seerr proxy failure" }, req);
      return true;
    }
  };
};
