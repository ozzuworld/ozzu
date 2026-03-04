// HTTP client for the Command Bridge server

const LAN_URL =
  process.env.EXPO_PUBLIC_BRIDGE_URL || "http://localhost:3333";
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

/** Get auth headers when using public URL */
function getAuthHeaders(): Record<string, string> {
  if (getBridgeMode() === "remote" && BRIDGE_API_KEY) {
    return { "Authorization": `Bearer ${BRIDGE_API_KEY}` };
  }
  return {};
}

function fetchWithTimeout(url: string, opts?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  // Inject auth headers for public requests
  const authHeaders = getAuthHeaders();
  const mergedHeaders = { ...authHeaders, ...(opts?.headers || {}) };
  return fetch(url, { ...opts, headers: mergedHeaders, signal: controller.signal }).finally(() => clearTimeout(timer));
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

export async function deployArtifact(
  artifactId: number
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/api/artifacts/${artifactId}/deploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Bridge deploy artifact error: ${res.status}`);
  return res.json();
}

// ── OSINT Types ──

export interface OsintProfile {
  id: number;
  label: string;
  profile_type: "email" | "username" | "password" | "phone" | "domain";
  value: string;
  tags: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface OsintScan {
  id: number;
  profile_id: number;
  scan_type: string;
  status: "pending" | "running" | "completed" | "failed";
  modules_run: string[];
  findings_count: number;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface OsintFinding {
  id: number;
  scan_id: number;
  profile_id: number;
  module: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  description: string | null;
  source_url: string | null;
  raw_data: any;
  status: "new" | "acknowledged" | "remediated" | "false_positive";
  remediation: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExposureScore {
  score: number;
  breakdown: Record<string, number>;
  totalFindings: number;
}

// ── OSINT API ──

export async function createOsintProfile(
  label: string,
  profileType: string,
  value: string,
  tags?: string[]
): Promise<{ ok: boolean; profile: OsintProfile }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, profileType, value, tags }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `Create profile failed: ${res.status}`);
  }
  return res.json();
}

export async function uploadOsintImage(
  label: string,
  base64: string,
  filename?: string
): Promise<{ ok: boolean; profile: OsintProfile; image: any }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/images/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, base64, filename }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `Image upload failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchOsintProfiles(): Promise<OsintProfile[]> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/profiles`);
  if (!res.ok) throw new Error(`OSINT profiles error: ${res.status}`);
  return res.json();
}

export async function deleteOsintProfile(id: number): Promise<{ ok: boolean }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/profiles/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Delete profile error: ${res.status}`);
  return res.json();
}

export async function triggerOsintScan(
  profileId: number,
  scanType?: string
): Promise<{ ok: boolean; scanId: number; modulesQueued: string[] }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId, scanType }),
  });
  if (!res.ok) throw new Error(`Trigger scan error: ${res.status}`);
  return res.json();
}

export async function fetchOsintScan(
  scanId: number
): Promise<{ scan: OsintScan; findings: OsintFinding[] }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/scan/${scanId}`);
  if (!res.ok) throw new Error(`Fetch scan error: ${res.status}`);
  return res.json();
}

export async function fetchOsintFindings(filters?: {
  severity?: string;
  category?: string;
  status?: string;
  profileId?: number;
  limit?: number;
  offset?: number;
}): Promise<OsintFinding[]> {
  const params = new URLSearchParams();
  if (filters?.severity) params.set("severity", filters.severity);
  if (filters?.category) params.set("category", filters.category);
  if (filters?.status) params.set("status", filters.status);
  if (filters?.profileId) params.set("profileId", String(filters.profileId));
  if (filters?.limit) params.set("limit", String(filters.limit));
  if (filters?.offset) params.set("offset", String(filters.offset));
  const qs = params.toString();
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/findings${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Fetch findings error: ${res.status}`);
  return res.json();
}

export async function updateOsintFinding(
  id: number,
  status: string
): Promise<{ ok: boolean; finding: OsintFinding }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/findings/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`Update finding error: ${res.status}`);
  return res.json();
}

export async function bulkUpdateOsintFindings(body: {
  status: string;
  findingIds?: number[];
  severity?: string;
  module?: string;
  currentStatus?: string;
}): Promise<{ ok: boolean; updated: number }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/findings/bulk`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Bulk update findings error: ${res.status}`);
  return res.json();
}

export async function fetchOsintScore(): Promise<ExposureScore> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/score`);
  if (!res.ok) throw new Error(`Fetch score error: ${res.status}`);
  return res.json();
}

export async function triggerOsintScanAll(): Promise<{
  ok: boolean;
  scans: Array<{ profileId: number; label: string; scanId?: number; error?: string }>;
  profilesScanned: number;
}> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/scan-all`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Scan-all error: ${res.status}`);
  return res.json();
}

export interface ScoreHistoryEntry {
  id: number;
  score: number;
  breakdown: Record<string, number>;
  total_findings: number;
  profiles_scanned: number;
  recorded_at: string;
}

export async function fetchOsintScoreHistory(
  days?: number
): Promise<ScoreHistoryEntry[]> {
  const qs = days ? `?days=${days}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/score/history${qs}`);
  if (!res.ok) throw new Error(`Score history error: ${res.status}`);
  return res.json();
}

export interface ScanSchedule {
  enabled: boolean;
  intervalMs: number;
  intervalHours: number;
  lastScanAt: string | null;
}

export async function fetchOsintSchedule(): Promise<ScanSchedule> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/schedule`);
  if (!res.ok) throw new Error(`Fetch schedule error: ${res.status}`);
  return res.json();
}

export async function setOsintSchedule(
  intervalHours: number
): Promise<{ ok: boolean; message: string; schedule: ScanSchedule }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/schedule`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intervalHours }),
  });
  if (!res.ok) throw new Error(`Set schedule error: ${res.status}`);
  return res.json();
}

// ── OSINT Entity/Graph Types ──

export interface OsintEntity {
  id: number;
  entity_type: string;
  value: string;
  label: string | null;
  metadata: Record<string, any>;
  source_module: string | null;
  source_finding_id: number | null;
  profile_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface OsintRelationship {
  id: number;
  source_entity_id: number;
  target_entity_id: number;
  relationship: string;
  confidence: number;
  source_module: string | null;
  evidence: string | null;
  source_type?: string;
  source_value?: string;
  source_label?: string;
  target_type?: string;
  target_value?: string;
  target_label?: string;
  created_at: string;
  updated_at: string;
}

export interface OsintCorrelationSummary {
  totalEntities: number;
  totalRelationships: number;
  entityTypes: Record<string, number>;
  relationshipTypes: Record<string, number>;
}

export interface OsintGraph {
  entities: OsintEntity[];
  relationships: OsintRelationship[];
  summary: OsintCorrelationSummary;
}

export interface OsintReport {
  markdown: string;
  json: {
    profile: OsintProfile | null;
    summary: { critical: number; high: number; medium: number; low: number; info: number; totalEntities: number; totalRelationships: number };
    findings: OsintFinding[];
    entities: OsintEntity[];
    relationships: OsintRelationship[];
    remediation: string[];
  };
}

export async function fetchOsintGraph(profileId?: number): Promise<OsintGraph> {
  const path = profileId ? `/osint/graph/${profileId}` : "/osint/graph";
  const res = await fetchWithTimeout(`${BRIDGE_URL}${path}`);
  if (!res.ok) throw new Error(`Graph error: ${res.status}`);
  return res.json();
}

export async function fetchOsintEntities(type?: string, profileId?: number): Promise<OsintEntity[]> {
  const params = new URLSearchParams();
  if (type) params.set("type", type);
  if (profileId) params.set("profileId", String(profileId));
  const qs = params.toString() ? `?${params}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/entities${qs}`);
  if (!res.ok) throw new Error(`Entities error: ${res.status}`);
  const data = await res.json();
  return data.entities || [];
}

export async function fetchOsintEntityNeighbors(entityId: number): Promise<{ entity: OsintEntity; relationships: OsintRelationship[] }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/entities/${entityId}/neighbors`);
  if (!res.ok) throw new Error(`Entity neighbors error: ${res.status}`);
  return res.json();
}

export async function fetchOsintReport(profileId?: number): Promise<OsintReport> {
  const path = profileId ? `/osint/report/${profileId}` : "/osint/report";
  const res = await fetchWithTimeout(`${BRIDGE_URL}${path}`);
  if (!res.ok) throw new Error(`Report error: ${res.status}`);
  const data = await res.json();
  return data.report;
}

// ── OSINT Cross-Profile Correlations ──

export interface OsintCorrelation {
  id: number;
  source_profile_id: number;
  target_profile_id: number;
  correlation_type: string;
  confidence: number;
  evidence: Record<string, any>;
  source_label?: string;
  source_type?: string;
  source_value?: string;
  target_label?: string;
  target_type?: string;
  target_value?: string;
  created_at: string;
  updated_at: string;
}

export async function triggerOsintCorrelation(): Promise<{ ok: boolean; message: string }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/correlate`, { method: "POST" });
  if (!res.ok) throw new Error(`Correlate error: ${res.status}`);
  return res.json();
}

export async function fetchOsintCorrelations(filters?: {
  minConfidence?: number;
  type?: string;
  profileId?: number;
  limit?: number;
}): Promise<OsintCorrelation[]> {
  const params = new URLSearchParams();
  if (filters?.minConfidence) params.set("minConfidence", String(filters.minConfidence));
  if (filters?.type) params.set("type", filters.type);
  if (filters?.profileId) params.set("profileId", String(filters.profileId));
  if (filters?.limit) params.set("limit", String(filters.limit));
  const qs = params.toString() ? `?${params}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/correlations${qs}`);
  if (!res.ok) throw new Error(`Correlations error: ${res.status}`);
  const data = await res.json();
  return data.correlations || [];
}

// ── OSINT Stored Reports ──

export interface StoredReportSummary {
  id: number;
  title: string;
  report_type: string;
  profiles_included: number[];
  total_findings: number;
  score_at_generation: number;
  created_at: string;
}

export interface StoredReport extends StoredReportSummary {
  data: OsintReport;
}

export async function generateStoredReport(opts?: {
  title?: string;
  type?: string;
  profileIds?: number[];
}): Promise<StoredReport> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts || {}),
  });
  if (!res.ok) throw new Error(`Generate report error: ${res.status}`);
  const data = await res.json();
  return data.report;
}

export async function fetchStoredReports(limit?: number): Promise<StoredReportSummary[]> {
  const qs = limit ? `?limit=${limit}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/reports${qs}`);
  if (!res.ok) throw new Error(`Reports list error: ${res.status}`);
  const data = await res.json();
  return data.reports || [];
}

export async function fetchStoredReport(id: number): Promise<StoredReport> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/reports/${id}`);
  if (!res.ok) throw new Error(`Report detail error: ${res.status}`);
  const data = await res.json();
  return data.report;
}

// ── OSINT Metrics ──

export interface OsintMetricsSummary {
  ok: boolean;
  summary: { totalScans: number; avgDuration: number; totalScoreDelta: number };
  timeToLockdown: number | null;
  coverage: {
    totalProfiles: number;
    correlationCoverage: number;
    locationCoverage: number;
    profilesWithCorrelation: number;
    profilesWithLocation: number;
  };
}

export async function fetchOsintMetrics(days?: number): Promise<OsintMetricsSummary> {
  const qs = days ? `?days=${days}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/metrics${qs}`);
  if (!res.ok) throw new Error(`Metrics error: ${res.status}`);
  return res.json();
}

export async function fetchOsintMetricsTimeline(days?: number, metricType?: string): Promise<{ ok: boolean; metrics: any[]; metricType: string; days: number }> {
  const params = new URLSearchParams();
  if (days) params.set("days", String(days));
  if (metricType) params.set("type", metricType);
  const qs = params.toString() ? `?${params}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/metrics/timeline${qs}`);
  if (!res.ok) throw new Error(`Metrics timeline error: ${res.status}`);
  return res.json();
}

export interface ModuleMetric {
  name: string;
  scans: number;
  avgDuration: number;
  totalFindings: number;
  successRate: number;
  errors: number;
}

export async function fetchOsintModuleMetrics(days?: number): Promise<{ ok: boolean; modules: ModuleMetric[] }> {
  const qs = days ? `?days=${days}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/metrics/modules${qs}`);
  if (!res.ok) throw new Error(`Module metrics error: ${res.status}`);
  return res.json();
}

// ── OSINT Locations ──

export interface OsintLocation {
  id: number;
  profile_id: number;
  latitude: number | null;
  longitude: number | null;
  location_text: string | null;
  source_module: string | null;
  source_finding_id: number | null;
  confidence: number;
  location_type: string | null;
  raw_data: Record<string, any>;
  created_at: string;
}

export interface LocationCluster {
  label: string | null;
  locations: OsintLocation[];
  confidence: number;
  sources: number;
}

export async function fetchOsintLocations(profileId?: number): Promise<{ ok: boolean; locations: OsintLocation[]; clusters: LocationCluster[] }> {
  const path = profileId ? `/osint/locations/${profileId}` : "/osint/locations";
  const res = await fetchWithTimeout(`${BRIDGE_URL}${path}`);
  if (!res.ok) throw new Error(`Locations error: ${res.status}`);
  return res.json();
}

// ── OSINT Readiness ──

export interface OsintReadiness {
  ok: boolean;
  readiness: number;
  components: {
    exposure: number;
    correlation: number;
    location: number;
    freshness: number;
    moduleHealth: number;
  };
}

export async function fetchOsintReadiness(): Promise<OsintReadiness> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/readiness`);
  if (!res.ok) throw new Error(`Readiness error: ${res.status}`);
  return res.json();
}

// ── OSINT Alerts (Epic 6) ──

export interface OsintAlert {
  id: number;
  profile_id: number | null;
  alert_type: string;
  severity: string;
  title: string;
  description: string | null;
  finding_id: number | null;
  is_read: boolean;
  created_at: string;
  profile_label?: string;
}

export async function fetchOsintAlerts(opts?: { unreadOnly?: boolean; profileId?: number; limit?: number }): Promise<OsintAlert[]> {
  const parts: string[] = [];
  if (opts?.unreadOnly) parts.push("unreadOnly=true");
  if (opts?.profileId) parts.push(`profileId=${opts.profileId}`);
  if (opts?.limit) parts.push(`limit=${opts.limit}`);
  const qs = parts.length > 0 ? `?${parts.join("&")}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/alerts${qs}`);
  if (!res.ok) throw new Error(`Alerts error: ${res.status}`);
  const data = await res.json();
  return data.alerts || [];
}

export async function markOsintAlertRead(id: number): Promise<void> {
  await fetchWithTimeout(`${BRIDGE_URL}/osint/alerts/${id}`, { method: "PATCH" });
}

export async function markAllOsintAlertsRead(): Promise<void> {
  await fetchWithTimeout(`${BRIDGE_URL}/osint/alerts/read-all`, { method: "POST" });
}

export async function fetchOsintUnreadAlertCount(): Promise<number> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/alerts/unread-count`);
  if (!res.ok) return 0;
  const data = await res.json();
  return data.count || 0;
}

// ── OSINT Remediations (Epic 7) ──

export interface OsintRemediation {
  id: number;
  finding_id: number | null;
  profile_id: number;
  remediation_type: string;
  title: string;
  description: string | null;
  action_url: string | null;
  action_type: string;
  priority: number;
  status: string;
  completed_at: string | null;
  created_at: string;
  finding_title?: string;
  finding_severity?: string;
  finding_module?: string;
  profile_label?: string;
  profile_type?: string;
}

export interface OsintRemediationStats {
  total: number;
  pending: number;
  in_progress: number;
  completed: number;
  dismissed: number;
  byPriority: Record<string, { total: number; pending: number; completed: number }>;
}

export async function fetchOsintRemediations(profileId: number, status?: string): Promise<OsintRemediation[]> {
  const qs = status ? `?status=${status}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/remediations/${profileId}${qs}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.remediations || [];
}

export async function updateOsintRemediation(id: number, updates: { status?: string; priority?: number }): Promise<OsintRemediation | null> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/remediations/item/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.remediation;
}

export async function fetchOsintRemediationStats(profileId: number): Promise<OsintRemediationStats> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/remediations/${profileId}/stats`);
  if (!res.ok) return { total: 0, pending: 0, completed: 0, dismissed: 0 };
  const data = await res.json();
  return data.stats;
}

export async function generateOsintRemediations(profileId: number): Promise<{ generated: number; remediations: OsintRemediation[] }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/remediations/${profileId}/generate`, { method: "POST" });
  if (!res.ok) return { generated: 0, remediations: [] };
  const data = await res.json();
  return { generated: data.generated || 0, remediations: data.remediations || [] };
}

export async function fetchAllOsintRemediations(opts?: { status?: string; priority?: number; profileId?: number; limit?: number }): Promise<OsintRemediation[]> {
  const params = new URLSearchParams();
  if (opts?.status) params.set("status", opts.status);
  if (opts?.priority) params.set("priority", String(opts.priority));
  if (opts?.profileId) params.set("profileId", String(opts.profileId));
  if (opts?.limit) params.set("limit", String(opts.limit));
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/remediations${qs}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.remediations || [];
}

export async function fetchAllOsintRemediationStats(profileId?: number): Promise<OsintRemediationStats> {
  const qs = profileId ? `?profileId=${profileId}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/remediations/stats${qs}`);
  if (!res.ok) return { total: 0, pending: 0, in_progress: 0, completed: 0, dismissed: 0, byPriority: {} };
  const data = await res.json();
  return data.stats;
}

export async function generateAllOsintRemediations(): Promise<{ generated: number }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/remediations/generate`, { method: "POST" });
  if (!res.ok) return { generated: 0 };
  return res.json();
}

// ── OSINT SOC Incidents (Compliance) ──

export interface OsintIncident {
  id: number;
  incident_id: string;
  title: string;
  description: string | null;
  severity: string;
  category: string;
  status: string;
  profile_id: number | null;
  finding_ids: number[];
  remediation_ids: number[];
  nist_phase: string;
  classification: string;
  affected_assets: string[];
  attack_vector: string | null;
  indicators: Record<string, any>;
  timeline: Array<{ timestamp: string; action: string; actor: string; details?: string }>;
  assigned_to: string | null;
  escalated: boolean;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  profile_label?: string;
  profile_type?: string;
}

export interface OsintIncidentStats {
  total: number;
  open: number;
  investigating: number;
  contained: number;
  resolved: number;
  bySeverity: Record<string, number>;
}

export async function fetchOsintIncidents(filters?: { status?: string; severity?: string; profileId?: number }): Promise<OsintIncident[]> {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.severity) params.set("severity", filters.severity);
  if (filters?.profileId) params.set("profileId", String(filters.profileId));
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/incidents${qs}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.incidents || [];
}

export async function createOsintIncident(data: { title: string; category: string; severity?: string; description?: string; profileId?: number; findingIds?: number[] }): Promise<OsintIncident | null> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/incidents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.incident;
}

export async function updateOsintIncident(id: number, updates: { status?: string; severity?: string; nistPhase?: string; assignedTo?: string; escalated?: boolean; timelineAction?: string; actor?: string }): Promise<OsintIncident | null> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/incidents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.incident;
}

export async function fetchOsintIncidentStats(): Promise<OsintIncidentStats> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/incidents/stats`);
  if (!res.ok) return { total: 0, open: 0, investigating: 0, contained: 0, resolved: 0, bySeverity: {} };
  const data = await res.json();
  return data.stats;
}

export async function generateOsintIncidents(): Promise<number> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/incidents/generate`, { method: "POST" });
  if (!res.ok) return 0;
  const data = await res.json();
  return data.generated || 0;
}

export async function fetchOsintComplianceReport(): Promise<any> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/compliance/report`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.report;
}

// ── OSINT Groups (Epic 6) ──

export interface OsintGroup {
  id: number;
  name: string;
  emoji: string;
  description: string | null;
  member_count: number;
  created_at: string;
}

export async function createOsintGroup(data: { name: string; emoji?: string; description?: string }): Promise<OsintGroup> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/groups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const json = await res.json();
  return json.group;
}

export async function fetchOsintGroups(): Promise<OsintGroup[]> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/groups`);
  if (!res.ok) throw new Error(`Groups error: ${res.status}`);
  const data = await res.json();
  return data.groups || [];
}

export async function updateOsintGroup(id: number, updates: Partial<OsintGroup>): Promise<OsintGroup> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/groups/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  const json = await res.json();
  return json.group;
}

export async function deleteOsintGroup(id: number): Promise<void> {
  await fetchWithTimeout(`${BRIDGE_URL}/osint/groups/${id}`, { method: "DELETE" });
}

export async function assignProfileToGroup(profileId: number, groupId: number | null): Promise<void> {
  await fetchWithTimeout(`${BRIDGE_URL}/osint/profiles/${profileId}/group`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groupId }),
  });
}

export async function fetchOsintGroupScore(groupId: number): Promise<{ score: number; breakdown: Record<string, number>; totalFindings: number }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/groups/${groupId}/score`);
  if (!res.ok) throw new Error(`Group score error: ${res.status}`);
  return res.json();
}

export async function fetchOsintGroupFindings(groupId: number, limit?: number): Promise<OsintFinding[]> {
  const qs = limit ? `?limit=${limit}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/groups/${groupId}/findings${qs}`);
  if (!res.ok) throw new Error(`Group findings error: ${res.status}`);
  const data = await res.json();
  return data.findings || [];
}

// ── OSINT Tool Status (Epic 6) ──

export interface OsintToolStatus {
  containerRunning: boolean;
  tools: Record<string, { available: boolean; checkedAt: number; reason?: string }>;
}

export async function fetchOsintToolStatus(): Promise<OsintToolStatus> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/osint/tools/status`);
  if (!res.ok) throw new Error(`Tool status error: ${res.status}`);
  return res.json();
}

// ── Epics (integrated into directives — type="epic" with epicId/phaseOrder) ──

export interface EpicProgress {
  total: number;
  completed: number;
  inProgress: number;
  currentPhase: { id: string; title: string; status: string } | null;
  nextPhase: { id: string; title: string } | null;
  percent: number;
}

export async function fetchEpicProgress(epicId: string): Promise<EpicProgress> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/directives/${epicId}/progress`);
  if (!res.ok) throw new Error(`Fetch epic progress error: ${res.status}`);
  return res.json();
}

// ── Cédula Face DB ──

export interface CedulaFaceMatch {
  cedula: string;
  fullName: string | null;
  similarity: number;
  id?: number;
}

export interface CedulaSearchResult {
  matches: CedulaFaceMatch[];
  totalSearched: number;
  facesDetected: number;
}

export interface CedulaScanMatchResult {
  match: CedulaFaceMatch | null;
  profileId?: number;
  scanId?: number;
  message: string;
}

export async function searchCedulaFace(photoBase64: string, threshold?: number): Promise<CedulaSearchResult> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/cedula-db/search-face`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photoBase64, threshold }),
  });
  if (!res.ok) throw new Error(`Face search error: ${res.status}`);
  return res.json();
}

export async function scanMatchCedula(photoBase64: string, threshold?: number): Promise<CedulaScanMatchResult> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/cedula-db/scan-match`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photoBase64, threshold }),
  });
  if (!res.ok) throw new Error(`Scan-match error: ${res.status}`);
  return res.json();
}

export async function importCedulaFaces(records: Array<{ cedula: string; fullName?: string; photoBase64?: string; metadata?: any }>): Promise<{ ok: boolean; imported: number; results: any[] }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/cedula-db/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ records }),
  });
  if (!res.ok) throw new Error(`Import error: ${res.status}`);
  return res.json();
}

export interface CedulaFaceRecord {
  id: number;
  cedula: string;
  full_name: string | null;
  photo_path: string | null;
  metadata: any;
  created_at: string;
}

export async function fetchCedulaFaces(limit?: number, offset?: number): Promise<{ ok: boolean; count: number; records: CedulaFaceRecord[] }> {
  const params = new URLSearchParams();
  if (limit) params.set("limit", String(limit));
  if (offset) params.set("offset", String(offset));
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await fetchWithTimeout(`${BRIDGE_URL}/cedula-db/list${qs}`);
  if (!res.ok) throw new Error(`Fetch cedula faces error: ${res.status}`);
  return res.json();
}

export async function deleteCedulaFace(cedula: string): Promise<{ ok: boolean }> {
  const res = await fetchWithTimeout(`${BRIDGE_URL}/cedula-db/${cedula}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Delete cedula face error: ${res.status}`);
  return res.json();
}

// ── Business Projects & Tasks ──

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

// ── COP Formatting ──

export function formatCOP(amount: number | null | undefined): string {
  if (amount == null || isNaN(amount)) return "$0";
  const rounded = Math.round(amount);
  return "$" + rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export function formatCOPCompact(amount: number | null | undefined): string {
  if (amount == null || isNaN(amount)) return "$0";
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return sign + "$" + (abs / 1_000_000_000).toFixed(1) + "B";
  if (abs >= 1_000_000) return sign + "$" + (abs / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000) return sign + "$" + (abs / 1_000).toFixed(0) + "K";
  return sign + "$" + Math.round(abs);
}

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
  created_at: string;
  updated_at: string;
}

export interface ProjectFinancials {
  budget: number | null;
  currency: string;
  totalEstimated: number;
  totalActual: number;
  totalIVA: number;
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

// Multi-currency formatting
export function formatCurrency(amount: number | null | undefined, currency: string = "COP"): string {
  if (amount == null || isNaN(amount)) return currency === "JPY" ? "\u00a50" : "$0";
  const rounded = Math.round(amount);
  if (currency === "JPY") return "\u00a5" + rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (currency === "USD") return "$" + rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return "$" + rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
