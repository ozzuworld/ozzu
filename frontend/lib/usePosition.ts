// usePosition — Real-time indoor positioning from bridge
// Polls HTTP endpoint every 2s + listens for WebSocket positionUpdate events

import { useState, useEffect, useRef, useCallback } from "react";
import { getBridgeUrl } from "./bridge-api";

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

export function usePosition(): PositionState {
  const [position, setPosition] = useState<PositionData | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const mountedRef = useRef(true);
  const wsRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch position via HTTP
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

  // WebSocket connection
  const connectWs = useCallback(() => {
    if (!mountedRef.current) return;
    try {
      const bridgeUrl = getBridgeUrl();
      const wsUrl = bridgeUrl
        .replace(/^https/, "wss")
        .replace(/^http/, "ws");
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        ws.send(JSON.stringify({ type: "register", role: "position-listener" }));
      };

      ws.onmessage = (evt) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === "positionUpdate" && msg.location) {
            setPosition(msg.location);
            setLastUpdate(msg.ts || new Date().toISOString());
          }
        } catch {}
      };

      ws.onclose = () => {
        setConnected(false);
        if (mountedRef.current) {
          reconnectTimer.current = setTimeout(connectWs, 5000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {}
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    // Initial fetch
    fetchState();

    // Poll every 3 seconds as reliable fallback
    pollRef.current = setInterval(fetchState, 3000);

    // Also try WebSocket for real-time updates
    connectWs();

    return () => {
      mountedRef.current = false;
      if (wsRef.current) wsRef.current.close();
      if (pollRef.current) clearInterval(pollRef.current);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [fetchState, connectWs]);

  return { position, lastUpdate, connected };
}
