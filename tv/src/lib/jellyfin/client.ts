// Jellyfin SDK client singleton for the Ozzu TV app.
//
// The TV reaches Jellyfin through the bridge reverse-proxy (nginx ^~ /bridge/
// jellyfin/ -> dev-01:8096 over WG). Base URL is overridable in Settings.
// A stable deviceId is required so Jellyfin keys sessions/resume consistently.

import { Jellyfin } from "@jellyfin/sdk";
import type { Api } from "@jellyfin/sdk";

// LAN-direct by default: Jellyfin lives on bridge-01 (192.168.1.9:8096) and media
// bytes must NOT hairpin through the GCP edge (data-sovereignty + bandwidth).
// Override in Settings for remote:
//   WG mesh:            http://10.9.0.5:8096
//   nginx public proxy: https://home.ozzu.world/bridge/jellyfin
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

// Current authenticated user id (set on auth + on bootstrap; read by data calls).
let _userId = "";
export const setUserId = (id: string) => {
  _userId = id;
};
export const getUserId = () => _userId;
