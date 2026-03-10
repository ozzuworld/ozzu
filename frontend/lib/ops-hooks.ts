// ops-hooks.ts — Hooks for OPS tab: service health, incidents, GPU status

import { useState, useEffect, useRef, useCallback } from "react";
import { getBridgeUrl, getAuthHeaders } from "./bridge-api";

export interface ServiceStatus {
  status: "healthy" | "degraded" | "down" | "unknown";
  failCount: number;
  lastCheck: string | null;
  latencyMs: number | null;
  details: Record<string, any>;
}

export interface OpsStatusResponse {
  ok: boolean;
  services: Record<string, ServiceStatus>;
  ts: string;
}

export interface OpsIncident {
  service: string;
  fromStatus: string;
  toStatus: string;
  details: Record<string, any>;
  ts: string;
  // DB fields
  id?: number;
  from_status?: string;
  to_status?: string;
  started_at?: string;
}

export interface OpsAlert {
  service: string;
  status: string;
  previousStatus: string;
  severity: string;
  ts: string;
  details: any;
}

const POLL_INTERVAL = 15000;

export function useOpsStatus() {
  const [services, setServices] = useState<Record<string, ServiceStatus>>({});
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const alertQueueRef = useRef<OpsAlert[]>([]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${getBridgeUrl()}/ops/status`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return;
      const data: OpsStatusResponse = await res.json();
      if (!mountedRef.current) return;
      setServices(data.services);
      setLastUpdate(data.ts);
      setLoading(false);
    } catch {
      // ignore fetch errors
    }
  }, []);

  // Merge WS opsAlert events into state
  const handleAlert = useCallback((alert: OpsAlert) => {
    alertQueueRef.current.push(alert);
    setServices((prev) => {
      const updated = { ...prev };
      if (updated[alert.service]) {
        updated[alert.service] = {
          ...updated[alert.service],
          status: alert.status === "idle" ? "degraded" : (alert.status as any),
          lastCheck: alert.ts,
          details: alert.details || {},
        };
      }
      return updated;
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchStatus();
    const interval = setInterval(fetchStatus, POLL_INTERVAL);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [fetchStatus]);

  const forceCheck = useCallback(async () => {
    try {
      const res = await fetch(`${getBridgeUrl()}/ops/check`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      if (!res.ok) return;
      const data: OpsStatusResponse = await res.json();
      if (!mountedRef.current) return;
      setServices(data.services);
      setLastUpdate(data.ts);
    } catch {}
  }, []);

  return { services, loading, lastUpdate, handleAlert, forceCheck };
}

export function useOpsIncidents(limit = 50) {
  const [incidents, setIncidents] = useState<OpsIncident[]>([]);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const fetchIncidents = useCallback(async () => {
    try {
      const res = await fetch(`${getBridgeUrl()}/ops/incidents?limit=${limit}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!mountedRef.current) return;
      // Normalize DB rows (snake_case) to camelCase
      const normalized = (data.incidents || []).map((inc: any) => ({
        service: inc.service,
        fromStatus: inc.fromStatus || inc.from_status,
        toStatus: inc.toStatus || inc.to_status,
        details: inc.details || {},
        ts: inc.ts || inc.started_at,
      }));
      setIncidents(normalized);
      setLoading(false);
    } catch {}
  }, [limit]);

  useEffect(() => {
    mountedRef.current = true;
    fetchIncidents();
    const interval = setInterval(fetchIncidents, 30000);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [fetchIncidents]);

  return { incidents, loading, refresh: fetchIncidents };
}
