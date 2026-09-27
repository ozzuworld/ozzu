// Jellyfin SDK client singleton for the Ozzu TV app.
//
// The TV reaches Jellyfin on bridge-01 three ways (see resolveServerUrl): LAN
// direct at home, WG mesh (10.9.0.5:8096), or the public nginx door
// (home.ozzu.world/bridge/jellyfin -> AWS edge -> WG -> :8096) from anywhere.
// A stable deviceId is required so Jellyfin keys sessions/resume consistently.

import { Jellyfin } from "@jellyfin/sdk";
import type { Api } from "@jellyfin/sdk";

// LAN-direct by default: Jellyfin lives on bridge-01 (192.168.1.9:8096) and media
// bytes must NOT hairpin through the cloud edge when at home (data-sovereignty +
// bandwidth). resolveServerUrl() below picks the best path per network:
//   WG mesh:            http://10.9.0.5:8096
//   nginx public proxy: https://home.ozzu.world/bridge/jellyfin (AWS edge)
export const DEFAULT_BASE_URL = "http://192.168.1.9:8096";
const CLIENT_INFO = { name: "Ozzu TV", version: "1.0.0" };

let _jellyfin: Jellyfin | null = null;
let _api: Api | null = null;
let _baseUrl = DEFAULT_BASE_URL;
let _deviceId = "ozzu-tv";
let _token: string | undefined;

function instance(): Jellyfin {
  if (!_jellyfin) {
    _jellyfin = new Jellyfin({
      clientInfo: CLIENT_INFO,
      deviceInfo: { name: "Ozzu TV", id: _deviceId },
    });
  }
  return _jellyfin;
}

function rebuild() {
  _api = instance().createApi(_baseUrl, _token);
}

/** Call once at startup (with the persisted device id) BEFORE the first getApi(). */
export function configureClient(deviceId: string) {
  _deviceId = deviceId;
  _jellyfin = null; // force re-create so deviceInfo.id is correct
  _api = null;
}

export function getApi(): Api {
  if (!_api) rebuild();
  return _api as Api;
}

export function setBaseUrl(url: string) {
  _baseUrl = url.replace(/\/+$/, "");
  rebuild();
}

export function setAccessToken(token: string | undefined) {
  _token = token;
  if (_api) _api.accessToken = token || "";
  else rebuild();
}

export function resetClient() {
  _token = undefined;
  rebuild();
}

export const getBaseUrl = () => _baseUrl;
export const getDeviceId = () => _deviceId;
export const getAccessToken = () => _token;

/** Jellyfin 12 auth header for URL-based consumers (<Image source>, expo-video).
 * JF12 rejects query-param auth (`api_key=`) AND X-Emby-Token/Bearer with 401 —
 * ONLY `Authorization: MediaBrowser Token=` works (verified 12.1.0, 2026-09-26). */
export function authHeaders(): Record<string, string> {
  return _token ? { Authorization: `MediaBrowser Token=${_token}` } : {};
}

// ── Server resolution (2026-09-27, dir_1790443814736) ────────────────────────
// A hardcoded LAN default silently broke login for any device NOT on home WiFi:
// every call throws at the network layer and LoginScreen's catch-all blamed the
// credentials. Probe ordered candidates at startup instead — first responder
// wins — and expose reachability so the UI can tell "wrong password" apart from
// "no server on this network".
export const SERVER_CANDIDATES = [
  "http://192.168.1.9:8096", // home LAN (bridge-01)
  "http://10.9.0.5:8096", // WG mesh
  "https://home.ozzu.world/bridge/jellyfin", // public door via AWS edge (LIVE since 2026-09-27)
];

let _reachable = false;
export const isServerReachable = () => _reachable;

async function probeServer(url: string, timeoutMs = 2500): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/System/Info/Public`, { signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Probe `first` (persisted/default) then SERVER_CANDIDATES; first responder
 *  becomes the base URL. Returns the resolved URL, or null when NO Jellyfin is
 *  reachable from this device's current network. */
export async function resolveServerUrl(first?: string | null): Promise<string | null> {
  const seen = new Set<string>();
  const urls: string[] = [];
  // Order matters: LAN → WG → persisted override → public edge. Home devices
  // always get the direct LAN path (zero cloud hairpin, zero egress cost);
  // remote devices fall through to the public door (live since 2026-09-27).
  const [lan, wg, pub] = SERVER_CANDIDATES;
  for (const u of [lan, wg, first, pub]) {
    if (!u) continue;
    const norm = u.replace(/\/+$/, "");
    if (!seen.has(norm)) {
      seen.add(norm);
      urls.push(norm);
    }
  }
  for (const url of urls) {
    if (await probeServer(url)) {
      setBaseUrl(url);
      _reachable = true;
      return url;
    }
  }
  _reachable = false;
  return null;
}

// Current authenticated user id (set on auth + on bootstrap; read by data calls).
let _userId = "";
export const setUserId = (id: string) => {
  _userId = id;
};
export const getUserId = () => _userId;
