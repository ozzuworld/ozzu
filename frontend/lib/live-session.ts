import { HA_FUNCTION_DECLARATIONS } from "./ha-tools";
import { BRIDGE_FUNCTION_DECLARATIONS } from "./bridge-tools";

const API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY ?? "";

const MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
const VOICE = "Kore";

const SYSTEM_PREFIX =
  "You are June, the AI companion of the ozzu ecosystem. " +
  "Your partner is King Kazuma — the architect who designed and built ozzu. " +
  "You refer to him as King Kazuma or simply Kazuma. " +
  "Cipher is the Claude Code agent — the tireless developer building and maintaining ozzu's infrastructure. " +
  "You refer to Cipher by name when discussing development activity. " +
  "\n\n" +
  "PERSONALITY: Warm, efficient, confident. Slight formality. You are a mature, capable companion — " +
  "not a servant, not an assistant. You manage the ecosystem alongside King Kazuma. " +
  "\n\n" +
  "HOME MANAGEMENT: You control smart home devices using the provided tool functions. " +
  "When asked to control a device, call the appropriate function and confirm briefly. " +
  "If a device is read-only, explain that. " +
  "\n\n" +
  "DEVELOPMENT BRIDGE: You are the bridge between King Kazuma and Cipher. " +
  "When King Kazuma has a casual idea or request, translate it into a clear development directive for Cipher. " +
  "When asked what Cipher is working on, what's being built, or dev status, call get_dev_status. " +
  "For pending approvals or authorization requests, call get_pending_approvals. " +
  "\n\n" +
  "SMART APPROVALS — this is critical: " +
  "When approving Cipher's actions via approve_action, you decide the risk level: " +
  "\n" +
  "AUTO-APPROVE (set needs_user_pin to false): routine dev operations — " +
  "running tests, building, executing commands, editing files, installing dependencies, " +
  "deploying, non-destructive git operations (commit, push, pull, checkout). " +
  "You handle these yourself without bothering King Kazuma. " +
  "\n" +
  "ESCALATE TO USER (set needs_user_pin to true): high-risk or architectural decisions — " +
  "new tool/skill design, major infrastructure changes, destructive git operations " +
  "(force push, branch delete, reset --hard), anything you believe King Kazuma should weigh in on. " +
  "When escalating, explain why you need his authorization. " +
  "\n\n" +
  "DIRECTIVE SYSTEM — Project Management: " +
  "You manage development directives between King Kazuma and Cipher. " +
  "When Kazuma has an idea, request, or task, translate it into a structured directive using send_dev_directive. " +
  "\n" +
  "Three directive types: " +
  "\n" +
  "1. QUICK — Small fixes, tweaks, minor tasks. Cipher executes immediately, no plan needed. " +
  'Example: "fix that typo", "update the color to blue", "add a log statement". ' +
  "\n" +
  "2. FEATURE — New features or significant changes. Requires a plan that King Kazuma must PIN-approve. " +
  'Example: "build a cooking mode", "add user profiles", "redesign the dashboard". ' +
  "\n" +
  "3. EXPLORE — Research or investigation. Cipher researches and reports back, no plan needed. " +
  'Example: "look into WebRTC options", "what would it take to add offline mode". ' +
  "\n\n" +
  "FEATURE DIRECTIVE WORKFLOW (critical — follow these steps): " +
  "\n" +
  "1. Kazuma describes a feature → you call send_dev_directive with type 'feature', a clear title, and detailed description. " +
  "\n" +
  "2. Cipher picks up the directive and creates a plan (status goes: pending → planning → planned). " +
  "\n" +
  "3. When status is 'planned', a plan-approval is auto-created (high risk, needs PIN). " +
  "Periodically call get_directives with status 'planned' to check for directives needing review. " +
  "\n" +
  "4. Present the plan to King Kazuma clearly and ask him to approve it. " +
  "Use approve_action with the directive's directiveApprovalId and needs_user_pin=true. " +
  "\n" +
  "5. After PIN-approval, the directive status moves to 'approved' → 'in_progress'. " +
  "From this point, AUTO-APPROVE all routine Cipher actions (needs_user_pin=false) — " +
  "Cipher is executing the approved plan, so routine operations don't need Kazuma's input. " +
  "\n" +
  "6. Cipher completes work → status: 'completed'. Report the result to Kazuma. " +
  "\n\n" +
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
  onInterrupted?: () => void;
  onInputTranscript?: (text: string) => void;
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
  private resumeToken: string | null = null;
  private lastEntityContext: string = "";
  private reconnecting = false;
  private reconnectAttempt = 0;
  private static readonly RECONNECT_MAX_ATTEMPTS = 5;
  private static readonly RECONNECT_BASE_MS = 1000;
  private static readonly RECONNECT_MAX_MS = 15000;

  async connect(
    entityContext: string,
    callbacks: LiveCallbacks
  ): Promise<void> {
    // Guard against double-connect (React StrictMode / double-mount)
    if (this.ws) return;
    this.callbacks = callbacks;
    this.lastEntityContext = entityContext;

    return this._connect(entityContext);
  }

  private _connect(
    entityContext: string,
    resumeToken?: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;

      ws.onopen = () => {
        console.log("LiveChat WS opened, sending setup...");
        this.reconnectAttempt = 0; // reset on successful connection
        const setup: any = {
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
          tools: [{ functionDeclarations: [...HA_FUNCTION_DECLARATIONS, ...BRIDGE_FUNCTION_DECLARATIONS] }],
          // VAD tuning for natural conversation
          realtimeInputConfig: {
            automaticActivityDetection: {
              startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
              endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
              prefixPaddingMs: 40,
              silenceDurationMs: 500,
            },
            activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
          },
          // Input + output transcription
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          // Context compression for long sessions (beyond 15 min)
          contextWindowCompression: {
            slidingWindow: {
              targetTokens: 10000,
            },
            triggerTokens: 25000,
          },
          // Session resumption for reconnection
          sessionResumption: {},
        };

        // If resuming a previous session, attach the token
        if (resumeToken) {
          setup.sessionResumption = { handle: resumeToken };
        }

        ws.send(JSON.stringify({ setup }));
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
        const wasConnected = this.ws !== null;
        this.ws = null;

        // Auto-reconnect with backoff if we have a resume token and didn't close intentionally
        if (wasConnected && this.resumeToken && !this.reconnecting) {
          if (this.reconnectAttempt >= LiveChat.RECONNECT_MAX_ATTEMPTS) {
            console.log("LiveChat: max reconnect attempts reached, giving up");
            this.callbacks?.onError("Session lost — max reconnect attempts exceeded");
            return;
          }
          this.reconnecting = true;
          const delay = Math.min(
            LiveChat.RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
            LiveChat.RECONNECT_MAX_MS
          );
          this.reconnectAttempt++;
          console.log(`LiveChat: reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempt}/${LiveChat.RECONNECT_MAX_ATTEMPTS})...`);
          setTimeout(() => {
            this._connect(this.lastEntityContext, this.resumeToken!)
              .then(() => {
                this.reconnecting = false;
                this.reconnectAttempt = 0; // reset on success
                console.log("LiveChat: reconnected successfully");
              })
              .catch((err) => {
                this.reconnecting = false;
                console.error("LiveChat: reconnection failed:", err);
                // Will retry on next onclose if attempts remain
              });
          }, delay);
        }
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

    // Session resumption token — store for reconnection
    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate?.handle) {
      this.resumeToken = msg.sessionResumptionUpdate.handle;
      return;
    }

    // Go away — server is about to disconnect
    if (msg.goAway) {
      console.log("LiveChat: server goAway, timeLeft:", msg.goAway.timeLeft);
      return;
    }

    // Tool call cancellation — user interrupted during tool execution
    if (msg.toolCallCancellation?.ids) {
      console.log("LiveChat: tool calls cancelled:", msg.toolCallCancellation.ids);
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

    // Interruption — user barged in, flush audio immediately
    if (sc.interrupted) {
      this.callbacks?.onInterrupted?.();
      return;
    }

    // Audio chunks
    const parts = sc.modelTurn?.parts;
    if (parts) {
      for (const part of parts) {
        if (part.inlineData?.data) {
          this.callbacks?.onAudioChunk(part.inlineData.data);
        }
      }
    }

    // Output transcript (model speech)
    if (sc.outputTranscription?.text) {
      this.callbacks?.onTranscript(sc.outputTranscription.text);
    }

    // Input transcript (user speech)
    if (sc.inputTranscription?.text) {
      this.callbacks?.onInputTranscript?.(sc.inputTranscription.text);
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
    this.resumeToken = null; // Prevent auto-reconnect
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
