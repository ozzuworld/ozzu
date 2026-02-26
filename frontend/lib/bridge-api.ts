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
