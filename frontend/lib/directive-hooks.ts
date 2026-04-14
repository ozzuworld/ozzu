// useDirectives — data hook for directive screen with WS push + HTTP polling fallback

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  fetchDirectives,
  fetchBuildStatus,
  fetchDirectiveSummary,
  type Directive,
  type BuildStatus,
  type DirectiveSummary,
} from "./bridge-api";

const BRIDGE_WS_URL =
  (process.env.EXPO_PUBLIC_BRIDGE_URL || "https://home.ozzu.world/bridge").replace(
    /^https/,
    "wss"
  ).replace(
    /^http/,
    "ws"
  ) + "/ws";

const POLL_INTERVAL_DEFAULT = 15000;
const POLL_INTERVAL_ACTIVE_BUILD = 10000;

export interface UseDirectivesResult {
  directives: Directive[];
  buildStatus: BuildStatus | null;
  summary: DirectiveSummary | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useDirectives(): UseDirectivesResult {
  const [directives, setDirectives] = useState<Directive[]>([]);
  const [buildStatus, setBuildStatus] = useState<BuildStatus | null>(null);
  const [summary, setSummary] = useState<DirectiveSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);
  const wsReconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsReconnectAttempt = useRef(0);

  const loadData = useCallback(async () => {
    try {
      if (!mountedRef.current) return;
      setError(null);
      const [directiveData, buildData, summaryData] = await Promise.all([
        fetchDirectives(),
        fetchBuildStatus().catch(() => null as BuildStatus | null),
        fetchDirectiveSummary().catch(() => null as DirectiveSummary | null),
      ]);
      if (!mountedRef.current) return;
      setDirectives(directiveData);
      if (buildData) setBuildStatus(buildData);
      if (summaryData) setSummary(summaryData);
      setLoading(false);
    } catch (e: any) {
      if (!mountedRef.current) return;
      setError(e.message || "Failed to load directives");
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await loadData();
  }, [loadData]);

  // WebSocket connection for real-time updates
  const connectWs = useCallback(() => {
    if (!mountedRef.current) return;
    try {
      const ws = new WebSocket(BRIDGE_WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        wsReconnectAttempt.current = 0;
        // Register as a lightweight observer (no audio role)
        ws.send(JSON.stringify({
          type: "register",
          role: "observer",
          deviceId: "directives-screen",
          deviceType: "observer",
        }));
      };

      ws.onmessage = (event: any) => {
        try {
          const data = typeof event.data === "string" ? event.data : event.data?.toString?.() || "";
          const msg = JSON.parse(data);
          if (msg.type === "directiveUpdate") {
            // Re-fetch all data on any directive update
            loadData();
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onerror = () => {
        // Errors handled in onclose
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!mountedRef.current) return;
        // Reconnect with backoff
        const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempt.current), 30000);
        wsReconnectAttempt.current++;
        wsReconnectTimer.current = setTimeout(connectWs, delay);
      };
    } catch {
      // WebSocket constructor can throw in some environments
    }
  }, [loadData]);

  // Setup: initial fetch + WS + polling
  useEffect(() => {
    mountedRef.current = true;
    loadData();
    connectWs();

    return () => {
      mountedRef.current = false;
      if (pollRef.current) clearInterval(pollRef.current);
      if (wsReconnectTimer.current) clearTimeout(wsReconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on unmount
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [loadData, connectWs]);

  // Compute whether any build is active (memoized to reduce poll interval churn)
  const hasActiveBuild = useMemo(() => {
    const hasGlobalActive = buildStatus &&
      ([...(buildStatus.android || []), ...(buildStatus.ios || [])].some(
        (r) => r.status === "in_progress" || r.status === "queued"
      ));
    const hasDirectiveActive = directives.some((d) =>
      d.buildRuns?.some((run) => run.status === "in_progress" || run.status === "queued")
    );
    return !!(hasGlobalActive || hasDirectiveActive);
  }, [buildStatus, directives]);

  // Adaptive polling: shorter interval when builds are active
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);

    const interval = hasActiveBuild
      ? POLL_INTERVAL_ACTIVE_BUILD
      : POLL_INTERVAL_DEFAULT;

    pollRef.current = setInterval(loadData, interval);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [hasActiveBuild, loadData]);

  return { directives, buildStatus, summary, loading, error, refresh };
}
