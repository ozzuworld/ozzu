// useOsint() hook — fetch profiles, findings, score with polling
import { useState, useEffect, useRef, useCallback } from "react";
import {
  fetchOsintProfiles,
  fetchOsintFindings,
  fetchOsintScore,
  fetchOsintSchedule,
  fetchOsintScoreHistory,
  fetchOsintGraph,
  type OsintProfile,
  type OsintFinding,
  type ExposureScore,
  type ScanSchedule,
  type ScoreHistoryEntry,
  type OsintEntity,
  type OsintRelationship,
  type OsintCorrelationSummary,
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
