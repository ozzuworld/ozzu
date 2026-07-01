// voip-hooks.ts — live VoIP stack status for the Ops → VoIP tab.
import { useState, useEffect, useRef, useCallback } from "react";
import { getBridgeUrl, getAuthHeaders } from "./bridge-api";

export interface VoipEndpoint {
  id: string;
  role: string;
  state: string;
  channels: number;
  contact: string | null;
  contactStatus: string | null;
  rttMs: number | null;
  registered: boolean;
}

export interface VoipStatus {
  ok: boolean;
  ts: string;
  asteriskUp: boolean;
  june: { running: boolean; port: number };
  app: { registered: boolean; contact: string | null; rttMs: number | null; state: string; activeChannels?: number };
  gateway: { state: string; reachable: boolean } | null;
  endpoints: VoipEndpoint[];
  activeCalls: number;
  recentCalls: { phone_number: string; direction: string; call_time: string; label: string | null }[];
  recentEvents: { event: string; caller_number: string | null; created_at: string; data: any }[];
  config: Record<string, any>;
}

const POLL_INTERVAL = 15000;

export function useVoipStatus() {
  const [status, setStatus] = useState<VoipStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch(`${getBridgeUrl()}/voip/status`, { headers: getAuthHeaders() });
      if (!res.ok) return;
      const data: VoipStatus = await res.json();
      if (!mountedRef.current) return;
      setStatus(data);
      setLoading(false);
    } catch {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetch_();
    const iv = setInterval(fetch_, POLL_INTERVAL);
    return () => { mountedRef.current = false; clearInterval(iv); };
  }, [fetch_]);

  return { status, loading, refresh: fetch_ };
}
