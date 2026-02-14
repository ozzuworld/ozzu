// Cipher Pipeline: Deepgram STT → Claude Agent SDK (Opus) → Deepgram Aura TTS
// Uses Max subscription via OAuth — no separate API key needed.
// Cipher is a CONVERSATIONAL ROUTER — it delegates all dev work to directive agents.
// SDK built-in tools (Read, Bash, Grep) are intentionally excluded so Cipher
// never tries to code inline. It uses only MCP bridge tools for operational tasks
// and sends_dev_directive for anything that touches code.

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
    this._ttsReconnectAttempt = 0; // exponential backoff counter, reset on successful open
    this._ttsStreamId = 0; // incremented on each new TTS connection
    this._currentTtsStreamId = 0; // stream ID for the active speech, set in _startTTS()

    // Claude Agent SDK state
    this._messageQueue = [];
    this._messageResolve = null;
    this._queryRunning = false;
    this._query = null;
    this._interrupted = false; // true between interrupt() and next _startTTS()

    // Utterance accumulator for Deepgram partials
    this._utteranceBuffer = "";

    // Latency tracking: measure voice round-trip time
    this._utteranceSentAt = 0;   // When user message was sent to Claude
    this._firstTextDeltaAt = 0;  // When first text delta arrived from Claude
    this._firstAudioAt = 0;      // When first TTS audio chunk arrived
    this._lastResponseText = ""; // Last spoken response (for echo detection)

    // STT reconnect backoff
    this._sttReconnectAttempt = 0;

    // STT keepAlive interval (cleared on disconnect)
    this._sttKeepAliveInterval = null;
    this._lastAudioSentAt = 0;

    // Session turn counter — triggers rotation to prevent unbounded memory growth
    this._turnCount = 0;
    this._maxTurns = 50; // Rotate session after 50 user turns (~100 messages)

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
    this._connectTTS();

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
        keywords: [
          "AltStore:3",
          "SideStore:3",
          "Cipher:2",
          "ozzu:3",
          "dev-01:2",
          "King Kazuma:2",
          "directive:2",
          "Home Assistant:2",
          "sideload:2",
        ],
      });

      this.dgSTT.on(LiveTranscriptionEvents.Open, () => {
        console.log("[cipher] Deepgram STT connected");
        this._sttReconnectAttempt = 0;
        // Start keepAlive interval
        this._startSTTKeepAlive();
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
        let text = this._utteranceBuffer.trim();
        this._utteranceBuffer = "";
        if (!text) return;

        // Turn-based: only accept input when it's user's turn
        if (this._turn !== "user") {
          console.log(`[cipher] STT (blocked, cipher's turn): "${text}"`);
          return;
        }

        // Echo detection: if STT picked up Cipher's own speech from speakers,
        // strip the echoed prefix so Claude only sees the user's actual words.
        text = this._stripEcho(text);
        if (!text) {
          console.log("[cipher] STT: (pure echo, discarded)");
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
        // Error without subsequent Close can leave STT dead — force reconnect
        if (this.dgSTT && !this.dgSTT.isConnected?.()) {
          console.log("[cipher] STT error left connection dead, forcing reconnect...");
          this._stopSTTKeepAlive();
          this.dgSTT = null;
          this._scheduleSTTReconnect();
        }
      });

      this.dgSTT.on(LiveTranscriptionEvents.Close, (ev) => {
        const code = ev?.code || "unknown";
        const reason = ev?.reason || "";
        console.log(`[cipher] Deepgram STT closed (code=${code}${reason ? `, reason=${reason}` : ""})`);
        this._stopSTTKeepAlive();
        this.dgSTT = null;
        // Clear stale utterance buffer to prevent text accumulation across reconnects
        this._utteranceBuffer = "";
        // Auto-reconnect with exponential backoff
        this._scheduleSTTReconnect();
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
    this._lastAudioSentAt = Date.now();
  }

  _scheduleSTTReconnect() {
    if (!this.running) return;
    if (this._sttReconnectAttempt >= 20) {
      // After max attempts, wait 5 minutes then reset counter and try again
      console.error("[cipher] STT reconnect: max attempts (20) reached, will retry in 5min");
      setTimeout(() => {
        if (this.running && !this.dgSTT) {
          this._sttReconnectAttempt = 0;
          this._connectSTT();
        }
      }, 300000);
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this._sttReconnectAttempt), 30000);
    this._sttReconnectAttempt++;
    console.log("[cipher] STT reconnecting in %dms (attempt %d/20)...", delay, this._sttReconnectAttempt);
    setTimeout(() => {
      if (this.running && !this.dgSTT) this._connectSTT();
    }, delay);
  }

  _connectTTS() {
    if (!this.deepgramClient) {
      console.warn("[cipher] No DEEPGRAM_API_KEY — TTS disabled, text output only");
      return;
    }
    if (this.dgTTS) return; // already connected

    try {
      this._ttsStreamId++;
      const streamId = this._ttsStreamId;

      this.dgTTS = this.deepgramClient.speak.live({
        model: CIPHER_VOICE,
        encoding: "linear16",
        sample_rate: 24000,
      });

      this.dgTTS.on(LiveTTSEvents.Open, () => {
        console.log("[cipher] Deepgram TTS connected (voice: %s, streamId: %d)", CIPHER_VOICE, streamId);
        this._ttsReconnectAttempt = 0;
      });

      this.dgTTS.on(LiveTTSEvents.Audio, (data) => {
        // Drop audio from stale TTS connections to prevent interleaved audio
        if (streamId !== this._ttsStreamId) return;

        // Buffer small chunks into ~100ms packets for smooth playback
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (!this._ttsAudioCount) this._ttsAudioCount = 0;
        this._ttsAudioCount++;
        // Track first-audio latency
        if (this._ttsAudioCount === 1 && this._utteranceSentAt) {
          this._firstAudioAt = Date.now();
          const totalLatency = this._firstAudioAt - this._utteranceSentAt;
          const ttsLatency = this._firstTextDeltaAt ? this._firstAudioAt - this._firstTextDeltaAt : 0;
          console.log("[cipher] Latency: total = %dms (thinking: %dms, TTS synthesis: %dms)",
            totalLatency,
            this._firstTextDeltaAt ? this._firstTextDeltaAt - this._utteranceSentAt : totalLatency,
            ttsLatency);
          this.emit("latency", {
            total: totalLatency,
            thinking: this._firstTextDeltaAt ? this._firstTextDeltaAt - this._utteranceSentAt : totalLatency,
            tts: ttsLatency,
          });
        }
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
        this.emit("turnComplete"); // Tell frontend Cipher finished speaking
        // Wait for tablet to finish playing, then open mic
        // Padding: 500ms for network jitter (LAN latency is <10ms, but audio buffering adds some)
        // Minimum: 1000ms so user has a beat to start speaking
        const playbackRemaining = Math.max(0, (this._estimatedPlaybackEnd || 0) - Date.now());
        const delay = Math.max(playbackRemaining + 500, 1000);
        console.log("[cipher] Mic opens in %dms (playback remaining: %dms)", delay, playbackRemaining);
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
        // Error without subsequent Close can leave TTS dead — force reconnect
        if (this.dgTTS && !this.dgTTS.isConnected?.()) {
          console.log("[cipher] TTS error left connection dead, forcing reconnect...");
          this.dgTTS = null;
          this._scheduleTTSReconnect();
        }
      });

      this.dgTTS.on(LiveTTSEvents.Close, () => {
        console.log("[cipher] Deepgram TTS closed (streamId: %d)", streamId);
        this.dgTTS = null;
        this._scheduleTTSReconnect();
      });
    } catch (err) {
      console.error("[cipher] Deepgram TTS init failed:", err.message);
      this.dgTTS = null;
    }
  }

  _scheduleTTSReconnect() {
    if (!this.running) return;
    if (this._ttsReconnectAttempt >= 10) {
      console.error("[cipher] TTS reconnect: max attempts (10) reached, giving up");
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this._ttsReconnectAttempt), 15000);
    this._ttsReconnectAttempt++;
    console.log("[cipher] TTS reconnecting in %dms (attempt %d/10)...", delay, this._ttsReconnectAttempt);
    setTimeout(() => {
      if (this.running && !this.dgTTS) this._connectTTS();
    }, delay);
  }

  _startSTTKeepAlive() {
    this._stopSTTKeepAlive();
    this._sttKeepAliveInterval = setInterval(() => {
      if (!this.dgSTT || !this.running) {
        this._stopSTTKeepAlive();
        return;
      }
      // Only send keepAlive if no audio sent in the last 5 seconds
      if (Date.now() - this._lastAudioSentAt > 5000) {
        try {
          this.dgSTT.keepAlive();
        } catch (err) {
          console.warn("[cipher] STT keepAlive failed:", err.message);
        }
      }
    }, 8000);
  }

  _stopSTTKeepAlive() {
    if (this._sttKeepAliveInterval) {
      clearInterval(this._sttKeepAliveInterval);
      this._sttKeepAliveInterval = null;
    }
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
    this._interrupted = true;
    this._cancelTTS();
    this.speaking = false;
    this.emit("interrupted");
    console.log("[cipher] Interrupted — dropping remainder of current response");
  }

  async stop() {
    this.running = false;
    console.log("[cipher] Stopping pipeline...");

    this._stopSTTKeepAlive();
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
    // Clean up all timers to prevent orphaned callbacks after restart
    if (this._micOpenTimer) {
      clearTimeout(this._micOpenTimer);
      this._micOpenTimer = null;
    }
    if (this._audioFlushTimer) {
      clearTimeout(this._audioFlushTimer);
      this._audioFlushTimer = null;
    }
    this._audioBuffer = [];
    this._audioBufferBytes = 0;
    if (this._messageResolve) {
      this._messageResolve(null);
      this._messageResolve = null;
    }
    this._messageQueue = [];

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
          model: process.env.CIPHER_MODEL || "opus",
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

    // Auto-reconnect if still running (session ended unexpectedly)
    if (this.running) {
      this._sdkReconnectAttempt = (this._sdkReconnectAttempt || 0) + 1;
      if (this._sdkReconnectAttempt > 5) {
        console.error("[cipher] SDK reconnect: max attempts (5) reached, stopping pipeline");
        this.emit("dead", "SDK reconnect exhausted");
        return;
      }
      const delay = Math.min(2000 * Math.pow(2, this._sdkReconnectAttempt - 1), 30000);
      console.log("[cipher] SDK reconnecting in %dms (attempt %d/5)...", delay, this._sdkReconnectAttempt);
      await new Promise(r => setTimeout(r, delay));
      if (this.running) {
        this._sdkReconnectAttempt = 0; // reset on successful start of new session
        this._startClaudeSession();
      }
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
          case "ARRAY": zodType = z.array(z.string()); break;
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
        // Clear interrupted flag — this is a fresh response (possibly from re-queued message)
        this._interrupted = false;
        this._startTTS();
      }

      // Drop text deltas if we were interrupted mid-response
      if (this._interrupted) return;

      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        const text = event.delta.text;
        if (!this._firstTextDeltaAt && this._utteranceSentAt) {
          this._firstTextDeltaAt = Date.now();
          const thinkTime = this._firstTextDeltaAt - this._utteranceSentAt;
          console.log("[cipher] Latency: Claude thinking = %dms", thinkTime);
        }
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
      if (this._interrupted) return; // Drop post-interrupt assistant messages

      const textParts = (message.message?.content || [])
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("");

      if (textParts) {
        console.log(`[cipher] Response: "${textParts.substring(0, 120)}${textParts.length > 120 ? "..." : ""}"`);
        this._lastResponseText = textParts; // Store for echo detection
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
      // Don't open if there are queued messages (user already sent next input after interrupt)
      const hasPendingMessages = this._messageQueue.length > 0;
      if (this._turn === "cipher" && !this._ttsActive && !this._ttsFlushing && !hasPendingMessages) {
        this._turn = "user";
        this._turnReady = true;
        this.emit("listeningReady");
        console.log("[cipher] Turn: user (listening, after tool-only turn)");
      } else if (hasPendingMessages) {
        console.log("[cipher] Turn: skipping mic open — %d message(s) queued", this._messageQueue.length);
      }
      this._interrupted = false; // Reset for next turn
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
    this._utteranceSentAt = Date.now();
    this._firstTextDeltaAt = 0;
    this._firstAudioAt = 0;
    this._turnCount++;

    if (this._turnCount >= this._maxTurns) {
      console.log("[cipher] Session rotation threshold reached (%d turns) — requesting restart", this._turnCount);
      this.emit("sessionExhausted", this._turnCount);
    }

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

  // ── Echo detection ──
  // Speakers play Cipher's voice and the mic picks it up. STT transcribes
  // the echo and it gets fed back as "user input". We detect this by comparing
  // the STT text against the last response Cipher spoke.

  _stripEcho(sttText) {
    if (!this._lastResponseText || !sttText) return sttText;

    // Normalize: lowercase, collapse whitespace, strip punctuation
    const normalize = (s) => s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
    const sttNorm = normalize(sttText);
    const responseNorm = normalize(this._lastResponseText);

    // Skip if either is too short to meaningfully compare
    if (sttNorm.length < 10 || responseNorm.length < 10) return sttText;

    // Check if STT starts with a chunk of the last response (echo prefix)
    // Try matching progressively shorter prefixes of the response
    const responseWords = responseNorm.split(" ");
    const sttWords = sttNorm.split(" ");

    // Find the longest prefix of response words that matches the start of STT
    let matchLen = 0;
    for (let i = 0; i < Math.min(responseWords.length, sttWords.length); i++) {
      if (responseWords[i] === sttWords[i]) {
        matchLen = i + 1;
      } else {
        break;
      }
    }

    // If we matched 4+ words at the start, it's likely echo
    if (matchLen >= 4) {
      // Strip the echoed prefix — reconstruct from original STT words
      const origWords = sttText.split(/\s+/);
      const remaining = origWords.slice(matchLen).join(" ").trim();
      console.log("[cipher] Echo detected: stripped %d words (\"%s...\" → \"%s\")",
        matchLen, origWords.slice(0, Math.min(matchLen, 5)).join(" "),
        remaining ? remaining.substring(0, 50) : "(empty)");

      // If 80%+ of the STT was echo and remainder is <3 words, discard entirely
      if (!remaining || remaining.split(/\s+/).length < 3 && matchLen > sttWords.length * 0.6) {
        return "";
      }
      return remaining;
    }

    // Check for high word overlap (echo mixed with new content, not just prefix)
    const responseSet = new Set(responseWords);
    const overlapCount = sttWords.filter(w => responseSet.has(w)).length;
    const overlapRatio = overlapCount / sttWords.length;

    if (overlapRatio > 0.8 && sttWords.length > 5) {
      console.log("[cipher] Echo detected: %d%% word overlap with last response, discarding", Math.round(overlapRatio * 100));
      return "";
    }

    return sttText;
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
    this._currentTtsStreamId = this._ttsStreamId;
    console.log("[cipher] TTS: streaming started (streamId: %d)", this._currentTtsStreamId);
  }

  _stripMarkdownForTTS(text) {
    return text
      .replace(/```[\s\S]*?```/g, "") // fenced code blocks
      .replace(/\*+/g, "")           // bold/italic markers
      .replace(/`+/g, "")            // inline code markers
      .replace(/^#+\s*/gm, "")       // header markers
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [links](url) → just text
      .replace(/^([-_*])\s*\1\s*\1[\s\-_*]*$/gm, "") // horizontal rules (---, ***, ___)
      .replace(/^>\s+/gm, "")        // blockquote markers
      .replace(/\|/g, ",")           // table pipes → commas (reads more naturally)
      .replace(/^[-:]+$/gm, "")      // table separator rows (|---|---|)
      .replace(/\\([*_`\\])/g, "$1") // escaped chars → literal
      .replace(/\s{2,}/g, " ")       // collapse extra whitespace
      .trim();
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
