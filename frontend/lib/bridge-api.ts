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
  buildRuns?: Array<{ platform: string; runId: number; triggeredAt: number; status: string; conclusion: string | null; url: string; lastChecked: number | null }>;
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

// ── Audio Preferences ──

export interface AudioDevice {
  deviceId: string;
  role: string;
  deviceType: string;
  zone: string;
  capabilities: { mic?: boolean; speaker?: boolean; cipherVoice?: boolean };
  speakerPriority: number;
  online: boolean;
  isActiveMic: boolean;
  isSelectedSpeaker: boolean;
}

export interface AudioPreferences {
  preferredInput: string | null;
  preferredOutputs: string[] | null;
  devices: AudioDevice[];
  activeMic: string | null;
  autoSelectedSpeaker: string | null;
  mode: "cipher" | "june" | "idle";
}

export async function fetchAudioPreferences(): Promise<AudioPreferences> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/audio-preferences`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Bridge audio preferences error: ${res.status}`);
  return res.json();
}

export async function setAudioPreferences(prefs: {
  preferredInput?: string | null;
  preferredOutputs?: string[] | null;
}): Promise<{ ok: boolean; preferences: { preferredInput: string | null; preferredOutputs: string[] | null } }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/audio-preferences`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(prefs),
  });
  if (!res.ok) throw new Error(`Bridge set audio preferences error: ${res.status}`);
  return res.json();
}
