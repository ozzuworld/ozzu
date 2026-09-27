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

// ── Business mutators: no-ops in preview (read-only looking) ──
const noop = async () => ({});
export const createBusinessProject = noop;
export const updateBusinessProject = noop;
export const archiveBusinessProject = noop;
export const createBusinessTask = noop;
export const deleteBusinessTask = noop;
export const toggleBusinessTaskStatus = noop;
export const uploadTaskAttachment = noop;
export const createProjectExpense = noop;
export const updateExpense = noop;
export const deleteExpense = noop;
export const createBusinessContact = noop;
export const updateBusinessContact = noop;
export const deleteBusinessContact = noop;
export const createBusinessShipment = noop;
export const updateBusinessShipment = noop;
export const updateShipmentStatus = noop;
export const extractReceipt = noop;

// ── Business readers: live where cheap, empty otherwise ──
export async function fetchBusinessContacts() { try { return await apiFetch("/business/contacts"); } catch { return []; } }
export async function fetchBusinessShipment() { return null; }
export async function fetchTaskAttachments() { return []; }
export async function fetchTaskRequirements() { return []; }
export async function getProjectExpenses() { return []; }
export async function getTaskExpenses() { return []; }
export function getAttachmentUrl(id) { return `/business/attachments/${id}`; }
export function formatCurrency(v, cur = "USD") {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "")) || 0;
  const sym = cur === "COP" ? "$" : cur === "USD" ? "$" : cur + " ";
  return `${sym}${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
