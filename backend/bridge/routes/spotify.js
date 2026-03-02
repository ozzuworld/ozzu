// routes/spotify.js — Spotify + album color route handlers (extracted from server.js)

module.exports = function createSpotifyRoutes(ctx) {
  const { log, sendJSON, parseBody, spotifyFetch, getSpotifyToken, metrics,
          HA_URL, HA_TOKEN } = ctx;

  // Module-scoped caches (only used by these routes)
  const _albumColorCache = new Map();
  let _spotifyQueueCache = null;
  let _spotifyPlaylistsCache = null;
  const _spotifyTracksCache = new Map();
  let _spotifyNowPlayingCache = null;

  return async function handleSpotifyRoutes(req, res, pathname, url) {
  if (req.method === "GET" && pathname === "/api/album-color") {
    const artUrl = url.searchParams.get("url");
    if (!artUrl) {
      sendJSON(res, 400, { error: "Missing url parameter" });
      return;
    }

    // Check cache first
    const cached = _albumColorCache.get(artUrl);
    if (cached) {
      sendJSON(res, 200, { hex: cached });
      return;
    }

    try {
      const imgRes = await fetch(`${HA_URL}${artUrl}`, {
        headers: { Authorization: `Bearer ${HA_TOKEN}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!imgRes.ok) {
        sendJSON(res, 502, { error: `HA returned ${imgRes.status}` });
        return;
      }
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      const sharp = require("sharp");
      const { data } = await sharp(buffer).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
      const hex = `#${data[0].toString(16).padStart(2, "0")}${data[1].toString(16).padStart(2, "0")}${data[2].toString(16).padStart(2, "0")}`;

      // Cache (LRU-ish, cap at 100)
      if (_albumColorCache.size >= 100) {
        const firstKey = _albumColorCache.keys().next().value;
        _albumColorCache.delete(firstKey);
      }
      _albumColorCache.set(artUrl, hex);

      sendJSON(res, 200, { hex });
    } catch (err) {
      log.bridge.error("Album color extraction failed:", err.message);
      sendJSON(res, 500, { error: "Color extraction failed" });
    }
    return true;
  }

  // GET /api/spotify/queue — fetch Spotify queue via Spotify Web API
  if (req.method === "GET" && pathname === "/api/spotify/queue") {
    if (_spotifyQueueCache && Date.now() - _spotifyQueueCache.ts < 15000) {
      sendJSON(res, 200, { queue: _spotifyQueueCache.queue });
      return;
    }
    try {
      const data = await spotifyFetch("/me/player/queue");
      const queue = (data?.queue || []).slice(0, 3).map(t => ({
        name: t.name || "",
        artist: (t.artists || []).map(a => a.name).join(", "),
        imageUrl: t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || null,
      }));
      _spotifyQueueCache = { queue, ts: Date.now() };
      sendJSON(res, 200, { queue });
    } catch (err) {
      log.bridge.error("Spotify queue fetch failed:", err.message);
      sendJSON(res, 200, { queue: [], reason: err.message });
    }
    return true;
  }

  // GET /api/spotify/playlists — fetch user playlists + synthetic Liked Songs
  if (req.method === "GET" && pathname === "/api/spotify/playlists") {
    if (_spotifyPlaylistsCache && Date.now() - _spotifyPlaylistsCache.ts < 60000) {
      sendJSON(res, 200, { playlists: _spotifyPlaylistsCache.playlists });
      return;
    }
    try {
      const [playlistData, likedData] = await Promise.all([
        spotifyFetch("/me/playlists?limit=50"),
        spotifyFetch("/me/tracks?limit=1"),
      ]);
      const playlists = [
        {
          id: "liked",
          name: "Liked Songs",
          description: "",
          imageUrl: null, // Frontend renders gradient
          trackCount: likedData?.total || 0,
          owner: "You",
        },
        ...(playlistData?.items || []).map(p => ({
          id: p.id,
          name: p.name,
          description: p.description || "",
          imageUrl: p.images?.[0]?.url || null,
          trackCount: p.tracks?.total || 0,
          owner: p.owner?.display_name || "",
        })),
      ];
      _spotifyPlaylistsCache = { playlists, ts: Date.now() };
      sendJSON(res, 200, { playlists });
    } catch (err) {
      log.bridge.error("Spotify playlists fetch failed:", err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /api/spotify/playlists/:id/tracks — fetch tracks for a playlist or liked songs
  const tracksMatch = pathname.match(/^\/api\/spotify\/playlists\/([^/]+)\/tracks$/);
  if (req.method === "GET" && tracksMatch) {
    const playlistId = tracksMatch[1];
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 50);
    const cacheKey = `${playlistId}:${offset}`;

    const cached = _spotifyTracksCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 30000) {
      sendJSON(res, 200, { tracks: cached.tracks, total: cached.total, offset, hasMore: offset + cached.tracks.length < cached.total });
      return;
    }

    try {
      const endpoint = playlistId === "liked"
        ? `/me/tracks?offset=${offset}&limit=${limit}`
        : `/playlists/${playlistId}/tracks?offset=${offset}&limit=${limit}`;
      const data = await spotifyFetch(endpoint);
      const tracks = (data?.items || []).map(item => {
        const t = item.track || item;
        return {
          id: t.id,
          name: t.name || "",
          artist: (t.artists || []).map(a => a.name).join(", "),
          albumName: t.album?.name || "",
          albumArt: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || null,
          durationMs: t.duration_ms || 0,
          explicit: !!t.explicit,
          uri: t.uri || "",
        };
      });
      const total = data?.total || 0;
      _spotifyTracksCache.set(cacheKey, { tracks, total, ts: Date.now() });
      // Evict old cache entries
      if (_spotifyTracksCache.size > 50) {
        const firstKey = _spotifyTracksCache.keys().next().value;
        _spotifyTracksCache.delete(firstKey);
      }
      sendJSON(res, 200, { tracks, total, offset, hasMore: offset + tracks.length < total });
    } catch (err) {
      log.bridge.error("Spotify tracks fetch failed:", err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /api/spotify/play — play a specific track or context
  if (req.method === "GET" && pathname === "/api/spotify/play") {
    const uri = url.searchParams.get("uri");
    const contextUri = url.searchParams.get("context_uri");
    const offsetPos = url.searchParams.get("offset");
    if (!uri && !contextUri) {
      sendJSON(res, 400, { error: "Missing uri or context_uri parameter" });
      return;
    }
    try {
      const body = {};
      if (contextUri) {
        body.context_uri = contextUri;
        if (offsetPos !== null) body.offset = { position: parseInt(offsetPos, 10) };
      } else {
        body.uris = [uri];
      }
      await spotifyFetch("/me/player/play", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      sendJSON(res, 200, { ok: true });
    } catch (err) {
      log.bridge.error("Spotify play failed:", err.message);
      // Fallback: try HA service call
      if (uri) {
        try {
          await fetch(`${HA_URL}/api/services/media_player/play_media`, {
            method: "POST",
            headers: { Authorization: `Bearer ${HA_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ entity_id: "media_player.spotify_king_kazuma", media_content_id: uri, media_content_type: "music" }),
            signal: AbortSignal.timeout(5000),
          });
          sendJSON(res, 200, { ok: true, fallback: "ha" });
          return;
        } catch (haErr) {
          log.bridge.warn("Spotify HA fallback also failed:", haErr.message);
        }
      }
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /api/spotify/now-playing — richer now-playing context
  if (req.method === "GET" && pathname === "/api/spotify/now-playing") {
    if (_spotifyNowPlayingCache && Date.now() - _spotifyNowPlayingCache.ts < 5000) {
      sendJSON(res, 200, _spotifyNowPlayingCache.data);
      return;
    }
    try {
      const data = await spotifyFetch("/me/player/currently-playing");
      if (!data || !data.item) {
        sendJSON(res, 200, { trackId: null, isPlaying: false });
        return;
      }
      const result = {
        trackId: data.item.id,
        trackUri: data.item.uri,
        isPlaying: data.is_playing,
        contextType: data.context?.type || null,
        contextUri: data.context?.uri || null,
        contextName: null, // Spotify doesn't return name in context, frontend can match
      };
      _spotifyNowPlayingCache = { data: result, ts: Date.now() };
      sendJSON(res, 200, result);
    } catch (err) {
      log.bridge.error("Spotify now-playing fetch failed:", err.message);
      sendJSON(res, 200, { trackId: null, isPlaying: false, error: err.message });
    }
    return true;
  }

  // GET /api/spotify/liked — fetch user's liked songs
  if (req.method === "GET" && pathname === "/api/spotify/liked") {
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const cacheKey = `liked:${offset}`;
    const cached = _spotifyTracksCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 120000) {
      sendJSON(res, 200, { tracks: cached.tracks, total: cached.total });
      return;
    }
    const token = await getSpotifyToken();
    if (!token) {
      sendJSON(res, 500, { error: "No Spotify token available" });
      return;
    }
    try {
      const spRes = await fetch(
        `https://api.spotify.com/v1/me/tracks?limit=50&offset=${offset}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) }
      );
      if (!spRes.ok) {
        sendJSON(res, spRes.status, { error: `Spotify API error ${spRes.status}` });
        return;
      }
      const data = await spRes.json();
      const tracks = (data.items || [])
        .filter(item => item.track)
        .map(item => {
          const t = item.track;
          return {
            id: t.id,
            name: t.name,
            artist: (t.artists || []).map(a => a.name).join(", "),
            albumName: t.album?.name || "",
            albumArt: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || null,
            albumArtSmall: t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || null,
            durationMs: t.duration_ms || 0,
            uri: t.uri,
          };
        });
      const total = data.total || 0;
      _spotifyTracksCache.set(cacheKey, { tracks, total, ts: Date.now() });
      sendJSON(res, 200, { tracks, total });
    } catch (err) {
      log.bridge.error("Spotify liked songs fetch failed:", err.message);
      sendJSON(res, 500, { error: "Failed to fetch liked songs" });
    }
    return true;
  }

  // POST /api/spotify/play — start playback on active device
  if (req.method === "POST" && pathname === "/api/spotify/play") {
    const token = await getSpotifyToken();
    if (!token) {
      sendJSON(res, 500, { error: "No Spotify token available" });
      return;
    }
    try {
      const body = await parseBody(req);
      const payload = {};
      if (body.contextUri) payload.context_uri = body.contextUri;
      if (body.uri) payload.uris = [body.uri];
      if (body.offset) payload.offset = body.offset;
      const spRes = await fetch("https://api.spotify.com/v1/me/player/play", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      if (spRes.status === 204 || spRes.ok) {
        sendJSON(res, 200, { ok: true });
      } else {
        const errText = await spRes.text().catch(() => "");
        sendJSON(res, spRes.status, { error: `Spotify play error ${spRes.status}`, detail: errText });
      }
    } catch (err) {
      log.bridge.error("Spotify play failed:", err.message);
      sendJSON(res, 500, { error: "Failed to start playback" });
    }
    return true;
  }

    return false;
  };
};
