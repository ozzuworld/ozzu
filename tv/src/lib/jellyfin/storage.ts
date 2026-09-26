// Persisted Jellyfin session — Keystore-backed (expo-secure-store), because the
// access token is a long-lived credential to a server reachable via the public
// bridge proxy. Tokens are tiny, well within secure-store's size limit.

import * as SecureStore from "expo-secure-store";

const K_SESSION = "ozzu_jf_session";
const K_DEVICE = "ozzu_jf_device_id";
const K_BASEURL = "ozzu_jf_base_url";

export interface Session {
  accessToken: string;
  userId: string;
  userName?: string;
  serverId?: string;
}

export async function loadSession(): Promise<Session | null> {
  try {
    const raw = await SecureStore.getItemAsync(K_SESSION);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export async function saveSession(s: Session): Promise<void> {
  try {
    await SecureStore.setItemAsync(K_SESSION, JSON.stringify(s));
  } catch {
    /* non-fatal */
  }
}

export async function clearSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(K_SESSION);
  } catch {
    /* non-fatal */
  }
}

export async function loadBaseUrl(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(K_BASEURL);
  } catch {
    return null;
  }
}

export async function saveBaseUrl(url: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(K_BASEURL, url);
  } catch {
    /* non-fatal */
  }
}

/** Stable per-device id so Jellyfin keys sessions/resume consistently. */
export async function getOrCreateDeviceId(): Promise<string> {
  try {
    let id = await SecureStore.getItemAsync(K_DEVICE);
    if (!id) {
      id = `ozzu-tv-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      await SecureStore.setItemAsync(K_DEVICE, id);
    }
    return id;
  } catch {
    return "ozzu-tv-fallback";
  }
}
