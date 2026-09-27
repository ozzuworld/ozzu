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

// ── routes ───────────────────────────────────────────────────────────────────

module.exports = function discoverRoutes(ctx) {
  const { sendJSON, parseBody, log } = ctx;

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
          log("info", `discover: request created — ${mediaType} ${tmdbId} (seerr request ${d?.id})`);
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
        log("warn", `discover: request failed ${mediaType} ${tmdbId} — ${msg}`);
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

      sendJSON(res, 404, { error: `Unknown discover route: ${pathname}` }, req);
      return true;
    } catch (e) {
      const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
      log("error", `discover route error ${pathname}: ${e.message}`);
      sendJSON(res, status, { error: e.message || "Seerr proxy failure" }, req);
      return true;
    }
  };
};
