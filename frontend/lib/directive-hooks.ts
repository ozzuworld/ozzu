// useDirectives — data hook for directive screen.
// Subscribes to "directiveUpdate" via the shared bridge WS bus (dir_1780760826635).
// Replaced a per-hook WebSocket implementation with the singleton; polling
// remains as adaptive fallback while builds are active.

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  fetchDirectives,
  fetchBuildStatus,
  fetchDirectiveSummary,
  type Directive,
  type BuildStatus,
  type DirectiveSummary,
} from "./bridge-api";
import { useBridgeStream } from "./useBridgeStream";

const POLL_INTERVAL_DEFAULT = 30_000;
const POLL_INTERVAL_ACTIVE_BUILD = 10_000;

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
  const mountedRef = useRef(true);

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

  // Initial fetch + cleanup flag
  useEffect(() => {
    mountedRef.current = true;
    loadData();
    return () => {
      mountedRef.current = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadData]);

  // Live push for any directive mutation — list refreshes immediately.
  useBridgeStream("directiveUpdate", () => { loadData(); });

  // Narrow event when only a directive's build run flipped — same refresh.
  useBridgeStream("directiveBuildUpdate", () => { loadData(); });

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

  // Fallback polling — slower than before because the WS handles live updates.
  // We still poll during active builds because the GitHub status fetch is what
  // surfaces "queued → in_progress → completed" transitions; the bridge has no
  // independent signal it could broadcast without that fetch happening.
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
