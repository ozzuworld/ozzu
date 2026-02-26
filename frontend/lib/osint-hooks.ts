// useOsint() hook — fetch profiles, findings, score with polling
import { useState, useEffect, useRef, useCallback } from "react";
import {
  fetchOsintProfiles,
  fetchOsintFindings,
  fetchOsintScore,
  type OsintProfile,
  type OsintFinding,
  type ExposureScore,
} from "./bridge-api";

interface UseOsintResult {
  profiles: OsintProfile[];
  findings: OsintFinding[];
  score: ExposureScore | null;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const mountedRef = useRef(true);

  const fetchAll = useCallback(async () => {
    try {
      const [p, f, s] = await Promise.all([
        fetchOsintProfiles(),
        fetchOsintFindings(),
        fetchOsintScore(),
      ]);
      if (!mountedRef.current) return;
      setProfiles(p);
      setFindings(f);
      setScore(s);
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

  // Poll: 15s normal, 3s when scanning
  useEffect(() => {
    const interval = setInterval(fetchAll, isScanning ? 3000 : 15000);
    return () => clearInterval(interval);
  }, [fetchAll, isScanning]);

  return { profiles, findings, score, loading, error, refresh: fetchAll, isScanning, setIsScanning };
}
