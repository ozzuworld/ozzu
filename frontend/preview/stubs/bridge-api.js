// Preview stub of lib/bridge-api — same-origin relative URLs. serve.py proxies
// /soc/* (and other API prefixes) to the LOCAL bridge at 127.0.0.1:3333;
// loopback is keyless by the bridge trust model, so no auth headers here.
// Screens therefore render against REAL live data, single-origin (no CORS).
export function getBridgeUrl() { return ""; }
export function getAuthHeaders() { return {}; }
export function getBridgeMode() { return "preview"; }
export async function probeBridgeUrl() {}
export function resetBridgeUrl() {}

export async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function apiFetch(path, opts) {
  const res = await fetchWithTimeout(path, opts);
  if (!res.ok) throw new Error(`apiFetch ${path} -> ${res.status}`);
  return res.json();
}
