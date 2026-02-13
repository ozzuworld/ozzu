// BridgeSession — WebSocket client for multi-device audio via bridge server
// Tablets connect as "mic", TV connects as "speaker"

import { getDeviceType } from "../modules/pcm-player";

const BRIDGE_WS_URL =
  (process.env.EXPO_PUBLIC_BRIDGE_URL || "http://10.8.0.1:3333").replace(
    /^http/,
    "ws"
  ) + "/ws";

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
  onListeningReady: () => void;
  onError: (message: string) => void;
}

export class BridgeSession {
  private ws: WebSocket | null = null;
  private callbacks: BridgeCallbacks | null = null;
  private _role: "mic" | "speaker" = "mic";
  private deviceId: string = "unknown";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;

  get role(): "mic" | "speaker" {
    return this._role;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(callbacks: BridgeCallbacks): void {
    if (this.ws) return;
    this.callbacks = callbacks;
    this.intentionallyClosed = false;

    // Detect device type
    try {
      const type = getDeviceType();
      this._role = type === "tv" ? "speaker" : "mic";
    } catch {
      this._role = "mic";
    }
    this.deviceId = `${this._role}-${Date.now()}`;

    this._connect();
  }

  private _connect(): void {
    console.log(`[BridgeSession] Connecting to ${BRIDGE_WS_URL} as ${this._role}...`);

    const ws = new WebSocket(BRIDGE_WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      console.log("[BridgeSession] Connected, registering...");
      ws.send(
        JSON.stringify({
          type: "register",
          role: this._role,
          deviceId: this.deviceId,
        })
      );
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
        console.log("[BridgeSession] Reconnecting in 5s...");
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (!this.intentionallyClosed) this._connect();
        }, 5000);
      }
    };
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case "ready":
        this.callbacks?.onReady();
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
      case "error":
        this.callbacks?.onError(msg.message);
        break;
    }
  }

  sendAudio(pcmBase64: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "audio", data: pcmBase64 }));
    }
  }

  sendText(text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "text", text }));
    }
  }

  sendPinResponse(approvalId: string, pin: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({ type: "pinResponse", approvalId, pin })
      );
    }
  }

  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.callbacks = null;
  }
}
