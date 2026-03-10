// BridgeSession — WebSocket client for multi-device audio via bridge server
// Tablets connect as "mic", TV connects as "speaker"

import { getDeviceType } from "../modules/pcm-player";
import { Dimensions, Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { getBridgeMode } from "./bridge-api";

// Module-level cache: survives reconnects even if FileSystem persistence fails (e.g. iOS sideloaded apps)
let cachedDeviceId: string | null = null;

const LAN_WS_URL =
  (process.env.EXPO_PUBLIC_BRIDGE_URL || "https://home.ozzu.world/bridge").replace(
    /^https/,
    "wss"
  ).replace(
    /^http/,
    "ws"
  ) + "/ws";

const PUBLIC_BASE =
  process.env.EXPO_PUBLIC_BRIDGE_PUBLIC_URL || "https://home.ozzu.world/bridge";
const PUBLIC_WS_URL =
  PUBLIC_BASE.replace(/^https/, "wss").replace(/^http/, "ws") + "/ws";

const BRIDGE_API_KEY = process.env.EXPO_PUBLIC_BRIDGE_API_KEY || "";

function getWsUrl(): string {
  const mode = getBridgeMode();
  if (mode === "remote") {
    // Append token for public WS auth
    const base = PUBLIC_WS_URL;
    return BRIDGE_API_KEY ? `${base}?token=${BRIDGE_API_KEY}` : base;
  }
  return LAN_WS_URL;
}

export interface BridgeCallbacks {
  onReady: () => void;
  onAudioChunk: (pcmBase64: string) => void;
  onTranscript: (text: string) => void;
  onInputTranscript: (text: string) => void;
  onTurnComplete: () => void;
  onInterrupted: () => void;
  onPinRequest: (approvalId: string, description: string) => void;
  onPinResolved: () => void;
  onShowCamera: (cameraId: string, streamUrl: string, cameraName: string) => void;
  onHideCamera: () => void;
  onShowContent: (title: string, content: string) => void;
  onHideContent: () => void;
  onConnected: () => void;
  onListeningReady: () => void;
  onCipherResponse?: (text: string) => void; // Phone-mode: Claude response text for on-device TTS
  onAudioRoutingUpdate?: (data: any) => void; // Audio routing state changed
  onDirectiveUpdate?: (data: any) => void; // Directive status/build changed (from bridge broadcast)
  onVisionResult?: (mode: string, text: string) => void; // Glasses vision analysis result
  onGestureControlFeedback?: (data: { entityId: string; deviceName: string; action: string; state?: any; error?: string }) => void;
  onGlassesImmersiveRequest?: (data: { enable: boolean }) => void;
  onOpsAlert?: (data: { service: string; status: string; previousStatus: string; severity: string; ts: string; details: any }) => void;
  onError: (message: string) => void;
}

export class BridgeSession {
  private ws: WebSocket | null = null;
  private callbacks: BridgeCallbacks | null = null;
  private _role: "mic" | "speaker" = "mic";
  private deviceId: string = "unknown";
  private _deviceType: string = "tablet";
  private _cipherVoice = false; // true when cipher-voice native module is available (iPhone on-device STT/TTS)
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private reconnectAttempt = 0;
  private pendingMessages: string[] = []; // queued during reconnection
  private static readonly RECONNECT_BASE_MS = 1000;
  private static readonly RECONNECT_MAX_MS = 30000;
  private static readonly RECONNECT_MAX_ATTEMPTS = 50;
  private static readonly MAX_PENDING_MESSAGES = 20;

  get role(): "mic" | "speaker" {
    return this._role;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get hasCipherVoice(): boolean {
    return this._cipherVoice;
  }

  /** Enable cipher-voice mode (call before connect if cipher-voice module is available) */
  setCipherVoice(enabled: boolean): void {
    this._cipherVoice = enabled;
  }

  async connect(callbacks: BridgeCallbacks): Promise<void> {
    if (this.ws) return;
    this.callbacks = callbacks;
    this.intentionallyClosed = false;

    // Detect device type
    let nativeType = "tablet";
    try {
      nativeType = getDeviceType();
      this._role = nativeType === "tv" ? "speaker" : "mic";
    } catch {
      this._role = "mic";
    }
    // Distinguish phone from tablet for mic devices
    if (nativeType !== "tv") {
      const { width } = Dimensions.get("screen");
      this._deviceType = width < 500 ? "phone" : "tablet";
    } else {
      this._deviceType = "tv";
    }

    // Stable deviceId: persist a UUID so preferences survive reconnects
    // Use module-level cache first (survives reconnects even if FileSystem fails on sideloaded iOS)
    if (cachedDeviceId) {
      this.deviceId = cachedDeviceId;
    } else {
      const idFile = `${FileSystem.documentDirectory}ozzu-device-id.txt`;
      let storedId: string | null = null;
      try {
        const info = await FileSystem.getInfoAsync(idFile);
        if (info.exists) storedId = await FileSystem.readAsStringAsync(idFile);
      } catch {}
      if (storedId) {
        this.deviceId = storedId;
        cachedDeviceId = storedId;
      } else {
        const uuid = "xxxx-xxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
        this.deviceId = `ozzu-${this._deviceType}-${uuid}`;
        cachedDeviceId = this.deviceId;
        try { await FileSystem.writeAsStringAsync(idFile, this.deviceId); } catch {}
      }
    }

    this._connect();
  }

  private _connect(): void {
    const wsUrl = getWsUrl();
    console.log(`[BridgeSession] Connecting to ${wsUrl} as ${this._role}...`);

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      console.log("[BridgeSession] Connected, registering...");
      this.reconnectAttempt = 0; // Reset backoff on successful connection
      const registration: Record<string, any> = {
        type: "register",
        role: this._role,
        deviceId: this.deviceId,
        deviceType: this._deviceType,
      };
      // Include capabilities for cipher-voice-capable phones
      if (this._cipherVoice && this._deviceType === "phone") {
        registration.capabilities = {
          mic: true,
          speaker: true,
          cipherVoice: true, // Tells bridge to use textOnly mode
        };
      }
      ws.send(JSON.stringify(registration));
    };

    ws.onmessage = (event: any) => {
      try {
        let jsonStr: string;
        const d = event.data;
        if (typeof d === "string") {
          jsonStr = d;
        } else if (d instanceof ArrayBuffer) {
          jsonStr = new TextDecoder().decode(d);
        } else if (d && typeof d.toString === "function") {
          jsonStr = d.toString();
        } else {
          return;
        }
        const msg = JSON.parse(jsonStr);
        this.handleMessage(msg);
      } catch {
        // skip unparseable
      }
    };

    ws.onerror = (e: any) => {
      console.error("[BridgeSession] Error:", e.message ?? e);
      this.callbacks?.onError(e.message ?? "Bridge connection error");
    };

    ws.onclose = () => {
      console.log("[BridgeSession] Disconnected");
      this.ws = null;

      if (!this.intentionallyClosed) {
        if (this.reconnectAttempt >= BridgeSession.RECONNECT_MAX_ATTEMPTS) {
          console.log("[BridgeSession] Max reconnect attempts reached, giving up");
          this.callbacks?.onError("Bridge connection lost — max retries exceeded");
          return;
        }
        const delay = Math.min(
          BridgeSession.RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
          BridgeSession.RECONNECT_MAX_MS
        );
        this.reconnectAttempt++;
        console.log(`[BridgeSession] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempt})...`);
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (!this.intentionallyClosed) this._connect();
        }, delay);
      }
    };
  }

  private handleMessage(msg: any): void {
    try {
      switch (msg.type) {
        case "ready":
          this.callbacks?.onReady();
          // Flush any messages queued during reconnection
          if (this.pendingMessages.length > 0) {
            for (const queued of this.pendingMessages) {
              this.ws?.send(queued);
            }
            this.pendingMessages = [];
          }
          this.callbacks?.onConnected();
          break;
        case "audio":
          this.callbacks?.onAudioChunk(msg.data);
          break;
        case "transcript":
          this.callbacks?.onTranscript(msg.text);
          break;
        case "inputTranscript":
          this.callbacks?.onInputTranscript(msg.text);
          break;
        case "turnComplete":
          this.callbacks?.onTurnComplete();
          break;
        case "interrupted":
          this.callbacks?.onInterrupted();
          break;
        case "pinRequest":
          this.callbacks?.onPinRequest(msg.approvalId, msg.description);
          break;
        case "pinResolved":
          this.callbacks?.onPinResolved();
          break;
        case "showCamera":
          this.callbacks?.onShowCamera(msg.cameraId, msg.streamUrl, msg.cameraName);
          break;
        case "hideCamera":
          this.callbacks?.onHideCamera();
          break;
        case "showContent":
          this.callbacks?.onShowContent(msg.title, msg.content);
          break;
        case "hideContent":
          this.callbacks?.onHideContent();
          break;
        case "listeningReady":
          this.callbacks?.onListeningReady();
          break;
        case "cipherResponse":
          this.callbacks?.onCipherResponse?.(msg.text);
          break;
        case "audioRoutingUpdate":
          this.callbacks?.onAudioRoutingUpdate?.(msg);
          break;
        case "directiveUpdate":
          this.callbacks?.onDirectiveUpdate?.(msg);
          break;
        case "visionResult":
          this.callbacks?.onVisionResult?.(msg.mode, msg.text);
          break;
        case "gestureControlFeedback":
          this.callbacks?.onGestureControlFeedback?.(msg);
          break;
        case "glassesImmersiveRequest":
          this.callbacks?.onGlassesImmersiveRequest?.(msg);
          break;
        case "opsAlert":
          this.callbacks?.onOpsAlert?.(msg);
          break;
        case "error":
          this.callbacks?.onError(msg.message);
          break;
      }
    } catch (err) {
      console.error("[BridgeSession] handleMessage error:", err);
    }
  }

  sendAudio(pcmBase64: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "audio", data: pcmBase64 }));
    }
  }

  private _queueMessage(msg: string): void {
    if (this.pendingMessages.length >= BridgeSession.MAX_PENDING_MESSAGES) {
      this.pendingMessages.shift(); // drop oldest
    }
    this.pendingMessages.push(msg);
  }

  sendText(text: string): void {
    const msg = JSON.stringify({ type: "text", text });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    } else if (!this.intentionallyClosed) {
      this._queueMessage(msg);
    }
  }

  sendUpload(target: "cipher" | "june", contentType: "image" | "document" | "text", data: string, filename?: string): void {
    const msg = JSON.stringify({ type: "upload", target, contentType, data, filename });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    } else if (!this.intentionallyClosed) {
      this._queueMessage(msg);
    }
  }

  sendPinResponse(approvalId: string, pin: string): void {
    const msg = JSON.stringify({ type: "pinResponse", approvalId, pin });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    } else if (!this.intentionallyClosed) {
      this._queueMessage(msg);
    }
  }

  // ── Cipher voice (phone on-device STT/TTS) ──

  /** Send STT-transcribed text to bridge for Claude processing */
  sendCipherText(text: string): void {
    const msg = JSON.stringify({ type: "cipherText", text });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    } else if (!this.intentionallyClosed) {
      this._queueMessage(msg);
    }
  }

  /** Send TTS audio (PCM base64) to bridge for relay to tablets/TV */
  sendCipherAudio(pcmBase64: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "cipherAudio", data: pcmBase64 }));
    }
  }

  /** Signal that TTS playback finished */
  sendCipherTtsDone(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "cipherTtsDone" }));
    }
  }

  /** Send debug log to bridge for remote visibility */
  sendDebug(msg: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "debugLog", msg }));
    }
  }

  /** Send crash report via HTTP (works even when WS is down) */
  sendCrashReport(error: string, stack?: string | null, componentStack?: string | null, context?: string | null): void {
    // Use dynamic URL — import inline to avoid circular deps
    const { getBridgeUrl } = require("./bridge-api");
    const bridgeUrl = getBridgeUrl();
    const body = JSON.stringify({
      deviceId: this.deviceId,
      deviceType: this._deviceType,
      platform: Platform.OS,
      error,
      stack: stack || null,
      componentStack: componentStack || null,
      context: context || null,
    });
    fetch(`${bridgeUrl}/api/crash-reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }).catch(() => {}); // fire-and-forget
  }

  sendVisionRequest(mode: string, frameData: string, width: number, height: number): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "glassesVisionRequest", mode, data: frameData, width, height }));
    }
  }

  sendGestureCommand(data: { gesture: string; action: string; fingerCount?: number; timestamp: number }): void {
    const msg = JSON.stringify({ type: "gestureCommand", ...data });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    }
  }

  sendTargetedGestureCommand(data: {
    gesture: string;
    service: string;
    entityId: string;
    domain: string;
    deviceName: string;
    continuous: boolean;
    continuousValue?: number;
    attribute?: string;
    min?: number;
    max?: number;
    timestamp: number;
  }): void {
    const msg = JSON.stringify({ type: "targetedGestureCommand", ...data });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    }
  }

  sendSceneChange(objects: { label: string; score: number }[]): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "sceneChange", objects }));
    }
  }

  sendGlassesFrame(data: string, width: number, height: number): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "glassesFrame", data, width, height }));
    }
  }

  sendGlassesPhoto(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "glassesPhoto", data, format: "jpeg" }));
    }
  }

  sendGlassesStatus(state: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "glassesStatus", state }));
    }
  }

  sendGlassesImmersiveState(state: string, error?: string): void {
    const msg: Record<string, any> = { type: "glassesImmersiveState", state };
    if (error) msg.error = error;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.intentionallyClosed = true;
    this.pendingMessages = [];
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.callbacks = null;
  }
}
