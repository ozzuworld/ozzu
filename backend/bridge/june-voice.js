// june-voice.js — AudioSocket server bridging Asterisk ↔ Gemini Live API
// Asterisk routes incoming calls to AudioSocket(127.0.0.1:4580)
// This streams caller audio to Gemini 2.5 Flash (Live API) and plays
// Gemini's audio responses back through Asterisk. Gemini handles
// greeting, screening, and tool calls (notify app, transfer, take message).
"use strict";

const net = require("net");
const { WebSocket } = require("ws");

const PORT = 4580;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-preview-native-audio-dialog";
const GEMINI_VOICE = process.env.GEMINI_VOICE || "Aoede";
const BRIDGE_URL = process.env.BRIDGE_URL || "http://127.0.0.1:3333";
const BRIDGE_TOKEN = process.env.BRIDGE_API_KEY || process.env.BRIDGE_TOKEN || "";

// AudioSocket protocol constants
const AS_KIND_HANGUP = 0x00;
const AS_KIND_UUID = 0x01;
const AS_KIND_SLIN = 0x10;
const AS_KIND_ERROR = 0xff;

// Gemini Live API WebSocket endpoint
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const JUNE_SYSTEM_PROMPT = `You are June, the AI receptionist for Ozzu World. You are warm, professional, and efficient.

Your job:
1. Answer incoming calls with a natural greeting
2. Find out WHO the caller wants to reach and WHY they're calling
3. Once you know, tell them you'll check availability and notify the team

Greeting (first thing you say when the call connects):
"Thank you for calling Ozzu World, this is June speaking. How may I help you today?"

Conversation rules:
- Be natural and conversational, not robotic
- If the caller asks for a specific person, ask "May I ask what this is regarding?"
- If the caller is vague, gently ask clarifying questions
- Keep it brief — you're screening, not having a long chat
- If asked about Ozzu, say "Ozzu World is a technology company. I'd be happy to connect you with the right person."
- If the caller seems like spam/robocall/telemarketer, politely say "I'm sorry, we're not interested, but thank you for calling" and end the call
- NEVER make up information about specific people, products, or services

Once you have the caller's name and reason, use the notify_app tool to send a briefing.
After notifying, tell the caller: "I've notified the team. Let me check if they're available — one moment please."
Then use the check_availability tool to wait for a response.

If the person is unavailable or doesn't respond within 20 seconds:
- Say "I'm sorry, they're not available right now. Would you like to leave a message?"
- If yes, use the take_message tool with their message
- Say "I've recorded your message and will make sure it's delivered. Is there anything else?"
- If no, say "Thank you for calling Ozzu World. Have a great day!" and use the end_call tool

If the person accepts:
- Say "I'm connecting you now. Thank you for your patience!"
- Use the transfer_call tool`;

const JUNE_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "notify_app",
        description: "Send a briefing notification to the Ozzu app with caller details. Call this once you know who the caller wants and why.",
        parameters: {
          type: "OBJECT",
          properties: {
            caller_name: { type: "STRING", description: "The caller's name as they stated it" },
            caller_number: { type: "STRING", description: "The caller's phone number (from channel variable)" },
            wants_to_reach: { type: "STRING", description: "Who the caller wants to talk to" },
            reason: { type: "STRING", description: "Why they're calling, brief summary" },
            urgency: { type: "STRING", enum: ["low", "normal", "high"], description: "How urgent this seems" },
          },
          required: ["caller_name", "reason"],
        },
      },
      {
        name: "check_availability",
        description: "Wait for the person to respond to the briefing (accept, decline, or timeout). Call this after notify_app.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "transfer_call",
        description: "Transfer the caller to the person they requested. Only call this after check_availability returns 'accepted'.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "take_message",
        description: "Record a message from the caller when the person is unavailable.",
        parameters: {
          type: "OBJECT",
          properties: {
            message: { type: "STRING", description: "The caller's message, as they stated it" },
            callback_requested: { type: "BOOLEAN", description: "Whether the caller asked for a callback" },
          },
          required: ["message"],
        },
      },
      {
        name: "end_call",
        description: "End the call gracefully. Use after taking a message or when the conversation is complete.",
        parameters: {
          type: "OBJECT",
          properties: {
            reason: { type: "STRING", enum: ["completed", "spam", "no_answer", "transferred"], description: "Why the call ended" },
          },
          required: ["reason"],
        },
      },
    ],
  },
];

class JuneSession {
  constructor(socket) {
    this.socket = socket;
    this.callUuid = null;
    this.callerNumber = "unknown";
    this.geminiWs = null;
    this.alive = true;
    this.setupDone = false;
    this.pendingAvailability = null;
    this.asBuffer = Buffer.alloc(0);

    this.socket.on("data", (data) => this.handleAudioSocketData(data));
    this.socket.on("close", () => this.cleanup("socket closed"));
    this.socket.on("error", (e) => this.cleanup(`socket error: ${e.message}`));
  }

  handleAudioSocketData(data) {
    this.asBuffer = Buffer.concat([this.asBuffer, data]);

    while (this.asBuffer.length >= 3) {
      const kind = this.asBuffer[0];
      const payloadLen = this.asBuffer.readUInt16BE(1);

      if (this.asBuffer.length < 3 + payloadLen) break;

      const payload = this.asBuffer.subarray(3, 3 + payloadLen);
      this.asBuffer = this.asBuffer.subarray(3 + payloadLen);

      switch (kind) {
        case AS_KIND_UUID:
          this.callUuid = payload.toString("utf8").replace(/-/g, "").slice(0, 32);
          console.log(`[June] Call UUID: ${this.callUuid}`);
          this.connectGemini();
          break;

        case AS_KIND_SLIN:
          if (this.geminiWs?.readyState === WebSocket.OPEN && this.setupDone) {
            const pcm16 = payload;
            const b64 = pcm16.toString("base64");
            this.geminiWs.send(JSON.stringify({
              realtimeInput: {
                mediaChunks: [{ mimeType: "audio/pcm;rate=8000", data: b64 }],
              },
            }));
          }
          break;

        case AS_KIND_HANGUP:
          console.log(`[June] Caller hung up`);
          this.cleanup("hangup");
          break;

        case AS_KIND_ERROR:
          console.error(`[June] AudioSocket error from Asterisk`);
          this.cleanup("asterisk error");
          break;
      }
    }
  }

  connectGemini() {
    if (!GEMINI_API_KEY) {
      console.error("[June] No GEMINI_API_KEY configured");
      this.cleanup("no api key");
      return;
    }

    console.log(`[June] Connecting to Gemini Live...`);
    this.geminiWs = new WebSocket(GEMINI_WS_URL);

    this.geminiWs.on("open", () => {
      console.log("[June] Gemini WS connected, sending setup");
      this.geminiWs.send(JSON.stringify({
        setup: {
          model: `models/${GEMINI_MODEL}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: GEMINI_VOICE },
              },
            },
          },
          systemInstruction: {
            parts: [{ text: JUNE_SYSTEM_PROMPT }],
          },
          tools: JUNE_TOOLS,
        },
      }));
    });

    this.geminiWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleGeminiMessage(msg);
      } catch (e) {
        console.error("[June] Failed to parse Gemini message:", e.message);
      }
    });

    this.geminiWs.on("close", (code, reason) => {
      console.log(`[June] Gemini WS closed: ${code} ${reason}`);
      this.cleanup("gemini closed");
    });

    this.geminiWs.on("error", (e) => {
      console.error(`[June] Gemini WS error: ${e.message}`);
    });
  }

  handleGeminiMessage(msg) {
    if (msg.setupComplete) {
      console.log("[June] Gemini setup complete, session active");
      this.setupDone = true;
      return;
    }

    if (msg.serverContent) {
      const parts = msg.serverContent.modelTurn?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.mimeType?.startsWith("audio/")) {
          const audioB64 = part.inlineData.data;
          const audioBuf = Buffer.from(audioB64, "base64");
          this.sendAudioToAsterisk(audioBuf);
        }
      }

      if (msg.serverContent.turnComplete) {
        console.log("[June] Gemini turn complete");
      }
    }

    if (msg.toolCall) {
      this.handleToolCall(msg.toolCall);
    }
  }

  sendAudioToAsterisk(pcmData) {
    if (!this.alive || this.socket.destroyed) return;

    // AudioSocket frame: kind(1) + length(2) + payload
    // Send in 320-byte chunks (20ms of 8kHz 16-bit mono)
    const chunkSize = 320;
    for (let i = 0; i < pcmData.length; i += chunkSize) {
      const chunk = pcmData.subarray(i, Math.min(i + chunkSize, pcmData.length));
      const frame = Buffer.alloc(3 + chunk.length);
      frame[0] = AS_KIND_SLIN;
      frame.writeUInt16BE(chunk.length, 1);
      chunk.copy(frame, 3);
      this.socket.write(frame);
    }
  }

  async handleToolCall(toolCall) {
    const results = [];
    for (const fc of toolCall.functionCalls || []) {
      console.log(`[June] Tool call: ${fc.name}`, JSON.stringify(fc.args));
      let result;
      try {
        result = await this.executeTool(fc.name, fc.args || {});
      } catch (e) {
        console.error(`[June] Tool error: ${e.message}`);
        result = { error: e.message };
      }
      results.push({
        functionResponse: { name: fc.name, response: result },
      });
    }

    if (this.geminiWs?.readyState === WebSocket.OPEN) {
      this.geminiWs.send(JSON.stringify({
        toolResponse: { functionResponses: results.map((r) => r.functionResponse) },
      }));
    }
  }

  async executeTool(name, args) {
    switch (name) {
      case "notify_app":
        return this.toolNotifyApp(args);
      case "check_availability":
        return this.toolCheckAvailability();
      case "transfer_call":
        return this.toolTransferCall();
      case "take_message":
        return this.toolTakeMessage(args);
      case "end_call":
        return this.toolEndCall(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  async toolNotifyApp(args) {
    const briefing = {
      type: "call_briefing",
      caller_name: args.caller_name || "Unknown",
      caller_number: this.callerNumber,
      wants_to_reach: args.wants_to_reach || "Anyone available",
      reason: args.reason || "No reason stated",
      urgency: args.urgency || "normal",
      call_uuid: this.callUuid,
      timestamp: new Date().toISOString(),
    };

    console.log("[June] Sending briefing to app:", JSON.stringify(briefing));

    try {
      // Push to WebSocket clients (VoIP WS on the bridge)
      if (global.__voipClientWs?.readyState === 1) {
        global.__voipClientWs.send(JSON.stringify(briefing));
      }

      // Also POST to bridge for persistence + push notification
      await fetch(`${BRIDGE_URL}/soc/calls/briefing`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BRIDGE_TOKEN}`,
        },
        body: JSON.stringify(briefing),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      console.error("[June] Failed to send briefing:", e.message);
    }

    this.pendingAvailability = {
      resolve: null,
      timer: null,
      briefing,
    };

    return { status: "notified", message: "Briefing sent to the app" };
  }

  async toolCheckAvailability() {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log("[June] Availability check timed out");
        if (this.pendingAvailability) this.pendingAvailability.resolve = null;
        resolve({ status: "timeout", message: "No response within 20 seconds" });
      }, 20000);

      if (this.pendingAvailability) {
        this.pendingAvailability.resolve = (decision) => {
          clearTimeout(timeout);
          resolve(decision);
        };
        this.pendingAvailability.timer = timeout;
      } else {
        clearTimeout(timeout);
        resolve({ status: "error", message: "No briefing was sent first" });
      }
    });
  }

  handleAppDecision(decision) {
    if (this.pendingAvailability?.resolve) {
      this.pendingAvailability.resolve({
        status: decision,
        message: decision === "accepted" ? "Person is available, transfer now" : "Person declined the call",
      });
      this.pendingAvailability.resolve = null;
    }
  }

  async toolTransferCall() {
    console.log("[June] Transferring call to user");
    // Set Asterisk channel variable to trigger bridge to waiting GSM channel
    // The AudioSocket protocol doesn't support channel variables directly,
    // so we signal via the bridge HTTP API
    try {
      await fetch(`${BRIDGE_URL}/soc/calls/transfer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BRIDGE_TOKEN}`,
        },
        body: JSON.stringify({ call_uuid: this.callUuid }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      console.error("[June] Transfer signal error:", e.message);
    }

    return { status: "transferring", message: "Call being transferred" };
  }

  async toolTakeMessage(args) {
    const messageData = {
      caller_name: this.pendingAvailability?.briefing?.caller_name || "Unknown",
      caller_number: this.callerNumber,
      message: args.message,
      callback_requested: args.callback_requested || false,
      timestamp: new Date().toISOString(),
      call_uuid: this.callUuid,
    };

    console.log("[June] Taking message:", JSON.stringify(messageData));

    try {
      // Push message to app
      if (global.__voipClientWs?.readyState === 1) {
        global.__voipClientWs.send(JSON.stringify({ type: "voicemail", ...messageData }));
      }

      // Persist via bridge
      await fetch(`${BRIDGE_URL}/soc/calls/message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${BRIDGE_TOKEN}`,
        },
        body: JSON.stringify(messageData),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      console.error("[June] Failed to save message:", e.message);
    }

    return { status: "recorded", message: "Message saved and delivered" };
  }

  async toolEndCall(args) {
    console.log(`[June] Ending call: ${args.reason}`);
    // Send hangup frame to AudioSocket
    setTimeout(() => {
      if (this.alive && !this.socket.destroyed) {
        const hangupFrame = Buffer.alloc(3);
        hangupFrame[0] = AS_KIND_HANGUP;
        hangupFrame.writeUInt16BE(0, 1);
        this.socket.write(hangupFrame);
      }
      this.cleanup("call ended by june");
    }, 1000);

    return { status: "ending", reason: args.reason };
  }

  cleanup(reason) {
    if (!this.alive) return;
    this.alive = false;
    console.log(`[June] Session cleanup: ${reason}`);

    if (this.pendingAvailability?.timer) {
      clearTimeout(this.pendingAvailability.timer);
    }

    if (this.geminiWs) {
      this.geminiWs.close();
      this.geminiWs = null;
    }

    if (!this.socket.destroyed) {
      this.socket.destroy();
    }

    // Remove from active sessions
    activeSessions.delete(this.callUuid);
  }
}

// Track active sessions for app decision callbacks
const activeSessions = new Map();

const server = net.createServer((socket) => {
  console.log("[June] New AudioSocket connection from Asterisk");
  const session = new JuneSession(socket);

  // Patch: set caller number from the first UUID message context
  const origConnect = session.connectGemini.bind(session);
  session.connectGemini = function () {
    activeSessions.set(session.callUuid, session);
    origConnect();
  };
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[June] Voice AI receptionist listening on 127.0.0.1:${PORT}`);
});

// Export for bridge integration — app decisions route here
function handleCallDecision(callUuid, decision) {
  const session = activeSessions.get(callUuid);
  if (session) {
    session.handleAppDecision(decision);
    return true;
  }
  return false;
}

function setCallerNumber(callUuid, number) {
  const session = activeSessions.get(callUuid);
  if (session) session.callerNumber = number;
}

module.exports = { handleCallDecision, setCallerNumber, activeSessions };
