// useKnowledgeGraph() hook — fetch KG subjects, stats, diffs with polling
import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "./bridge-api";

export interface KgSubject {
  id: number;
  name: string;
  subject_type: string;
  status: string;
  last_collected_at: string | null;
  collect_interval_hours: number;
  created_at: string;
}

export interface KgFact {
  id: number;
  subject_id: number;
  category: string;
  key: string;
  value: string;
  source: string;
  confidence: number;
}

export interface KgObservation {
  id: number;
  subject_id: number;
  platform: string;
  observation_type: string;
  content: string | null;
  sentiment: string | null;
  nlp_enriched: boolean;
  nlp_result: any;
  raw_data: any;
  observed_at: string;
  collected_at: string;
  subject_name?: string;
}

export interface KgConnection {
  id: number;
  source_id: number;
  target_id: number;
  relationship: string;
  confidence: number;
  source_name?: string;
  target_name?: string;
}

export interface KgDossier {
  subject: KgSubject;
  anchors: Array<{ id: number; anchor_type: string; value: string; platform: string }>;
  facts: KgFact[];
  timeline: Array<{ id: number; event_type: string; title: string; description: string; event_date: string }>;
  connections: KgConnection[];
  observations: KgObservation[];
}

export interface KgDiff {
  field: string;
  previous: any;
  current: any;
  observed_at: string;
}

export interface KgStats {
  subjects: number;
  observations: number;
  enriched: number;
  unenriched: number;
  facts: number;
  connections: number;
  collections_completed: number;
}

export interface KgQueryResult {
  query: string;
  results: {
    subjects: KgSubject[];
    observations: KgObservation[];
    facts: KgFact[];
  };
  total: number;
}

// ── API functions ──

export async function fetchKgSubjects(): Promise<KgSubject[]> {
  return apiFetch("/kg/subjects");
}

export async function fetchKgDossier(subjectId: number): Promise<KgDossier> {
  return apiFetch(`/kg/subjects/${subjectId}/dossier`);
}

export async function fetchKgDiffs(subjectId: number, platform: string = "twitter"): Promise<{ diffs: KgDiff[] }> {
  return apiFetch(`/kg/subjects/${subjectId}/diffs?platform=${platform}`);
}

export async function fetchKgStats(): Promise<KgStats> {
  return apiFetch("/kg/stats");
}

export async function queryKg(q: string): Promise<KgQueryResult> {
  return apiFetch("/kg/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q }),
  });
}

export async function triggerKgCollection(subjectId: number, platform: string, target: string): Promise<any> {
  return apiFetch("/kg/collect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ platform, action: "profile", subject_id: subjectId, target }),
  });
}

export async function triggerKgEnrichNow(): Promise<any> {
  return apiFetch("/kg/enrich-now", { method: "POST" });
}

// ── Hook ──

interface UseKgResult {
  subjects: KgSubject[];
  stats: KgStats | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useKnowledgeGraph(): UseKgResult {
  const [subjects, setSubjects] = useState<KgSubject[]>([]);
  const [stats, setStats] = useState<KgStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchAll = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([
        fetchKgSubjects(),
        fetchKgStats(),
      ]);
      if (!mountedRef.current) return;
      setSubjects(s);
      setStats(st);
      setError(null);
    } catch (err: any) {
      if (mountedRef.current) setError(err.message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchAll();
    return () => { mountedRef.current = false; };
  }, [fetchAll]);

  // Poll every 30s
  useEffect(() => {
    const interval = setInterval(fetchAll, 30000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  return { subjects, stats, loading, error, refresh: fetchAll };
}
