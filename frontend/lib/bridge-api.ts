// HTTP client for the Command Bridge server

const LAN_URL =
  process.env.EXPO_PUBLIC_BRIDGE_URL || "https://home.ozzu.world/bridge";
const PUBLIC_URL =
  process.env.EXPO_PUBLIC_BRIDGE_PUBLIC_URL || "";
const BRIDGE_API_KEY =
  process.env.EXPO_PUBLIC_BRIDGE_API_KEY || "";
const FETCH_TIMEOUT_MS = 15000; // 15s timeout for all bridge HTTP calls
const PROBE_TIMEOUT_MS = 2000; // 2s probe to check LAN reachability

// Auto-detect: LAN or public URL. Starts on LAN, falls back to public after probe.
let BRIDGE_URL = LAN_URL;
let _probed = false;

/** Probe LAN reachability and switch to public URL if needed. Call once on app start. */
export async function probeBridgeUrl(): Promise<void> {
  if (_probed || !PUBLIC_URL) return;
  _probed = true;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(`${LAN_URL}/status`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) return; // LAN works, keep it
  } catch {}
  BRIDGE_URL = PUBLIC_URL; // LAN unreachable, switch to public
}

/** Force re-probe on next call (e.g. after network change) */
export function resetBridgeUrl() { _probed = false; BRIDGE_URL = LAN_URL; }

/** Get the current bridge URL */
export function getBridgeUrl(): string { return BRIDGE_URL; }

/** Which URL is active — "lan" | "remote" */
export function getBridgeMode(): "lan" | "remote" {
  return BRIDGE_URL === LAN_URL ? "lan" : "remote";
}

/** Get auth headers. D1B: send the Bearer key whenever it is configured, NOT only
 * in "remote" mode — the app treats home.ozzu.world (the public nginx path) as
 * "lan", so the mode gate meant the key was never sent on the path that actually
 * enforces auth. Sending it on LAN/WG too is harmless (the bridge only enforces
 * for public requests). No-op while EXPO_PUBLIC_BRIDGE_API_KEY is unset (current
 * default) → INERT until the key is provisioned in the coordinated rollout. */
export function getAuthHeaders(): Record<string, string> {
  if (BRIDGE_API_KEY) {
    return { "Authorization": `Bearer ${BRIDGE_API_KEY}` };
  }
  return {};
}

function fetchWithTimeout(url: string, opts?: RequestInit, timeoutMs?: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? FETCH_TIMEOUT_MS);
  // Inject auth headers for public requests
  const authHeaders = getAuthHeaders();
  const mergedHeaders = { ...authHeaders, ...(opts?.headers || {}) };
  return fetch(url, { ...opts, headers: mergedHeaders, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export async function apiFetch(path: string, opts?: RequestInit): Promise<any> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}${path}`, opts);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
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
  type: "quick" | "feature" | "explore" | "epic";
  title: string;
  description: string;
  emoji?: string | null;
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
  buildRuns?: Array<{ platform: string; runId: number; triggeredAt: number; status: string; conclusion: string | null; url: string; lastChecked: number | null }>;
  epicId?: string | null;
  phaseOrder?: number | null;
  phases?: Directive[];
  category?: string;
  work_summary?: string | null;
  working_state?: any | null;
  handoff_context?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DirectiveSummary {
  headline: string;
  completedToday: number;
  completedThisWeek: number;
  activeCount: number;
  needsAttentionCount: number;
  needsAttention: Array<{ id: string; title: string; status: string; emoji: string }>;
  categories: Record<string, { total: number; active: number; completed: number; blocked: number }>;
  total: number;
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

export async function fetchDirectiveSummary(): Promise<DirectiveSummary> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/directives/summary`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Bridge summary error: ${res.status}`);
  return res.json();
}

export async function fetchDirective(id: string): Promise<Directive> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/directives/${id}`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Bridge directive error: ${res.status}`);
  return res.json();
}

export interface HistoryEntry {
  timestamp: number;
  type: string;
  actor?: string;
  message: string;
  source: "activity_log" | "pg_history";
  details?: any;
}

export interface DirectiveBuildRun {
  platform: string;
  runId: number;
  triggeredAt: number;
  status: string;
  conclusion: string | null;
  url: string;
  lastChecked: number | null;
}

export async function fetchDirectiveBuildStatus(id: string): Promise<DirectiveBuildRun[]> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/directives/${id}/build-status`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Bridge build-status error: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.buildRuns) ? data.buildRuns : [];
}

export async function fetchDirectiveHistory(id: string): Promise<HistoryEntry[]> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/directives/${id}/history`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Bridge history error: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.timeline) ? data.timeline : Array.isArray(data) ? data : [];
}

export async function updateDirective(
  id: string,
  updates: { status?: string; plan?: string; title?: string; failureReason?: string | null; priority?: number; actor?: string }
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

export async function commentDirective(
  id: string,
  message: string
): Promise<{ ok: boolean }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/directives/${id}/comment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  return res.json();
}

export interface UsageMetrics {
  today: {
    date: string;
    gemini: {
      sessions: number;
      sessionDurationMs: number;
      audioChunksSent: number;
      audioChunksReceived: number;
      toolCalls: number;
      reconnects: number;
      turnsCompleted: number;
    };
    cipher: {
      agentSpawns: number;
      agentCompletions: number;
      agentFailures: number;
      activeAgents: number;
    };
    spotify: {
      apiCalls: number;
      tokenRefreshes: number;
      cacheHits: number;
    };
    bridge: {
      wsConnectionsTotal: number;
      wsDisconnections: number;
      httpRequests: number;
    };
    connectionHistory: Array<{
      event: string;
      deviceId: string;
      deviceType?: string;
      timestamp: number;
    }>;
  };
  history: Array<{
    date: string;
    metrics: Record<string, number>;
  }>;
  live: {
    voiceLatency: {
      count: number;
      avgTotal: number;
      avgThinking: number;
      avgTts: number;
      p95Total: number;
    };
    activeDevices: Array<{
      deviceId: string;
      deviceType: string;
      role: string;
      zone: string;
    }>;
    memoryMB: { heap: number; rss: number };
    uptimeSeconds: number;
    persona: string;
    cipherMode: string;
    agents: {
      active: number;
      max: number;
      details: Array<{ directiveId: string; type: string; pid: number }>;
    };
    directives: {
      successRate: number | null;
      avgDurationMs: number | null;
      today: { submitted: number; completed: number; failed: number };
    };
  };
}

export async function fetchUsageMetrics(): Promise<UsageMetrics> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/api/usage`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Bridge usage metrics error: ${res.status}`);
  return res.json();
}

export interface AnthropicRateLimits {
  requestsLimit: number;
  requestsRemaining: number;
  requestsReset: string;
  tokensLimit: number;
  tokensRemaining: number;
  tokensReset: string;
}

export interface AnthropicDailyBucket {
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface AnthropicHourlyBucket {
  hour: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AnthropicCostEntry {
  date: string;
  amountCents: number;
  description: string;
}

export interface AnthropicUsageData {
  isConfigured: boolean;
  rateLimits: AnthropicRateLimits | null;
  daily: AnthropicDailyBucket[] | null;
  hourly: AnthropicHourlyBucket[] | null;
  costs: AnthropicCostEntry[] | null;
}

export async function fetchAnthropicUsage(): Promise<AnthropicUsageData> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/api/anthropic-usage`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Bridge Anthropic usage error: ${res.status}`);
  return res.json();
}

// ── Build Status ──

export interface BuildRun {
  databaseId: number;
  status: string;       // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | null (when in_progress)
  createdAt: string;
  headBranch: string;
  name: string;
  url: string;
}

export interface BuildStatus {
  android: BuildRun[];
  ios: BuildRun[];
  cachedAt: number;
}

export async function fetchBuildStatus(): Promise<BuildStatus> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/api/build-status`);
  if (!res.ok) throw new Error(`Build status error: ${res.status}`);
  return res.json();
}


// ── Directive Artifacts ──

export interface DirectiveArtifact {
  artifactId: number;
  runId: number;
  platform: string;
  name: string;
  sizeBytes: number;
}

export async function fetchDirectiveArtifacts(
  id: string
): Promise<{ artifacts: DirectiveArtifact[] }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/directives/${id}/artifacts`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Bridge artifacts error: ${res.status}`);
  return res.json();
}



// ── Business Projects & Tasks ──
// (OSINT + Cedula sections removed — no UI consumers)


export interface TaskRequirement {
  id: string;
  label: string;
  description?: string;
  accepts?: string[];
  fulfilled: boolean;
  fulfilledBy: number | null;
}

export interface VerificationDetail {
  requirementId: string;
  met: boolean;
  confidence: number;
  explanation: string;
}

export interface AttachmentVerification {
  status: "verified" | "partial" | "rejected" | "unverified";
  verifiedAt: string;
  summary: string;
  documentType: string;
  matchedRequirements: string[];
  details: VerificationDetail[];
  issues: string[];
  suggestions: string[];
}

export interface BusinessTask {
  id: number;
  project_id: number;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "done";
  priority: "low" | "medium" | "high";
  position: number;
  due_date: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  phase: string;
  notes: string;
  attachment_count: number;
  expense_count: number;
  requirements: TaskRequirement[];
  estimated_cost: number | null;
  actual_cost: number | null;
  cost_category: string | null;
}

export interface BusinessAttachment {
  id: number;
  task_id: number;
  file_name: string;
  file_type: string;
  mime_type: string;
  file_size: number;
  verification: AttachmentVerification | null;
  receipt_data: ReceiptData | null;
  created_at: string;
}

export interface BusinessProject {
  id: number;
  name: string;
  description: string;
  emoji: string;
  color: string;
  status: "active" | "paused" | "completed" | "archived";
  position: number;
  task_count: number;
  done_count: number;
  in_progress_count: number;
  budget: number | null;
  currency: string;
  total_estimated: number;
  total_actual: number;
  created_at: string;
  updated_at: string;
  tasks?: BusinessTask[];
}

export async function fetchBusinessProjects(): Promise<BusinessProject[]> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/projects`);
  if (!res.ok) throw new Error(`Business projects error: ${res.status}`);
  return res.json();
}

export async function fetchBusinessProject(id: number): Promise<BusinessProject> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/projects/${id}`);
  if (!res.ok) throw new Error(`Business project error: ${res.status}`);
  return res.json();
}

export async function createBusinessProject(data: { name: string; description?: string; emoji?: string; color?: string }): Promise<{ ok: boolean; project: BusinessProject }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Create project error: ${res.status}`);
  return res.json();
}

export async function updateBusinessProject(id: number, updates: Partial<BusinessProject>): Promise<{ ok: boolean; project: BusinessProject }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`Update project error: ${res.status}`);
  return res.json();
}

export async function archiveBusinessProject(id: number): Promise<{ ok: boolean }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/projects/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Archive project error: ${res.status}`);
  return res.json();
}

export async function createBusinessTask(projectId: number, data: { title: string; description?: string; priority?: string; due_date?: string; phase?: string }): Promise<{ ok: boolean; task: BusinessTask }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/projects/${projectId}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Create task error: ${res.status}`);
  return res.json();
}

export async function updateBusinessTask(id: number, updates: Partial<BusinessTask>): Promise<{ ok: boolean; task: BusinessTask }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`Update task error: ${res.status}`);
  return res.json();
}

export async function deleteBusinessTask(id: number): Promise<{ ok: boolean }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/tasks/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete task error: ${res.status}`);
  return res.json();
}

export async function toggleBusinessTaskStatus(id: number): Promise<{ ok: boolean; task: BusinessTask }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/tasks/${id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Toggle task error: ${res.status}`);
  return res.json();
}

export async function fetchTaskAttachments(taskId: number): Promise<BusinessAttachment[]> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/tasks/${taskId}/attachments`);
  if (!res.ok) throw new Error(`Fetch attachments error: ${res.status}`);
  return res.json();
}

export async function uploadTaskAttachment(taskId: number, base64: string, fileName: string, fileType?: string): Promise<{ ok: boolean; attachment: BusinessAttachment }> {
  // Longer timeout for uploads — server runs Gemini verification which can take 30s+
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  const res = await fetch(`${BRIDGE_URL}/business/tasks/${taskId}/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base64, fileName, fileType }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
  if (!res.ok) throw new Error(`Upload attachment error: ${res.status}`);
  return res.json();
}

export async function deleteTaskAttachment(id: number): Promise<{ ok: boolean }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/attachments/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete attachment error: ${res.status}`);
  return res.json();
}

export function getAttachmentUrl(id: number, thumb?: boolean): string {
  return `${BRIDGE_URL}/business/attachments/${id}/file${thumb ? "?thumb=1" : ""}`;
}

export async function fetchTaskRequirements(taskId: number): Promise<{ requirements: TaskRequirement[]; fulfilled: number; total: number; status: string }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/tasks/${taskId}/requirements`);
  if (!res.ok) throw new Error(`Fetch requirements error: ${res.status}`);
  return res.json();
}

export async function reverifyAttachment(attachmentId: number): Promise<{ ok: boolean; verification: AttachmentVerification }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/attachments/${attachmentId}/reverify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Reverify error: ${res.status}`);
  return res.json();
}

// ── COP Formatting (re-export from lib/format for backwards compat) ──

export { formatCOP, formatCOPCompact } from "./format";

// ── Business Expenses & Financial Tracking ──

export interface ReceiptData {
  isReceipt?: boolean;
  amount: number;
  subtotal?: number;
  iva?: number;
  vendor?: string;
  date?: string;
  lineItems?: { description: string; quantity?: number; unitPrice?: number; total: number }[];
  paymentMethod?: string;
  documentNumber?: string;
  rawText?: string;
}

export interface BusinessExpense {
  id: number;
  task_id: number;
  attachment_id: number | null;
  amount: number;
  iva_amount: number;
  subtotal: number | null;
  category: string;
  vendor: string;
  description: string;
  payment_status: "pending" | "paid" | "partial" | "overdue";
  payment_method: string | null;
  expense_date: string;
  receipt_data: ReceiptData | null;
  verified: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProjectFinancials {
  budget: number | null;
  currency: string;
  totalEstimated: number;
  totalActual: number;
  totalIVA: number;
  verifiedTotal: number;
  unverifiedTotal: number;
  verifiedCount: number;
  unverifiedCount: number;
  byCategory: Record<string, number>;
  byPhase: Record<string, { estimated: number; actual: number; taskCount: number }>;
  byPaymentStatus: Record<string, { count: number; total: number }>;
  budgetUtilization: number | null;
}

export async function getTaskExpenses(taskId: number): Promise<BusinessExpense[]> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/tasks/${taskId}/expenses`);
  if (!res.ok) throw new Error(`Fetch expenses error: ${res.status}`);
  return res.json();
}

export async function createExpense(taskId: number, data: Partial<BusinessExpense>): Promise<{ ok: boolean; expense: BusinessExpense }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/tasks/${taskId}/expenses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Create expense error: ${res.status}`);
  return res.json();
}

export async function updateExpense(expenseId: number, data: Partial<BusinessExpense>): Promise<{ ok: boolean; expense: BusinessExpense }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/expenses/${expenseId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Update expense error: ${res.status}`);
  return res.json();
}

export async function deleteExpense(expenseId: number): Promise<{ ok: boolean }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/expenses/${expenseId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete expense error: ${res.status}`);
  return res.json();
}

export async function getProjectExpenses(projectId: number): Promise<BusinessExpense[]> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/projects/${projectId}/expenses`);
  if (!res.ok) throw new Error(`Fetch project expenses error: ${res.status}`);
  return res.json();
}

export async function createProjectExpense(projectId: number, data: Partial<BusinessExpense>): Promise<{ ok: boolean; expense: BusinessExpense }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/projects/${projectId}/expenses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Create project expense error: ${res.status}`);
  return res.json();
}

export async function getProjectFinancials(projectId: number): Promise<ProjectFinancials> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/projects/${projectId}/financials`);
  if (!res.ok) throw new Error(`Fetch financials error: ${res.status}`);
  return res.json();
}

export async function extractReceipt(attachmentId: number): Promise<{ ok: boolean; receiptData?: ReceiptData }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/attachments/${attachmentId}/extract-receipt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Extract receipt error: ${res.status}`);
  return res.json();
}

// ── CEO Command Center Types ──

export interface BusinessContact {
  id: number;
  name: string;
  company: string | null;
  type: "buyer" | "supplier" | "logistics" | "broker" | "other";
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  country: string;
  currency: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessShipment {
  id: number;
  project_id: number | null;
  buyer_contact_id: number | null;
  buyer_name?: string;
  buyer_company?: string;
  reference: string | null;
  status: "preparing" | "customs_clearance" | "in_transit" | "arrived" | "delivered" | "paid";
  coffee_type: string | null;
  quantity_kg: number | null;
  bags_count: number | null;
  price_per_kg: number | null;
  total_value: number | null;
  currency: string;
  shipping_cost: number;
  insurance_cost: number;
  customs_fees: number;
  origin_port: string;
  destination_port: string;
  ship_date: string | null;
  estimated_arrival: string | null;
  actual_arrival: string | null;
  tracking_number: string | null;
  vessel_name: string | null;
  notes: string | null;
  invoices?: BusinessInvoice[];
  created_at: string;
  updated_at: string;
}

export interface BusinessInvoice {
  id: number;
  shipment_id: number | null;
  contact_id: number | null;
  contact_name?: string;
  invoice_number: string | null;
  amount: number;
  currency: string;
  status: "draft" | "sent" | "paid" | "partial" | "overdue" | "cancelled";
  issue_date: string | null;
  due_date: string | null;
  paid_date: string | null;
  paid_amount: number;
  payment_method: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessInvestment {
  id: number;
  project_id: number | null;
  title: string;
  description: string | null;
  category: "equipment" | "infrastructure" | "inventory" | "marketing" | "certification" | "logistics" | "other";
  amount: number;
  currency: string;
  status: "planned" | "committed" | "paid" | "recovered";
  investment_date: string | null;
  expected_return_date: string | null;
  roi_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface DashboardMetrics {
  totalRevenue: number;
  totalExpenses: number;
  netPL: number;
  activeShipments: number;
  shipmentsByStatus: Record<string, number>;
  pendingPayments: number;
  pendingPaymentAmount: number;
  topBuyers: { name: string; company: string | null; revenue: number }[];
  totalInvestments: number;
  investmentsByStatus: Record<string, { count: number; total: number }>;
  periodLabel: string;
  previousPeriodPL: number | null;
}

// ── CEO Command Center API Functions ──

// Contacts
export async function fetchBusinessContacts(type?: string): Promise<BusinessContact[]> {
  const q = type ? `?type=${type}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/contacts${q}`);
  if (!res.ok) throw new Error(`Fetch contacts error: ${res.status}`);
  return res.json();
}

export async function createBusinessContact(data: Partial<BusinessContact>): Promise<{ ok: boolean; contact: BusinessContact }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/contacts`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Create contact error: ${res.status}`);
  return res.json();
}

export async function updateBusinessContact(id: number, data: Partial<BusinessContact>): Promise<{ ok: boolean; contact: BusinessContact }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/contacts/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Update contact error: ${res.status}`);
  return res.json();
}

export async function deleteBusinessContact(id: number): Promise<{ ok: boolean }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/contacts/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete contact error: ${res.status}`);
  return res.json();
}

// Shipments
export async function fetchBusinessShipments(status?: string): Promise<BusinessShipment[]> {
  const q = status ? `?status=${status}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/shipments${q}`);
  if (!res.ok) throw new Error(`Fetch shipments error: ${res.status}`);
  return res.json();
}

export async function fetchBusinessShipment(id: number): Promise<BusinessShipment> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/shipments/${id}`);
  if (!res.ok) throw new Error(`Fetch shipment error: ${res.status}`);
  return res.json();
}

export async function createBusinessShipment(data: Partial<BusinessShipment>): Promise<{ ok: boolean; shipment: BusinessShipment }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/shipments`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Create shipment error: ${res.status}`);
  return res.json();
}

export async function updateBusinessShipment(id: number, data: Partial<BusinessShipment>): Promise<{ ok: boolean; shipment: BusinessShipment }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/shipments/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Update shipment error: ${res.status}`);
  return res.json();
}

export async function updateShipmentStatus(id: number, status: string): Promise<{ ok: boolean; shipment: BusinessShipment }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/shipments/${id}/status`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`Update shipment status error: ${res.status}`);
  return res.json();
}

export async function deleteBusinessShipment(id: number): Promise<{ ok: boolean }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/shipments/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete shipment error: ${res.status}`);
  return res.json();
}

// Invoices
export async function fetchBusinessInvoices(status?: string): Promise<BusinessInvoice[]> {
  const q = status ? `?status=${status}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/invoices${q}`);
  if (!res.ok) throw new Error(`Fetch invoices error: ${res.status}`);
  return res.json();
}

export async function createBusinessInvoice(data: Partial<BusinessInvoice>): Promise<{ ok: boolean; invoice: BusinessInvoice }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/invoices`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Create invoice error: ${res.status}`);
  return res.json();
}

export async function updateBusinessInvoice(id: number, data: Partial<BusinessInvoice>): Promise<{ ok: boolean; invoice: BusinessInvoice }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/invoices/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Update invoice error: ${res.status}`);
  return res.json();
}

export async function deleteBusinessInvoice(id: number): Promise<{ ok: boolean }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/invoices/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete invoice error: ${res.status}`);
  return res.json();
}

// Investments
export async function fetchBusinessInvestments(): Promise<BusinessInvestment[]> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/investments`);
  if (!res.ok) throw new Error(`Fetch investments error: ${res.status}`);
  return res.json();
}

export async function createBusinessInvestment(data: Partial<BusinessInvestment>): Promise<{ ok: boolean; investment: BusinessInvestment }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/investments`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Create investment error: ${res.status}`);
  return res.json();
}

export async function updateBusinessInvestment(id: number, data: Partial<BusinessInvestment>): Promise<{ ok: boolean; investment: BusinessInvestment }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/investments/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Update investment error: ${res.status}`);
  return res.json();
}

export async function deleteBusinessInvestment(id: number): Promise<{ ok: boolean }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/investments/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete investment error: ${res.status}`);
  return res.json();
}

// Dashboard
export async function fetchDashboardMetrics(period?: string): Promise<DashboardMetrics> {
  const q = period ? `?period=${period}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/business/dashboard${q}`);
  if (!res.ok) throw new Error(`Fetch dashboard error: ${res.status}`);
  return res.json();
}

// ── Backup API ──

export interface BackupInfo {
  filename: string;
  size: number;
  sizeHuman: string;
  encrypted: boolean;
  timestamp: string;
  createdAt: string;
}

export interface BackupListResponse {
  backups: BackupInfo[];
  total: number;
  cronEnabled: boolean;
  backupDir: string;
}

export interface BackupStatus {
  healthy: boolean;
  cronEnabled: boolean;
  lastBackup: string | null;
  lastBackupAgeHours: number | null;
  totalBackups: number;
}

export async function fetchBackups(): Promise<BackupListResponse> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/api/backups`);
  if (!res.ok) throw new Error(`Fetch backups error: ${res.status}`);
  return res.json();
}

export async function triggerBackup(): Promise<{ ok: boolean; file: string; size: string; checksum: string }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/api/backups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }, 120000);
  if (!res.ok) throw new Error(`Trigger backup error: ${res.status}`);
  return res.json();
}

export async function fetchBackupStatus(): Promise<BackupStatus> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/api/backups/status`);
  if (!res.ok) throw new Error(`Backup status error: ${res.status}`);
  return res.json();
}

export function getBackupDownloadUrl(filename: string): string {
  return `${BRIDGE_URL}/api/backups/${encodeURIComponent(filename)}/download`;
}

export async function deleteBackup(filename: string): Promise<{ ok: boolean }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/api/backups/${encodeURIComponent(filename)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Delete backup error: ${res.status}`);
  return res.json();
}

// ── Personal File Storage (Dropbox-style) ──

export interface StoredFile {
  id: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  source: string;
  category: string;
  metadata: Record<string, any>;
  is_temp: boolean;
  created_at: string;
}

export async function uploadFile(data: string, opts?: {
  filename?: string;
  mime_type?: string;
  source?: string;
  category?: string;
  metadata?: Record<string, any>;
}): Promise<{ ok: boolean; file: StoredFile }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data, ...opts }),
  });
  if (!res.ok) throw new Error(`Upload file error: ${res.status}`);
  return res.json();
}

export async function fetchFiles(filters?: {
  category?: string;
  source?: string;
  limit?: number;
  offset?: number;
  folder_id?: string;
}): Promise<{ files: StoredFile[]; total: number; storageTotalBytes?: number }> {
  const params = new URLSearchParams();
  if (filters?.category) params.set("category", filters.category);
  if (filters?.source) params.set("source", filters.source);
  if (filters?.limit) params.set("limit", String(filters.limit));
  if (filters?.offset) params.set("offset", String(filters.offset));
  if (filters?.folder_id !== undefined) params.set("folder_id", filters.folder_id);
  const qs = params.toString() ? `?${params}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/files${qs}`);
  if (!res.ok) throw new Error(`Fetch files error: ${res.status}`);
  return res.json();
}

export function getFileDataUrl(fileId: number): string {
  return `${BRIDGE_URL}/files/${fileId}/data`;
}

export async function deleteFile(fileId: number): Promise<{ ok: boolean }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/files/${fileId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete file error: ${res.status}`);
  return res.json();
}

export async function bridgeShare(data: string, filename?: string, mimeType?: string): Promise<{
  ok: boolean;
  shareUrl: string;
  fileId: number;
  expiresAt: string;
}> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/files/bridge-share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data, filename, mime_type: mimeType }),
  });
  if (!res.ok) throw new Error(`Bridge share error: ${res.status}`);
  return res.json();
}

export async function sendToIntel(data: string, label?: string): Promise<{
  ok: boolean;
  matches: Array<{ name?: string; score?: number; source_url?: string }>;
  osintScan: any;
  message: string;
}> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/files/send-to-intel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data, label }),
  });
  if (!res.ok) throw new Error(`Send to intel error: ${res.status}`);
  return res.json();
}


// Multi-currency formatting
export function formatCurrency(amount: number | null | undefined, currency: string = "COP"): string {
  if (amount == null || isNaN(amount)) return currency === "JPY" ? "\u00a50" : "$0";
  const rounded = Math.round(amount);
  if (currency === "JPY") return "\u00a5" + rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (currency === "USD") return "$" + rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return "$" + rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

// ── SECOP II — Colombian public-procurement opportunities (dir_1784393004608) ──
export interface Licitacion {
  id_proceso: string;
  referencia: string | null;
  entidad: string | null;
  departamento: string | null;
  ciudad: string | null;
  nombre: string | null;
  descripcion?: string | null;
  modalidad: string | null;
  estado_resumen: string | null;
  precio_base: number | string | null;
  fecha_publicacion: string | null;
  fecha_recepcion: string | null;
  unspsc_code: string | null;
  segment_code: string | null;
  segment_name: string | null;
  overlay_categories: string[];
  url_proceso: string | null;
  is_open: boolean;
  linked_venture_id: number | null;
  competitividad?: Competitividad;
  family_display?: string | null;
}
export interface Competitividad {
  score: number;
  label: string;
  single_rate: number;
  avg_bidders: number | null;
  adjudicated_total: number;
  basis: "entidad" | "modalidad";
}
export interface LicitacionListResult { total: number; limit: number; offset: number; items: Licitacion[]; }
export interface SecopCategory { name?: string; segment_code?: string; segment_name?: string; count: number; total_value: number | string; }

export async function fetchLicitaciones(params: Record<string, string | number | boolean | undefined> = {}): Promise<LicitacionListResult> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  return apiFetch(`/secop/licitaciones?${qs.toString()}`);
}
export async function fetchLicitacion(id: string): Promise<Licitacion> {
  return apiFetch(`/secop/licitaciones/${encodeURIComponent(id)}`);
}
export async function fetchSecopCategories(): Promise<{ unspsc: SecopCategory[]; overlay: SecopCategory[] }> {
  return apiFetch(`/secop/categories`);
}
export async function fetchSecopStats(): Promise<any> {
  return apiFetch(`/secop/stats`);
}
export async function createVentureFromLicitacion(id: string): Promise<{ ok: boolean; created: boolean; venture_id: number; task_count?: number }> {
  return apiFetch(`/secop/licitaciones/${encodeURIComponent(id)}/create-venture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
}

export interface TenderDetail {
  status?: string;
  objeto: string | null;
  valor_estimado: string | null;
  plazo_ejecucion: string | null;
  lugar_ejecucion: string | null;
  cronograma: { hito: string; fecha: string }[];
  habilitantes: { juridicos?: string[]; financieros?: string[]; tecnicos?: string[]; experiencia?: string[] };
  evaluacion: { factor: string; puntaje: string }[];
  especificaciones: string[];
  obligaciones: string[];
  garantias: { tipo: string; porcentaje: string; vigencia: string }[];
  documentos: { name: string; ext: string; size: number; url: string }[];
  model?: string | null;
  brief?: ProposalBrief;
}
export interface ProposalBrief {
  que_es?: string;
  implicaciones_tecnicas?: { resumen?: string; requiere?: string[]; riesgos?: string[] };
  implicaciones_financieras?: { resumen?: string; costos_clave?: string[]; consideracion?: string };
  recomendacion?: { decision?: string; razon?: string };
}
export async function decideOffer(id: string, decision: "accepted" | "rejected" | "pending"): Promise<{ ok: boolean }> {
  return apiFetch(`/secop/licitaciones/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
}
export async function fetchTenderDetail(id: string): Promise<{ status: "ready" | "building" | "error"; detail?: TenderDetail; previous_error?: string | null }> {
  return apiFetch(`/secop/licitaciones/${encodeURIComponent(id)}/detail`);
}
