import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

// WebRTC call leg with a native CallKit incoming-call screen.
//   react-native-webrtc  — media (DTLS-SRTP), registerGlobals() exposes RTCPeerConnection
//   jssip                — SIP-over-WSS signaling to Asterisk's WebRTC endpoint
//   react-native-callkeep— native CallKit ring / answer / decline UI (+ speaker/mute)
//   react-native-incall-manager — audio route
//
// SCREENING GATE (dir_1783001909368): June screens the caller and King Kazuma taps Accept
// on the briefing (useCallBriefing), which ARMS auto-answer (voip-handoff). June then
// transfers, the Dial(PJSIP/ozzu-iphone) arrives here as a JsSIP newRTCSession, and we
// answer it in one tap. If an INVITE ever arrives WITHOUT a prior accept (e.g. a future
// PushKit background ring), we fall back to the native CallKit incoming screen.
// Foreground today; PushKit = cert-window.
import { consumeAutoAnswer } from "./voip-handoff";
let rnwebrtc: any = null;
let JsSIP: any = null;
let InCallManager: any = null;
let RNCallKeep: any = null;
let ready = false;
try {
  if (Platform.OS === "ios") {
    rnwebrtc = require("react-native-webrtc");
    rnwebrtc.registerGlobals();
    JsSIP = require("jssip");
    InCallManager = require("react-native-incall-manager").default;
    RNCallKeep = require("react-native-callkeep").default;
    ready = true;
  }
} catch (e: any) {
  console.warn("[webrtc] deps failed to load:", e?.message);
}

const WSS = "wss://home.ozzu.world/asterisk/ws";
const SIP_USER = "ozzu-iphone";
const SIP_PASS = "75134ecdccb72682abe5b3af85955ebb090b";
const SIP_DOMAIN = "home.ozzu.world";
const STUN = "stun:stun.l.google.com:19302";

function uuidv4(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface WebrtcState {
  registered: boolean;
  inCall: boolean;
  lastError: string | null;
}

export function useWebrtcCall() {
  const [state, setState] = useState<WebrtcState>({ registered: false, inCall: false, lastError: null });
  const uaRef = useRef<any>(null);
  const sessionRef = useRef<any>(null);
  const callUuidRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || uaRef.current) return;

    const cleanupCall = () => {
      try { InCallManager.stop(); } catch {}
      if (callUuidRef.current) { try { RNCallKeep.endCall(callUuidRef.current); } catch {} }
      sessionRef.current = null;
      callUuidRef.current = null;
      setState((s) => ({ ...s, inCall: false }));
    };

    // ── CallKit setup ──
    try {
      RNCallKeep.setup({
        ios: {
          appName: "Ozzu",
          supportsVideo: false,
          maximumCallGroups: "1",
          maximumCallsPerCallGroup: "1",
        },
      }).then?.(() => RNCallKeep.setAvailable(true)).catch?.((e: any) => console.warn("[callkeep] setup:", e?.message));
    } catch (e: any) { console.warn("[callkeep] setup err:", e?.message); }

    // King Kazuma taps Answer on the native call screen
    RNCallKeep.addEventListener("answerCall", ({ callUUID }: any) => {
      const session = sessionRef.current;
      if (!session) return;
      try {
        InCallManager.start({ media: "audio" });
        session.answer({
          mediaConstraints: { audio: true, video: false },
          pcConfig: { iceServers: [{ urls: STUN }] },
        });
        RNCallKeep.setCurrentCallActive(callUUID);
        setState((s) => ({ ...s, inCall: true }));
      } catch (e: any) { console.warn("[webrtc] answer error:", e?.message); }
    });
    // Decline / hang up from the native UI
    RNCallKeep.addEventListener("endCall", () => {
      try { sessionRef.current?.terminate(); } catch {}
      cleanupCall();
    });

    // ── JsSIP ──
    try {
      const socket = new JsSIP.WebSocketInterface(WSS);
      const ua = new JsSIP.UA({
        sockets: [socket],
        uri: `sip:${SIP_USER}@${SIP_DOMAIN}`,
        password: SIP_PASS,
        register: true,
        session_timers: false,
      });
      uaRef.current = ua;

      ua.on("registered", () => { console.log("[webrtc] REGISTERED"); setState((s) => ({ ...s, registered: true, lastError: null })); });
      ua.on("unregistered", () => setState((s) => ({ ...s, registered: false })));
      ua.on("registrationFailed", (e: any) => { console.warn("[webrtc] reg failed:", e?.cause); setState((s) => ({ ...s, registered: false, lastError: e?.cause || "reg failed" })); });

      ua.on("newRTCSession", (data: any) => {
        const { originator, session } = data;
        if (originator !== "remote") return; // inbound only
        sessionRef.current = session;
        const uuid = uuidv4();
        callUuidRef.current = uuid;
        const caller = session.remote_identity?.uri?.user || "Unknown";
        const name = session.remote_identity?.display_name || `Caller ${caller}`;
        session.on("ended", cleanupCall);
        session.on("failed", cleanupCall);

        // King Kazuma already tapped Accept on the briefing, which armed auto-answer — so
        // connect this transfer INVITE straight away (one tap, no second ring). Foreground:
        // use the PROVEN Round-1 audio path — InCallManager + session.answer, and deliberately
        // NO CallKit. Reporting to CallKit would seize the iOS audio session and then need the
        // RTCAudioSession manual-mode handshake (unimplemented); Round 1 proved clean 2-way
        // audio without it. CallKit stays reserved for the backgrounded PushKit ring (cert-window).
        if (consumeAutoAnswer()) {
          console.log("[webrtc] accepted transfer -> auto-answering", caller);
          try {
            InCallManager.start({ media: "audio" });
            session.answer({
              mediaConstraints: { audio: true, video: false },
              pcConfig: { iceServers: [{ urls: STUN }] },
            });
            setState((s) => ({ ...s, inCall: true }));
          } catch (e: any) { console.warn("[webrtc] auto-answer error:", e?.message); }
          return;
        }

        // Fallback: an INVITE with no prior in-app accept (e.g. a future PushKit background
        // ring) — show the native CallKit incoming screen; answered via the answerCall event.
        console.log("[webrtc] incoming call from", caller, "-> CallKit ring");
        try { RNCallKeep.displayIncomingCall(uuid, caller, name, "generic", false); } catch (e: any) { console.warn("[callkeep] display:", e?.message); }
      });

      ua.start();
    } catch (e: any) {
      console.error("[webrtc] UA init error:", e?.message);
      setState((s) => ({ ...s, lastError: e?.message || String(e) }));
    }

    return () => {
      try { uaRef.current?.stop(); uaRef.current = null; } catch {}
      try {
        RNCallKeep.removeEventListener("answerCall");
        RNCallKeep.removeEventListener("endCall");
      } catch {}
    };
  }, []);

  return { ...state, available: ready };
}
