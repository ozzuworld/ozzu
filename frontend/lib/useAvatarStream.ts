import { useEffect, useRef, useState, useCallback } from "react";
import { getBridgeUrl } from "./bridge-api";

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export interface AvatarStreamState {
  connected: boolean;
  gpuConnected: boolean;
  frameUri: string | null;
  fps: number;
}

const RECONNECT_MS = 3000;

export function useAvatarStream(active: boolean) {
  const [state, setState] = useState<AvatarStreamState>({
    connected: false,
    gpuConnected: false,
    frameUri: null,
    fps: 0,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const frameCountRef = useRef(0);
  const fpsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const sendText = useCallback((text: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "echo", text }));
    }
  }, []);

  useEffect(() => {
    if (!active) {
      wsRef.current?.close();
      wsRef.current = null;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (fpsTimerRef.current) clearInterval(fpsTimerRef.current);
      setState((s) => ({ ...s, connected: false, frameUri: null }));
      return;
    }

    const bridgeUrl = getBridgeUrl();
    const wsUrl = bridgeUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:") + "/ws/avatar";

    function connect() {
      if (!activeRef.current) return;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        setState((s) => ({ ...s, connected: true }));
      };

      ws.onmessage = (evt: MessageEvent) => {
        if (typeof evt.data === "string") {
          try {
            const msg = JSON.parse(evt.data);
            if (msg.type === "status") {
              setState((s) => ({ ...s, gpuConnected: msg.gpu_connected }));
            }
          } catch {}
          return;
        }

        const buf = new Uint8Array(evt.data as ArrayBuffer);
        if (buf.length < 2) return;

        if (buf[0] === 0x56) {
          const jpegData = buf.subarray(1);
          const uri = `data:image/jpeg;base64,${toBase64(jpegData)}`;
          setState((s) => ({ ...s, frameUri: uri }));
          frameCountRef.current++;
        }
      };

      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false, gpuConnected: false }));
        wsRef.current = null;
        if (activeRef.current) {
          reconnectRef.current = setTimeout(connect, RECONNECT_MS);
        }
      };

      ws.onerror = () => {
        setState((s) => ({ ...s, connected: false }));
      };
    }

    connect();

    fpsTimerRef.current = setInterval(() => {
      setState((s) => ({ ...s, fps: frameCountRef.current }));
      frameCountRef.current = 0;
    }, 1000);

    return () => {
      wsRef.current?.close();
      wsRef.current = null;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (fpsTimerRef.current) clearInterval(fpsTimerRef.current);
      setState((s) => ({ ...s, connected: false, frameUri: null }));
    };
  }, [active]);

  return { ...state, sendText };
}
