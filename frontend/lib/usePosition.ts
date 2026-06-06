// usePosition — Real-time indoor positioning from bridge
//
// Subscribes to "positionUpdate" via the shared bridge WS bus. Polls the HTTP
// endpoint only as a fallback when the WS is disconnected. Replaces an ad-hoc
// per-hook WebSocket with the singleton — see dir_1780760826635.

import { useState, useEffect, useCallback, useRef } from "react";
import { getBridgeUrl } from "./bridge-api";
import { useBridgeStream, useBridgeStreamConnected } from "./useBridgeStream";

export interface PositionData {
  room: string;
  presence: string;
  confidence: number;
  method: string;
  x?: number;
  z?: number;
  furniture?: string;
  ble_device?: string;
}

interface PositionState {
  position: PositionData | null;
  lastUpdate: string | null;
  connected: boolean;
}

const FALLBACK_POLL_INTERVAL_MS = 10_000;

export function usePosition(): PositionState {
  const [position, setPosition] = useState<PositionData | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const connected = useBridgeStreamConnected();
  const mountedRef = useRef(true);

  const fetchState = useCallback(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const url = `${getBridgeUrl()}/positioning/state`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return;
      const data = await res.json();
      if (!mountedRef.current) return;
      if (data.location) {
        setPosition(data.location);
        setLastUpdate(data.lastUpdate);
      }
    } catch (e) {
      clearTimeout(timer);
      if ((e as Error).name !== "AbortError") {
        console.warn("usePosition fetch error:", e);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchState();
    return () => { mountedRef.current = false; };
  }, [fetchState]);

  useBridgeStream(
    "positionUpdate",
    (msg: any) => {
      if (!mountedRef.current || !msg.location) return;
      setPosition(msg.location);
      setLastUpdate(msg.ts || new Date().toISOString());
    },
    { fallbackPollMs: FALLBACK_POLL_INTERVAL_MS, onFallback: fetchState },
  );

  return { position, lastUpdate, connected };
}
