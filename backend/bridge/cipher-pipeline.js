// Cipher Pipeline: Deepgram STT → Claude Agent SDK → Deepgram Aura TTS
// Uses Max subscription via OAuth — no separate API key needed.
// The Agent SDK spawns Claude Code as a subprocess, giving Cipher
// full codebase access (Read, Bash, Grep) plus custom bridge tools via MCP.

const { EventEmitter } = require("events");
const { createClient, LiveTranscriptionEvents, LiveTTSEvents } = require("@deepgram/sdk");

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const CIPHER_VOICE = process.env.CIPHER_VOICE || "aura-2-orion-en"; // Approachable, Comfortable, Calm

// Lazy-load ESM modules (Agent SDK is ESM-only)
let _sdkModule = null;
async function getSDK() {
  if (!_sdkModule) _sdkModule = await import("@anthropic-ai/claude-agent-sdk");
  return _sdkModule;
}

class CipherPipeline extends EventEmitter {
  constructor({ systemPrompt, tools, handleToolCall }) {
    super();
    this.systemPrompt = systemPrompt;
    this.tools = tools; // Gemini-format tool declarations (will be wrapped as MCP tools)
    this.handleToolCall = handleToolCall; // async (name, args) => { success, message }
    this.running = false;
    this.speaking = false;

    // Deepgram client (shared for both STT and TTS)
    this.deepgramClient = DEEPGRAM_API_KEY ? createClient(DEEPGRAM_API_KEY) : null;

    // STT connection
    this.dgSTT = null;

    // TTS connection
    this.dgTTS = null;
    this._ttsActive = false; // true while streaming a response to TTS

    // Claude Agent SDK state
    this._messageQueue = [];
    this._messageResolve = null;
    this._queryRunning = false;
    this._abortController = null;
    this._query = null;

    // Utterance accumulator for Deepgram partials
    this._utteranceBuffer = "";

    // Turn-based state: "cipher" (speaking/thinking) or "user" (listening)
    // Mic and speaker never overlap — eliminates echo entirely.
    this._turn = "cipher"; // start as cipher's turn (greeting)
    this._turnReady = false; // true when mic is open for user

    // Estimated playback end time (TTS audio sent faster than real-time)
    this._estimatedPlaybackEnd = 0;
    this._ttsFlushing = false; // true between _flushTTS() and Flushed event

    // Mic-open timer: cancelled when new TTS starts (prevents race condition
    // when Cipher speaks → tool call → speaks again, causing two Flushed events)
    this._micOpenTimer = null;

    // Audio buffering: accumulate small TTS chunks into ~100ms packets
    // to prevent choppy playback from many tiny WebSocket messages
    this._audioBuffer = [];
    this._audioBufferBytes = 0;
    this._audioFlushTimer = null;
    // 24kHz * 2 bytes * 0.1s = 4800 bytes per 100ms of audio
    this._audioBufferTarget = 4800;
  }

  async start() {
    this.running = true;
    console.log("[cipher] Starting pipeline...");

    // Start Deepgram STT
    this._connectSTT();

    // Start Deepgram Aura TTS
    if (this.deepgramClient) {
      try {
        this.dgTTS = this.deepgramClient.speak.live({
          model: CIPHER_VOICE,
          encoding: "linear16",
          sample_rate: 24000,
        });

        this.dgTTS.on(LiveTTSEvents.Open, () => {
          console.log("[cipher] Deepgram TTS connected (voice: %s)", CIPHER_VOICE);
        });

        this.dgTTS.on(LiveTTSEvents.Audio, (data) => {
          // Buffer small chunks into ~100ms packets for smooth playback
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (!this._ttsAudioCount) this._ttsAudioCount = 0;
          this._ttsAudioCount++;
          if (this._ttsAudioCount <= 3) {
            console.log("[cipher] TTS Audio event #%d: %d bytes, type=%s", this._ttsAudioCount, buf.length, typeof data);
          }
          this._audioBuffer.push(buf);
          this._audioBufferBytes += buf.length;

          if (this._audioBufferBytes >= this._audioBufferTarget) {
            this._emitBufferedAudio();
          } else if (!this._audioFlushTimer) {
            // Flush after 80ms even if buffer isn't full (keeps latency low)
            this._audioFlushTimer = setTimeout(() => this._emitBufferedAudio(), 80);
          }
        });

        this.dgTTS.on(LiveTTSEvents.Flushed, () => {
          // Emit any remaining buffered audio
          this._emitBufferedAudio();
          this._ttsFlushing = false;
          console.log("[cipher] TTS flushed");
          this.speaking = false;
          // Wait for tablet to finish playing, then open mic
          // playbackRemaining = estimated time until tablet speaker finishes
          // networkBuffer = 3s for VPN transit + Android audio buffer + acoustic echo decay
          // Minimum 4s total to ensure speaker has fully stopped before mic opens
          const playbackRemaining = Math.max(0, (this._estimatedPlaybackEnd || 0) - Date.now());
          const delay = Math.max(playbackRemaining + 3000, 4000);
          console.log("[cipher] Mic opens in %dms (playback remaining: %dms)", delay, playbackRemaining);
          // Store timer so _startTTS() can cancel it if Cipher speaks again
          if (this._micOpenTimer) clearTimeout(this._micOpenTimer);
          this._micOpenTimer = setTimeout(() => {
            this._micOpenTimer = null;
            if (!this.running) return;
            this._turn = "user";
            this._turnReady = true;
            this.emit("listeningReady");
            console.log("[cipher] Turn: user (listening)");
          }, delay);
        });

        this.dgTTS.on(LiveTTSEvents.Warning, (warning) => {
          console.warn("[cipher] TTS warning:", warning);
        });

        this.dgTTS.on(LiveTTSEvents.Error, (err) => {
          console.error("[cipher] Deepgram TTS error:", err);
        });

        this.dgTTS.on(LiveTTSEvents.Close, () => {
          console.log("[cipher] Deepgram TTS closed");
        });
      } catch (err) {
        console.error("[cipher] Deepgram TTS init failed:", err.message);
        this.dgTTS = null;
      }
    } else {
      console.warn("[cipher] No DEEPGRAM_API_KEY — TTS disabled, text output only");
    }

    // Start Claude Agent SDK query loop (runs in background)
    this._startClaudeSession();

    console.log("[cipher] Pipeline ready (STT: %s, TTS: %s, LLM: agent-sdk)",
      this.dgSTT ? "ok" : "off",
      this.dgTTS ? "ok" : "off"
    );
    return true;
  }

  _connectSTT() {
    if (!this.deepgramClient) {
      console.warn("[cipher] No DEEPGRAM_API_KEY — STT disabled, text input only");
      return;
    }
    if (this.dgSTT) return; // already connected

    try {
      this.dgSTT = this.deepgramClient.listen.live({
        model: "nova-2",
        encoding: "linear16",
        sample_rate: 16000,
        channels: 1,
        smart_format: true,
        utterance_end_ms: 5000,
        interim_results: true,
        endpointing: 1500,
      });

      this.dgSTT.on(LiveTranscriptionEvents.Open, () => {
        console.log("[cipher] Deepgram STT connected");
      });

      this.dgSTT.on(LiveTranscriptionEvents.Transcript, (data) => {
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (!transcript) return;

        if (data.is_final) {
          this._utteranceBuffer += transcript + " ";
        } else {
          this.emit("interimTranscript", this._utteranceBuffer + transcript);
        }
      });

      this.dgSTT.on(LiveTranscriptionEvents.UtteranceEnd, () => {
        const text = this._utteranceBuffer.trim();
        this._utteranceBuffer = "";
        if (!text) return;

        // Turn-based: only accept input when it's user's turn
        if (this._turn !== "user") {
          console.log(`[cipher] STT (blocked, cipher's turn): "${text}"`);
          return;
        }

        this._turn = "cipher";
        this._turnReady = false;
        console.log(`[cipher] STT: "${text}"`);
        this.emit("inputTranscript", text);
        this._enqueueUserMessage(text);
      });

      this.dgSTT.on(LiveTranscriptionEvents.Error, (err) => {
        console.error("[cipher] Deepgram STT error:", err.message);
      });

      this.dgSTT.on(LiveTranscriptionEvents.Close, () => {
        console.log("[cipher] Deepgram STT closed");
        this.dgSTT = null;
        // Auto-reconnect if pipeline is still running
        if (this.running) {
          console.log("[cipher] Deepgram STT reconnecting in 1s...");
          setTimeout(() => {
            if (this.running) this._connectSTT();
          }, 1000);
        }
      });
    } catch (err) {
      console.error("[cipher] Deepgram STT init failed:", err.message);
      this.dgSTT = null;
    }
  }

  sendAudio(pcmBase64) {
    if (!this.dgSTT || !this.running) return;
    const buf = Buffer.from(pcmBase64, "base64");
    this.dgSTT.send(buf);
  }

  async sendText(text) {
    if (!text.trim() || !this.running) return;
    console.log(`[cipher] Text input: "${text}"`);
    this.emit("inputTranscript", text);
    this._enqueueUserMessage(text);
  }

  async sendSystemPrompt(text) {
    if (!this.running) return;
    this._enqueueUserMessage(text);
  }

  interrupt() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    this._cancelTTS();
    this.speaking = false;
    this.emit("interrupted");
  }

  async stop() {
    this.running = false;
    console.log("[cipher] Stopping pipeline...");

    if (this.dgSTT) {
      try { this.dgSTT.requestClose(); } catch {}
      this.dgSTT = null;
    }
    if (this.dgTTS) {
      try { this.dgTTS.requestClose(); } catch {}
      this.dgTTS = null;
    }
    if (this._query) {
      try { this._query.close(); } catch {}
      this._query = null;
    }
    if (this._messageResolve) {
      this._messageResolve(null);
      this._messageResolve = null;
    }

    console.log("[cipher] Pipeline stopped");
  }

  isSpeaking() {
    return this.speaking;
  }

  // ── Claude Agent SDK session ──

  async _startClaudeSession() {
    try {
      const { query, tool, createSdkMcpServer } = await getSDK();

      const bridgeServer = this._createBridgeMcpServer(tool, createSdkMcpServer);

      const allowedTools = this.tools.map(t => `mcp__bridge__${t.name}`);
      allowedTools.push("Read", "Glob", "Grep", "Bash");

      const self = this;

      async function* messageGenerator() {
        while (self.running) {
          const msg = await self._waitForMessage();
          if (!msg || !self.running) break;
          yield {
            type: "user",
            message: { role: "user", content: msg },
            parent_tool_use_id: null,
            session_id: "",
          };
        }
      }

      console.log("[cipher] Starting Claude Agent SDK session...");

      this._query = query({
        prompt: messageGenerator(),
        options: {
          systemPrompt: this.systemPrompt,
          includePartialMessages: true,
          mcpServers: { bridge: bridgeServer },
          allowedTools,
          maxTurns: Infinity,
          model: process.env.CIPHER_MODEL || "sonnet",
          cwd: "/home/gcp/ozzu",
          persistSession: false,
          permissionMode: "acceptEdits",
          stderr: (data) => {
            if (data.includes("error") || data.includes("Error")) {
              console.error("[cipher-sdk-stderr]", data.trim());
            }
          },
        },
      });

      for await (const message of this._query) {
        if (!this.running) break;
        this._handleSDKMessage(message);
      }

      console.log("[cipher] Claude Agent SDK session ended");
    } catch (err) {
      console.error("[cipher] Agent SDK error:", err.message);
      this.emit("error", err);
    }
  }

  _createBridgeMcpServer(toolFn, createSdkMcpServer) {
    const self = this;
    const z = require("zod");

    const mcpTools = this.tools.map((geminiTool) => {
      const props = geminiTool.parameters?.properties || {};
      const required = geminiTool.parameters?.required || [];
      const zodShape = {};

      for (const [key, val] of Object.entries(props)) {
        let zodType;
        switch ((val.type || "").toUpperCase()) {
          case "NUMBER": zodType = z.number(); break;
          case "INTEGER": zodType = z.number().int(); break;
          case "BOOLEAN": zodType = z.boolean(); break;
          default: zodType = z.string();
        }
        if (val.enum) zodType = z.enum(val.enum);
        if (val.description) zodType = zodType.describe(val.description);
        if (!required.includes(key)) zodType = zodType.optional();
        zodShape[key] = zodType;
      }

      return toolFn(
        geminiTool.name,
        geminiTool.description,
        zodShape,
        async (args) => {
          let result;
          try {
            result = await self.handleToolCall(geminiTool.name, args);
          } catch (err) {
            result = { success: false, message: err.message };
          }
          console.log(`[cipher] Tool ${geminiTool.name} → ${result.success ? "ok" : "fail"}: ${result.message?.substring(0, 80)}`);
          self.emit("toolCall", { name: geminiTool.name, args, result });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
      );
    });

    return createSdkMcpServer({
      name: "bridge",
      version: "1.0.0",
      tools: mcpTools,
    });
  }

  _handleSDKMessage(message) {
    // Stream events give us text deltas for real-time TTS
    if (message.type === "stream_event") {
      const event = message.event;

      if (event.type === "content_block_start" && event.content_block?.type === "text") {
        this._startTTS();
      }

      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        const text = event.delta.text;
        this.emit("responseText", text);
        this._sendToTTS(text);
      }

      if (event.type === "content_block_stop" && this._ttsActive) {
        this._flushTTS();
      }

      return;
    }

    // Complete assistant message
    if (message.type === "assistant") {
      const textParts = (message.message?.content || [])
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("");

      if (textParts) {
        console.log(`[cipher] Response: "${textParts.substring(0, 120)}${textParts.length > 120 ? "..." : ""}"`);
        this.emit("outputTranscript", textParts);
      }
      return;
    }

    // Result message (end of turn)
    if (message.type === "result") {
      this.speaking = false;
      if (message.subtype === "error_max_turns") {
        console.warn("[cipher] Max turns reached");
      } else if (message.is_error) {
        console.error("[cipher] SDK result error:", message.subtype, message.errors?.join(", "));
      }
      // If Claude ran tools but didn't speak (no TTS), open mic
      // Don't open if TTS is still flushing — Flushed handler will do it
      if (this._turn === "cipher" && !this._ttsActive && !this._ttsFlushing) {
        this._turn = "user";
        this._turnReady = true;
        this.emit("listeningReady");
        console.log("[cipher] Turn: user (listening, after tool-only turn)");
      }
      return;
    }

    // System messages (init, auth, status)
    if (message.type === "system") {
      if (message.subtype === "init") {
        console.log(`[cipher] SDK init: model=${message.model}, tools=${message.tools?.length}, mcp=${message.mcp_servers?.map(s => `${s.name}:${s.status}`).join(",")}`);
      }
      return;
    }

    if (message.type === "auth_status") {
      if (message.error) {
        console.error("[cipher] Auth error:", message.error);
      } else if (message.isAuthenticating) {
        console.log("[cipher] Authenticating...");
      }
      return;
    }
  }

  // ── Message queue for async generator ──

  _enqueueUserMessage(text) {
    if (this.speaking) {
      this.interrupt();
    }

    if (this._messageResolve) {
      const resolve = this._messageResolve;
      this._messageResolve = null;
      resolve(text);
    } else {
      this._messageQueue.push(text);
    }
  }

  _waitForMessage() {
    if (this._messageQueue.length > 0) {
      return Promise.resolve(this._messageQueue.shift());
    }
    return new Promise((resolve) => {
      this._messageResolve = resolve;
    });
  }

  // ── TTS helpers (Deepgram Aura — token-by-token streaming) ──
  // Send each text delta directly to Deepgram TTS as it arrives from Claude.
  // No sentence buffering needed — Deepgram handles chunking internally.

  _startTTS() {
    // Cancel any pending mic-open timer from a previous Flushed event
    // (prevents race: speak → tool call → speak again → first timer opens mic mid-speech)
    if (this._micOpenTimer) {
      clearTimeout(this._micOpenTimer);
      this._micOpenTimer = null;
      console.log("[cipher] Cancelled pending mic-open timer (new TTS starting)");
    }
    this._ttsActive = true;
    this.speaking = true;
    this._audioEmitCount = 0;
    this._ttsAudioCount = 0;
    this._ttsSendCount = 0;
    console.log("[cipher] TTS: streaming started");
  }

  _stripMarkdownForTTS(text) {
    return text
      .replace(/\*+/g, "")           // bold/italic markers → "star star"
      .replace(/`+/g, "")            // code markers
      .replace(/^#+\s*/gm, "")       // header markers
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [links](url) → just text
      .replace(/\s{2,}/g, " ");      // collapse extra whitespace
  }

  _sendToTTS(text) {
    if (!this.dgTTS || !this._ttsActive) return;
    const cleaned = this._stripMarkdownForTTS(text);
    if (!cleaned) return; // skip if stripping left nothing (e.g. lone **)
    if (!this._ttsSendCount) this._ttsSendCount = 0;
    this._ttsSendCount++;
    if (this._ttsSendCount <= 3) {
      console.log("[cipher] TTS sendText #%d: \"%s\" (connected=%s)", this._ttsSendCount, cleaned, this.dgTTS.isConnected?.() ?? "unknown");
    }
    this.dgTTS.sendText(cleaned);
  }

  _flushTTS() {
    if (!this.dgTTS || !this._ttsActive) return;
    console.log("[cipher] TTS: flushing");
    this.dgTTS.flush();
    this._ttsActive = false;
    this._ttsFlushing = true; // cleared in Flushed handler
  }

  _cancelTTS() {
    if (!this.dgTTS) return;
    this._ttsActive = false;
    this._ttsFlushing = false;
    // Cancel pending mic-open timer
    if (this._micOpenTimer) {
      clearTimeout(this._micOpenTimer);
      this._micOpenTimer = null;
    }
    // Clear TTS buffers and stop generating audio
    try { this.dgTTS.clear(); } catch {}
    // Clear audio buffer and playback estimate
    this._audioBuffer = [];
    this._audioBufferBytes = 0;
    this._estimatedPlaybackEnd = 0;
    if (this._audioFlushTimer) {
      clearTimeout(this._audioFlushTimer);
      this._audioFlushTimer = null;
    }
  }

  _emitBufferedAudio() {
    if (this._audioFlushTimer) {
      clearTimeout(this._audioFlushTimer);
      this._audioFlushTimer = null;
    }
    if (this._audioBuffer.length === 0) return;

    const combined = Buffer.concat(this._audioBuffer);
    const chunks = this._audioBuffer.length;
    this._audioBuffer = [];
    this._audioBufferBytes = 0;

    // Calculate how long this audio will take to play (24kHz, 16-bit mono = 48000 bytes/sec)
    const audioDurationMs = (combined.length / 48000) * 1000;
    // Estimated playback end: whichever is later — previous estimate or now, plus this chunk's duration
    const playbackStart = Math.max(this._estimatedPlaybackEnd, Date.now());
    this._estimatedPlaybackEnd = playbackStart + audioDurationMs;

    if (!this._audioEmitCount) this._audioEmitCount = 0;
    this._audioEmitCount++;
    if (this._audioEmitCount <= 3 || this._audioEmitCount % 20 === 0) {
      console.log("[cipher] Audio emit #%d: %d bytes (%d chunks), playback ends in %dms",
        this._audioEmitCount, combined.length, chunks,
        Math.round(this._estimatedPlaybackEnd - Date.now()));
    }
    this.emit("audio", combined.toString("base64"));
  }
}

// Keep the tool converter for backwards compatibility (API fallback)
function convertGeminiToolToClaude(geminiTool) {
  const tool = {
    name: geminiTool.name,
    description: geminiTool.description,
    input_schema: {
      type: "object",
      properties: {},
      required: geminiTool.parameters?.required || [],
    },
  };
  const props = geminiTool.parameters?.properties || {};
  for (const [key, val] of Object.entries(props)) {
    const prop = { description: val.description || "" };
    switch ((val.type || "").toUpperCase()) {
      case "STRING": prop.type = "string"; break;
      case "NUMBER": prop.type = "number"; break;
      case "INTEGER": prop.type = "integer"; break;
      case "BOOLEAN": prop.type = "boolean"; break;
      default: prop.type = "string";
    }
    if (val.enum) prop.enum = val.enum;
    tool.input_schema.properties[key] = prop;
  }
  return tool;
}

function convertToolsForClaude(geminiTools) {
  return geminiTools.map(convertGeminiToolToClaude);
}

module.exports = { CipherPipeline, convertToolsForClaude };
