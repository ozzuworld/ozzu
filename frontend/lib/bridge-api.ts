// HTTP client for the Command Bridge server

const BRIDGE_URL =
  process.env.EXPO_PUBLIC_BRIDGE_URL || "http://localhost:3333";
const FETCH_TIMEOUT_MS = 15000; // 15s timeout for all bridge HTTP calls

function fetchWithTimeout(url: string, opts?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export interface StatusEntry {
  event: string;
  tool: string;
  message: string;
  timestamp: string;
}

export interface ApprovalRequest {
  id: string;
  tool: string;
  description: string;
  risk: string;
  resolved: boolean;
  approved: boolean;
  createdAt: number;
}

export interface Directive {
  id: string;
  type: "quick" | "feature" | "explore";
  title: string;
  description: string;
  status: string;
  plan: string | null;
  directiveApprovalId: string | null;
  retryCount: number;
  failureReason: string | null;
  mergeBranch?: string | null;
  priority: number;
  dependsOn: string[] | null;
  createdBy?: string;
  activity_log: Array<{ timestamp: number; type: string; actor?: string; message: string }>;
  startedAt?: number;
  completedAt?: number;
  duration?: number;
  createdAt: number;
  updatedAt: number;
}

export interface EnrichedApproval extends ApprovalRequest {
  directiveTitle: string | null;
  directivePlan: string | null;
  directiveDescription: string | null;
  directiveId: string | null;
}

export async function fetchDevStatus(): Promise<StatusEntry[]> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/status`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Bridge status error: ${res.status}`);
  return res.json();
}

export async function fetchPendingApprovals(): Promise<ApprovalRequest[]> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/approvals`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Bridge approvals error: ${res.status}`);
  return res.json();
}

export async function resolveApproval(
  id: string,
  approved: boolean,
  pin: string
): Promise<{ ok: boolean; approved?: boolean; error?: string }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/approvals/${id}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved, pin }),
  });
  if (!res.ok) throw new Error(`Bridge resolve approval error: ${res.status}`);
  return res.json();
}

export async function fetchDirectives(status?: string): Promise<Directive[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/directives${qs}`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Bridge directives error: ${res.status}`);
  return res.json();
}

export async function sendDirective(
  type: string,
  title: string,
  description: string
): Promise<{ ok: boolean; directive: Directive }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/directives`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, title, description }),
  });
  if (!res.ok) throw new Error(`Bridge send directive error: ${res.status}`);
  return res.json();
}

export async function updateDirective(
  id: string,
  updates: { status?: string; plan?: string; title?: string }
): Promise<{ ok: boolean; directive: Directive }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/directives/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`Bridge update directive error: ${res.status}`);
  return res.json();
}

export async function cancelDirective(
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/directives/${id}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  return res.json();
}

export async function retryDirective(
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/directives/${id}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  return res.json();
}

export async function retryMergeDirective(
  id: string
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/directives/${id}/retry-merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  return res.json();
}

export async function unblockDirective(
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/directives/${id}/unblock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  return res.json();
}

export async function fetchApprovalDetails(): Promise<EnrichedApproval[]> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/approvals/details`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Bridge approval details error: ${res.status}`);
  return res.json();
}
