import { useEffect, useRef, useState, useCallback } from "react";
import { Platform } from "react-native";
import { getBridgeUrl } from "./bridge-api";

// React Native doesn't have Blob/URL.createObjectURL — use base64 data URIs
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa === "function") return btoa(binary);
  // Node/RN fallback
  return Buffer.from(bytes).toString("base64");
}

export interface AvatarStreamState {
  connected: boolean;
  gpuConnected: boolean;
  frameUri: string | null;
  fps: number;
}

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
      setState((s) => ({ ...s, connected: false, frameUri: null }));
      return;
    }

    const bridgeUrl = getBridgeUrl();
    const wsUrl = bridgeUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:") + "/ws/avatar";

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

      const tag = buf[0];
      if (tag === 0x56) {
        // 'V' = video frame (JPEG)
        const jpegData = buf.slice(1);
        const b64 = uint8ToBase64(jpegData);
        const uri = `data:image/jpeg;base64,${b64}`;
        setState((s) => ({ ...s, frameUri: uri }));
        frameCountRef.current++;
      }
    };

    ws.onclose = () => {
      setState((s) => ({ ...s, connected: false, gpuConnected: false }));
    };

    ws.onerror = () => {
      setState((s) => ({ ...s, connected: false }));
    };

    fpsTimerRef.current = setInterval(() => {
      setState((s) => ({ ...s, fps: frameCountRef.current }));
      frameCountRef.current = 0;
    }, 1000);

    return () => {
      ws.close();
      wsRef.current = null;
      if (fpsTimerRef.current) clearInterval(fpsTimerRef.current);
      setState((s) => ({ ...s, connected: false, frameUri: null }));
    };
  }, [active]);

  return { ...state, sendText };
}
