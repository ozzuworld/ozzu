import { useEffect, useRef, useState, useCallback } from "react";
import { Platform } from "react-native";
import { getBridgeUrl, getAuthHeaders } from "./bridge-api";

let VoipCallModule: any = null;
try {
  if (Platform.OS === "ios") {
    VoipCallModule = require("../modules/voip-call");
  }
} catch {}

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

export interface VoipState {
  registered: boolean;
  activeCall: { uuid: string; caller: string; name: string } | null;
  lastError: string | null;
  briefing: CallBriefing | null;
  voicemail: Voicemail | null;
}

export function useVoipCall() {
  const [state, setState] = useState<VoipState>({
    registered: false,
    activeCall: null,
    lastError: null,
    briefing: null,
    voicemail: null,
  });
  const initialized = useRef(false);

  const init = useCallback(async () => {
    if (!VoipCallModule || initialized.current) return;
    initialized.current = true;

    try {
      const bridgeUrl = getBridgeUrl();
      const host = new URL(bridgeUrl).hostname;

      await VoipCallModule.configure({
        server: host,
        port: 5060,
        wsPort: 8088,
        username: "ozzu-iphone",
        password: "ozzu-sip-2026",
      });

      VoipCallModule.addListener(
        "onRegistered",
        () => setState((s) => ({ ...s, registered: true, lastError: null }))
      );
      VoipCallModule.addListener(
        "onRegistrationFailed",
        (e: { error: string }) =>
          setState((s) => ({ ...s, registered: false, lastError: e.error }))
      );
      VoipCallModule.addListener(
        "onIncomingCall",
        (e: { uuid: string; caller: string; name: string }) =>
          setState((s) => ({ ...s, activeCall: e }))
      );
      VoipCallModule.addListener(
        "onCallAnswered",
        (e: { uuid: string }) =>
          setState((s) => ({
            ...s,
            activeCall: s.activeCall
              ? { ...s.activeCall, uuid: e.uuid }
              : null,
          }))
      );
      VoipCallModule.addListener(
        "onCallEnded",
        () => setState((s) => ({ ...s, activeCall: null }))
      );
      VoipCallModule.addListener(
        "onCallFailed",
        (e: { uuid: string; error: string }) =>
          setState((s) => ({ ...s, activeCall: null, lastError: e.error }))
      );
      VoipCallModule.addListener(
        "onPushToken",
        (e: { token: string }) =>
          console.log("[VoIP] push token:", e.token.substring(0, 16) + "...")
      );
      VoipCallModule.addListener(
        "onCallBriefing",
        (e: CallBriefing) => setState((s) => ({ ...s, briefing: e }))
      );
      VoipCallModule.addListener(
        "onVoicemail",
        (e: Voicemail) => setState((s) => ({ ...s, voicemail: e, briefing: null }))
      );

      await VoipCallModule.register();
    } catch (e: any) {
      console.error("[VoIP] init error:", e.message);
      setState((s) => ({ ...s, lastError: e.message }));
    }
  }, []);

  useEffect(() => {
    init();
  }, [init]);

  const endCall = useCallback(async (uuid: string) => {
    if (!VoipCallModule) return;
    await VoipCallModule.endCall(uuid);
  }, []);

  const respondToBriefing = useCallback(
    async (callUuid: string, decision: "accepted" | "declined") => {
      try {
        const bridgeUrl = getBridgeUrl();
        await fetch(`${bridgeUrl}/soc/calls/decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ call_uuid: callUuid, decision }),
        });
        if (decision === "declined") {
          setState((s) => ({ ...s, briefing: null }));
        }
      } catch (e: any) {
        console.error("[VoIP] decision error:", e.message);
      }
    },
    []
  );

  const dismissBriefing = useCallback(() => {
    setState((s) => ({ ...s, briefing: null }));
  }, []);

  const dismissVoicemail = useCallback(() => {
    setState((s) => ({ ...s, voicemail: null }));
  }, []);

  return {
    ...state,
    endCall,
    respondToBriefing,
    dismissBriefing,
    dismissVoicemail,
    available: !!VoipCallModule,
  };
}
