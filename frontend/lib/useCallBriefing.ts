import { useEffect, useRef, useState, useCallback } from "react";
import { getBridgeUrl, getAuthHeaders } from "./bridge-api";
import { armAutoAnswer } from "./voip-handoff";

// Screening gate: June answers + screens the caller, then pushes a briefing over the
// bridge's /ws/voip socket. This hook delivers that briefing to the CallBriefingOverlay.
// King Kazuma taps Accept -> we POST the decision (June transfers) and ARM auto-answer so
// the incoming WebRTC INVITE connects in one tap. Decline -> June takes a message.
// Foreground-only until PushKit (cert-window) can wake a backgrounded app.

export interface CallBriefing {
  call_uuid: string;
  caller_name: string;
  caller_number: string;
  wants_to_reach: string;
  reason: string;
  urgency: "low" | "normal" | "high";
}

export interface Voicemail {
  call_uuid: string;
  caller_name: string;
  caller_number: string;
  message: string;
  callback_requested: boolean;
}

interface BriefingState {
  briefing: CallBriefing | null;
  voicemail: Voicemail | null;
}

export function useCallBriefing() {
  const [state, setState] = useState<BriefingState>({ briefing: null, voicemail: null });
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 3000);
    };

    const connect = () => {
      if (closed) return;
      const wsUrl =
        getBridgeUrl().replace(/^https:/, "wss:").replace(/^http:/, "ws:") + "/ws/voip";
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({ type: "auth", username: "ozzu-iphone" }));
        } catch {}
      };
      ws.onmessage = (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        } catch {
          return;
        }
        if (!msg || !msg.type) return;
        if (msg.type === "call_briefing") {
          setState((s) => ({ ...s, briefing: msg as CallBriefing }));
        } else if (msg.type === "voicemail") {
          setState((s) => ({ ...s, voicemail: msg as Voicemail, briefing: null }));
        }
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {}
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        scheduleReconnect();
      };
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
    };
  }, []);

  const respondToBriefing = useCallback(
    async (callUuid: string, decision: "accepted" | "declined") => {
      // Accept: arm auto-answer BEFORE the transfer INVITE can arrive, so it connects in
      // one tap. Either way close the overlay immediately for responsive feedback.
      if (decision === "accepted") armAutoAnswer();
      setState((s) => ({ ...s, briefing: null }));
      try {
        await fetch(`${getBridgeUrl()}/soc/calls/decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ call_uuid: callUuid, decision }),
        });
      } catch (e: any) {
        console.error("[voip] decision error:", e?.message);
      }
    },
    []
  );

  const dismissBriefing = useCallback(
    () => setState((s) => ({ ...s, briefing: null })),
    []
  );
  const dismissVoicemail = useCallback(
    () => setState((s) => ({ ...s, voicemail: null })),
    []
  );

  return { ...state, respondToBriefing, dismissBriefing, dismissVoicemail };
}
