// Deterministic sample data so every screen state is previewable without the
// bridge. Switch with ?state=attention | clear in the URL.
function pget() {
  try { return new URLSearchParams(location.search).get("state"); } catch { return null; }
}
const STATE = pget() || "clear";

const CLEAR = {
  directives: [
    { id: "dir_a", title: "June hand-off Step 2: liblinphone SIP into iOS app", status: "in_progress", emoji: "📲", buildRuns: [] },
    { id: "dir_b", title: "SOC convergence: diagnose step_queued < 50%", status: "in_progress", emoji: "🎯", buildRuns: [] },
    { id: "dir_c", title: "Antenna Tracker — 2-axis 3D-printed FPV tracker", status: "planning", emoji: "📡", buildRuns: [] },
  ],
  summary: {
    headline: "", completedToday: 3, completedThisWeek: 11,
    activeCount: 9, needsAttentionCount: 0, needsAttention: [],
    categories: {}, total: 41,
  },
  buildStatus: { android: [], ios: [{ status: "in_progress" }] },
};

const ATTENTION = {
  directives: [
    { id: "dir_x", title: "Bridge API is internet-public (BRIDGE_API_KEY empty)", status: "deploy_failed", emoji: "🔴", buildRuns: [] },
    { id: "dir_y", title: "June Live2D avatar — WebView with pixi-live2d", status: "deploy_failed", emoji: "🎭", buildRuns: [] },
    { id: "dir_z", title: "Distillation course-correct: reward + rescue trainer", status: "blocked", emoji: "🎯", buildRuns: [] },
  ],
  summary: {
    headline: "", completedToday: 1, completedThisWeek: 7,
    activeCount: 12, needsAttentionCount: 3,
    needsAttention: [
      { id: "dir_x", title: "Bridge API is internet-public (BRIDGE_API_KEY empty)", status: "deploy_failed", emoji: "🔴" },
      { id: "dir_y", title: "June Live2D avatar — WebView with pixi-live2d", status: "deploy_failed", emoji: "🎭" },
      { id: "dir_z", title: "Distillation course-correct: reward + rescue trainer", status: "blocked", emoji: "🎯" },
    ],
    categories: {}, total: 42,
  },
  buildStatus: { android: [], ios: [] },
};

const DATA = STATE === "attention" ? ATTENTION : CLEAR;

export function useDirectives() {
  return { ...DATA, loading: false, error: null, refresh: async () => {} };
}

export default useDirectives;
