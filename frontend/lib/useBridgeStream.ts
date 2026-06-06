// useBridgeStream — one app-wide WebSocket bus for push updates from the bridge.
//
// Replaces per-screen setInterval polling and per-hook ad-hoc WebSocket connections.
// Subscribers register a handler for a message `type`; the singleton manages the
// connection, auth, register-as-observer handshake, reconnect with backoff, and
// ref-counted lifetime. Handlers receive parsed message objects of shape
// `{ type, ...payload }` matching the bridge's `broadcastToAll` calls.

import { useEffect, useRef, useState } from "react";

const BRIDGE_BASE = (process.env.EXPO_PUBLIC_BRIDGE_URL || "https://home.ozzu.world/bridge")
  .replace(/^https/, "wss")
  .replace(/^http/, "ws");
const BRIDGE_API_KEY = process.env.EXPO_PUBLIC_BRIDGE_API_KEY || "";

function buildWsUrl(): string {
  const base = `${BRIDGE_BASE}/ws`;
  return BRIDGE_API_KEY ? `${base}?token=${encodeURIComponent(BRIDGE_API_KEY)}` : base;
}

type Handler = (msg: any) => void;
type StatusListener = (connected: boolean) => void;

const IDLE_CLOSE_GRACE_MS = 30_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

class BridgeStream {
  private ws: WebSocket | null = null;
  private connecting = false;
  private closeRequested = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private subscribers = new Map<string, Set<Handler>>();
  private statusListeners = new Set<StatusListener>();
  private deviceId = `app-observer-${Math.random().toString(36).slice(2, 10)}`;

  isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  subscribe(eventType: string, handler: Handler): () => void {
    let set = this.subscribers.get(eventType);
    if (!set) {
      set = new Set();
      this.subscribers.set(eventType, set);
    }
    set.add(handler);
    this.ensureConnected();
    return () => {
      const s = this.subscribers.get(eventType);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) this.subscribers.delete(eventType);
      if (this.subscribers.size === 0) this.scheduleIdleClose();
    };
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  private ensureConnected() {
    if (this.idleCloseTimer) {
      clearTimeout(this.idleCloseTimer);
      this.idleCloseTimer = null;
    }
    if (this.ws || this.connecting) return;
    this.connect();
  }

  private scheduleIdleClose() {
    if (this.idleCloseTimer) clearTimeout(this.idleCloseTimer);
    // Screen navigation often unmounts + remounts subscribers within a tick;
    // keep the socket warm so we don't churn through reconnects.
    this.idleCloseTimer = setTimeout(() => {
      if (this.subscribers.size === 0) this.close();
    }, IDLE_CLOSE_GRACE_MS);
  }

  private connect() {
    if (this.connecting) return;
    this.connecting = true;
    this.closeRequested = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(buildWsUrl());
    } catch {
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connecting = false;
      this.reconnectAttempt = 0;
      try {
        ws.send(JSON.stringify({
          type: "register",
          role: "observer",
          deviceId: this.deviceId,
          deviceType: "observer",
        }));
      } catch { /* ignore — registration is best-effort */ }
      this.notifyStatus(true);
    };
    ws.onmessage = (event: any) => {
      let msg: any;
      try {
        const data = typeof event.data === "string" ? event.data : event.data?.toString?.() || "";
        msg = JSON.parse(data);
      } catch { return; }
      if (!msg || typeof msg.type !== "string") return;
      const handlers = this.subscribers.get(msg.type);
      if (!handlers || handlers.size === 0) return;
      for (const h of handlers) {
        try { h(msg); } catch (err) { console.warn("[bridge-stream] handler error", err); }
      }
    };
    ws.onerror = () => { /* errors surface via onclose */ };
    ws.onclose = () => {
      const wasConnected = this.ws === ws;
      this.ws = null;
      this.connecting = false;
      if (wasConnected) this.notifyStatus(false);
      if (this.closeRequested || this.subscribers.size === 0) return;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), MAX_RECONNECT_DELAY_MS);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.subscribers.size > 0 && !this.closeRequested) this.connect();
    }, delay);
  }

  private notifyStatus(connected: boolean) {
    for (const l of this.statusListeners) {
      try { l(connected); } catch { /* ignore */ }
    }
  }

  private close() {
    this.closeRequested = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.idleCloseTimer) { clearTimeout(this.idleCloseTimer); this.idleCloseTimer = null; }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try { ws.onclose = null as any; ws.close(); } catch { /* ignore */ }
    }
    this.connecting = false;
  }
}

export const bridgeStream = new BridgeStream();

export interface UseBridgeStreamOptions {
  filter?: (msg: any) => boolean;
  fallbackPollMs?: number;
  onFallback?: () => void;
}

// Subscribe to a single message type from the bridge bus.
// Handler runs on every matching message. Optional client-side filter narrows
// by scope (e.g., engagement_id). Optional fallback poll fires `onFallback`
// at the given interval ONLY when the WS is disconnected — steady-state cost
// is zero polling, just the live push.
export function useBridgeStream(
  eventType: string,
  handler: (msg: any) => void,
  opts: UseBridgeStreamOptions = {},
) {
  const handlerRef = useRef(handler);
  const filterRef = useRef(opts.filter);
  const onFallbackRef = useRef(opts.onFallback);
  handlerRef.current = handler;
  filterRef.current = opts.filter;
  onFallbackRef.current = opts.onFallback;

  const fallbackPollMs = opts.fallbackPollMs ?? 0;

  useEffect(() => {
    const unsubscribe = bridgeStream.subscribe(eventType, (msg) => {
      const filter = filterRef.current;
      if (filter && !filter(msg)) return;
      handlerRef.current(msg);
    });

    let pollTimer: ReturnType<typeof setInterval> | null = null;
    if (fallbackPollMs > 0) {
      pollTimer = setInterval(() => {
        if (!bridgeStream.isConnected() && onFallbackRef.current) {
          onFallbackRef.current();
        }
      }, fallbackPollMs);
    }

    return () => {
      unsubscribe();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [eventType, fallbackPollMs]);
}

// Returns true while the singleton WS is connected. Re-renders on transitions.
export function useBridgeStreamConnected(): boolean {
  const [connected, setConnected] = useState(bridgeStream.isConnected());
  useEffect(() => {
    setConnected(bridgeStream.isConnected());
    return bridgeStream.onStatusChange(setConnected);
  }, []);
  return connected;
}
