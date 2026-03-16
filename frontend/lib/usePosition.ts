// usePosition — Real-time indoor positioning from bridge
// Fetches initial state via HTTP, then listens for WebSocket positionUpdate events

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

const WS_URL = (process.env.EXPO_PUBLIC_BRIDGE_URL || "https://home.ozzu.world/bridge")
  .replace(/^https/, "wss")
  .replace(/^http/, "ws");

export function usePosition(): PositionState {
  const [position, setPosition] = useState<PositionData | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initial fetch
  const fetchState = useCallback(async () => {
    try {
      const res = await fetch(`${getBridgeUrl()}/positioning/state`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const data = await res.json();
      if (!mountedRef.current) return;
      if (data.location) {
        setPosition(data.location);
        setLastUpdate(data.lastUpdate);
      }
    } catch {}
  }, []);

  // WebSocket connection
  const connectWs = useCallback(() => {
    if (!mountedRef.current) return;
    try {
      const ws = new WebSocket(WS_URL);
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
    fetchState();
    connectWs();

    return () => {
      mountedRef.current = false;
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [fetchState, connectWs]);

  return { position, lastUpdate, connected };
}
