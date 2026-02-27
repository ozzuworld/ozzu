// useOsint() hook — fetch profiles, findings, score with polling
import { useState, useEffect, useRef, useCallback } from "react";
import {
  fetchOsintProfiles,
  fetchOsintFindings,
  fetchOsintScore,
  fetchOsintSchedule,
  fetchOsintScoreHistory,
  fetchOsintGraph,
  fetchOsintAlerts,
  fetchOsintUnreadAlertCount,
  fetchOsintGroups,
  fetchOsintToolStatus,
  type OsintProfile,
  type OsintFinding,
  type ExposureScore,
  type ScanSchedule,
  type ScoreHistoryEntry,
  type OsintEntity,
  type OsintRelationship,
  type OsintCorrelationSummary,
  type OsintAlert,
  type OsintGroup,
  type OsintToolStatus,
} from "./bridge-api";

interface UseOsintResult {
  profiles: OsintProfile[];
  findings: OsintFinding[];
  score: ExposureScore | null;
  schedule: ScanSchedule | null;
  scoreHistory: ScoreHistoryEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  isScanning: boolean;
  setIsScanning: (v: boolean) => void;
}

export function useOsint(): UseOsintResult {
  const [profiles, setProfiles] = useState<OsintProfile[]>([]);
  const [findings, setFindings] = useState<OsintFinding[]>([]);
  const [score, setScore] = useState<ExposureScore | null>(null);
  const [schedule, setSchedule] = useState<ScanSchedule | null>(null);
  const [scoreHistory, setScoreHistory] = useState<ScoreHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const mountedRef = useRef(true);

  const fetchAll = useCallback(async () => {
    try {
      const [p, f, s, sched] = await Promise.all([
        fetchOsintProfiles(),
        fetchOsintFindings(),
        fetchOsintScore(),
        fetchOsintSchedule().catch(() => null),
      ]);
      if (!mountedRef.current) return;
      setProfiles(p);
      setFindings(f);
      setScore(s);
      if (sched) setSchedule(sched);
      setError(null);
    } catch (err: any) {
      if (mountedRef.current) setError(err.message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // Fetch score history less frequently (on mount + every 5 minutes)
  const fetchHistory = useCallback(async () => {
    try {
      const history = await fetchOsintScoreHistory(30);
      if (mountedRef.current) setScoreHistory(history);
    } catch (_) {}
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchAll();
    fetchHistory();
    return () => { mountedRef.current = false; };
  }, [fetchAll, fetchHistory]);

  // Poll: 15s normal, 3s when scanning
  useEffect(() => {
    const interval = setInterval(fetchAll, isScanning ? 3000 : 15000);
    return () => clearInterval(interval);
  }, [fetchAll, isScanning]);

  // Score history: refresh every 5 minutes
  useEffect(() => {
    const interval = setInterval(fetchHistory, 300000);
    return () => clearInterval(interval);
  }, [fetchHistory]);

  return { profiles, findings, score, schedule, scoreHistory, loading, error, refresh: fetchAll, isScanning, setIsScanning };
}

// useOsintGraph() hook — fetch entity graph with polling
interface UseOsintGraphResult {
  entities: OsintEntity[];
  relationships: OsintRelationship[];
  summary: OsintCorrelationSummary | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useOsintGraph(profileId?: number): UseOsintGraphResult {
  const [entities, setEntities] = useState<OsintEntity[]>([]);
  const [relationships, setRelationships] = useState<OsintRelationship[]>([]);
  const [summary, setSummary] = useState<OsintCorrelationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchGraph = useCallback(async () => {
    try {
      const data = await fetchOsintGraph(profileId);
      if (!mountedRef.current) return;
      setEntities(data.entities || []);
      setRelationships(data.relationships || []);
      setSummary(data.summary || null);
      setError(null);
    } catch (err: any) {
      if (mountedRef.current) setError(err.message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    mountedRef.current = true;
    fetchGraph();
    return () => { mountedRef.current = false; };
  }, [fetchGraph]);

  // Poll every 30s
  useEffect(() => {
    const interval = setInterval(fetchGraph, 30000);
    return () => clearInterval(interval);
  }, [fetchGraph]);

  return { entities, relationships, summary, loading, error, refresh: fetchGraph };
}

// useOsintAlerts() hook — fetch alerts with polling
interface UseOsintAlertsResult {
  alerts: OsintAlert[];
  unreadCount: number;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useOsintAlerts(): UseOsintAlertsResult {
  const [alerts, setAlerts] = useState<OsintAlert[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    try {
      const [a, count] = await Promise.all([
        fetchOsintAlerts({ limit: 50 }),
        fetchOsintUnreadAlertCount(),
      ]);
      if (!mountedRef.current) return;
      setAlerts(a);
      setUnreadCount(count);
    } catch (_) {}
    finally { if (mountedRef.current) setLoading(false); }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchData();
    return () => { mountedRef.current = false; };
  }, [fetchData]);

  // Poll every 10s for alert updates
  useEffect(() => {
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return { alerts, unreadCount, loading, refresh: fetchData };
}

// useOsintGroups() hook — fetch groups
interface UseOsintGroupsResult {
  groups: OsintGroup[];
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useOsintGroups(): UseOsintGroupsResult {
  const [groups, setGroups] = useState<OsintGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    try {
      const g = await fetchOsintGroups();
      if (mountedRef.current) setGroups(g);
    } catch (_) {}
    finally { if (mountedRef.current) setLoading(false); }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchData();
    return () => { mountedRef.current = false; };
  }, [fetchData]);

  return { groups, loading, refresh: fetchData };
}

// useOsintToolStatus() hook — CLI tool availability
interface UseOsintToolStatusResult {
  toolStatus: OsintToolStatus | null;
  availableCount: number;
  totalCount: number;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useOsintToolStatus(): UseOsintToolStatusResult {
  const [toolStatus, setToolStatus] = useState<OsintToolStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    try {
      const s = await fetchOsintToolStatus();
      if (mountedRef.current) setToolStatus(s);
    } catch (_) {}
    finally { if (mountedRef.current) setLoading(false); }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchData();
    return () => { mountedRef.current = false; };
  }, [fetchData]);

  // Refresh every 60s (tool status doesn't change often)
  useEffect(() => {
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const availableCount = toolStatus ? Object.values(toolStatus.tools).filter((t) => t.available).length : 0;
  const totalCount = toolStatus ? Object.keys(toolStatus.tools).length : 0;

  return { toolStatus, availableCount, totalCount, loading, refresh: fetchData };
}
