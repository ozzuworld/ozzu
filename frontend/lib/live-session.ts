import { HA_FUNCTION_DECLARATIONS } from "./ha-tools";

const API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY ?? "";

const MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
const VOICE = "Orus";

const SYSTEM_PREFIX =
  "You are the AI overseer of a smart home called ozzu. " +
  "Concise, slightly sci-fi tone. " +
  "You can control devices using the provided tool functions. " +
  "When the user asks you to control a device, call the appropriate function. " +
  "After a successful action, confirm what you did briefly. " +
  "If a device is not controllable, explain that it is read-only. " +
  "Current entity states:\n";

const WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

export interface ToolCallResult {
  success: boolean;
  message: string;
}

export interface LiveCallbacks {
  onAudioChunk: (pcmBase64: string) => void;
  onTranscript: (text: string) => void;
  onTurnComplete: () => void;
  onError: (msg: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;
}

interface FunctionCall {
  name?: string;
  args?: Record<string, unknown>;
  id?: string;
}

export class LiveChat {
  private ws: WebSocket | null = null;
  private callbacks: LiveCallbacks | null = null;
  private msgCount = 0;

  async connect(
    entityContext: string,
    callbacks: LiveCallbacks
  ): Promise<void> {
    this.callbacks = callbacks;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;

      ws.onopen = () => {
        console.log("LiveChat WS opened, sending setup...");
        ws.send(JSON.stringify({
          setup: {
            model: `models/${MODEL}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
              },
            },
            systemInstruction: {
              parts: [{ text: SYSTEM_PREFIX + entityContext }],
            },
            tools: [{ functionDeclarations: HA_FUNCTION_DECLARATIONS }],
            outputAudioTranscription: {},
          },
        }));
      };

      ws.onmessage = (event: any) => {
        this.msgCount++;
        const n = this.msgCount;
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
          this.handleParsedMessage(msg, n, resolve);
        } catch (_err) {
          // Parse or handling error — skip this message
        }
      };

      ws.onerror = (e: any) => {
        console.error("LiveChat WS error:", e.message ?? e);
        this.callbacks?.onError(e.message ?? "Live API error");
        reject(new Error(e.message ?? "WebSocket error"));
      };

      ws.onclose = () => {
        console.log("LiveChat WS closed, total msgs:", this.msgCount);
        this.ws = null;
      };
    });
  }

  private handleParsedMessage(
    msg: any,
    _n: number,
    onSetupComplete?: (value: void) => void
  ) {
    // Setup complete
    if (msg.setupComplete !== undefined) {
      onSetupComplete?.();
      return;
    }

    // Tool calls
    if (msg.toolCall?.functionCalls) {
      this.handleToolCalls(msg.toolCall.functionCalls);
      return;
    }

    // Server content
    const sc = msg.serverContent;
    if (!sc) return;

    // Audio chunks
    const parts = sc.modelTurn?.parts;
    if (parts) {
      for (const part of parts) {
        if (part.inlineData?.data) {
          this.callbacks?.onAudioChunk(part.inlineData.data);
        }
      }
    }

    // Transcript
    if (sc.outputTranscription?.text) {
      this.callbacks?.onTranscript(sc.outputTranscription.text);
    }

    // Turn complete
    if (sc.turnComplete) {
      this.callbacks?.onTurnComplete();
    }
  }

  setCallbacks(callbacks: LiveCallbacks) {
    this.callbacks = callbacks;
  }

  send(text: string) {
    console.log("LiveChat send:", text.substring(0, 50), "ws:", this.ws?.readyState);
    this.ws?.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text }] }],
          turnComplete: true,
        },
      })
    );
  }

  sendAudio(pcmBase64: string) {
    this.ws?.send(
      JSON.stringify({
        realtimeInput: {
          mediaChunks: [
            { data: pcmBase64, mimeType: "audio/pcm;rate=16000" },
          ],
        },
      })
    );
  }

  close() {
    this.ws?.close();
    this.ws = null;
    this.callbacks = null;
  }

  get connected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private async handleToolCalls(functionCalls: FunctionCall[]) {
    const responses = await Promise.all(
      functionCalls.map(async (fc) => {
        const name = fc.name ?? "unknown";
        const args = (fc.args as Record<string, unknown>) ?? {};
        let result: ToolCallResult;

        if (this.callbacks?.onToolCall) {
          try {
            result = await this.callbacks.onToolCall(name, args);
          } catch (err: any) {
            result = { success: false, message: err?.message ?? "Tool call failed" };
          }
        } else {
          result = { success: false, message: "No tool handler registered" };
        }

        return {
          id: fc.id,
          name,
          response: { success: result.success, message: result.message },
        };
      })
    );

    this.ws?.send(
      JSON.stringify({ toolResponse: { functionResponses: responses } })
    );
  }
}
