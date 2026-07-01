import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

// WebRTC call leg — JsSIP (SIP-over-WSS signaling) + react-native-webrtc (DTLS-SRTP media).
// registerGlobals() puts RTCPeerConnection / MediaStream / getUserMedia on the global object
// so JsSIP drives them; RN's global WebSocket already handles wss:// + subprotocols.
//
// ROUND 1 (dir_1782922636595): register to Asterisk's WebRTC endpoint and AUTO-ANSWER an
// inbound call to prove 2-way audio over WebRTC (no WireGuard needed — WebRTC traverses NAT).
// The native CallKit UI (react-native-callkeep) + the June briefing hook-up come in Round 2.
let rnwebrtc: any = null;
let JsSIP: any = null;
let InCallManager: any = null;
let ready = false;
try {
  if (Platform.OS === "ios") {
    rnwebrtc = require("react-native-webrtc");
    rnwebrtc.registerGlobals();
    JsSIP = require("jssip");
    InCallManager = require("react-native-incall-manager").default;
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

export interface WebrtcState {
  registered: boolean;
  inCall: boolean;
  lastError: string | null;
}

export function useWebrtcCall() {
  const [state, setState] = useState<WebrtcState>({ registered: false, inCall: false, lastError: null });
  const uaRef = useRef<any>(null);

  useEffect(() => {
    if (!ready || uaRef.current) return;
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

      ua.on("connected", () => console.log("[webrtc] ws connected"));
      ua.on("disconnected", () => console.log("[webrtc] ws disconnected"));
      ua.on("registered", () => {
        console.log("[webrtc] REGISTERED to Asterisk");
        setState((s) => ({ ...s, registered: true, lastError: null }));
      });
      ua.on("unregistered", () => setState((s) => ({ ...s, registered: false })));
      ua.on("registrationFailed", (e: any) => {
        console.warn("[webrtc] registration failed:", e?.cause);
        setState((s) => ({ ...s, registered: false, lastError: e?.cause || "registration failed" }));
      });

      ua.on("newRTCSession", (data: any) => {
        const { originator, session } = data;
        if (originator !== "remote") return; // inbound calls only
        console.log("[webrtc] incoming call — auto-answering (Round 1)");
        InCallManager.start({ media: "audio" });
        // audio-only: react-native-webrtc plays the remote audio track automatically once
        // the peerconnection receives it; InCallManager owns the route (earpiece/speaker).
        session.connection?.addEventListener?.("track", () => console.log("[webrtc] remote track received"));
        session.answer({
          mediaConstraints: { audio: true, video: false },
          pcConfig: { iceServers: [{ urls: STUN }] },
        });
        setState((s) => ({ ...s, inCall: true }));
        const end = () => {
          try { InCallManager.stop(); } catch {}
          setState((s) => ({ ...s, inCall: false }));
        };
        session.on("ended", end);
        session.on("failed", end);
      });

      ua.start();
    } catch (e: any) {
      console.error("[webrtc] UA init error:", e?.message);
      setState((s) => ({ ...s, lastError: e?.message || String(e) }));
    }

    return () => {
      try { uaRef.current?.stop(); uaRef.current = null; } catch {}
    };
  }, []);

  return { ...state, available: ready };
}
