import { useEffect, useRef, useState, useCallback } from "react";
import { AppState, Platform } from "react-native";
import { getBridgeUrl } from "./bridge-api";

let VoipCallModule: any = null;
try {
  if (Platform.OS === "ios") {
    VoipCallModule = require("../modules/voip-call");
  }
} catch {}

export interface VoipState {
  registered: boolean;
  activeCall: { uuid: string; caller: string; name: string } | null;
  lastError: string | null;
}

export function useVoipCall() {
  const [state, setState] = useState<VoipState>({
    registered: false,
    activeCall: null,
    lastError: null,
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

  return { ...state, endCall, available: !!VoipCallModule };
}
