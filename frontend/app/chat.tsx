import { useState, useCallback, useRef, useEffect } from "react";
import { View, Text, TextInput, PermissionsAndroid, Platform } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StatusBadge } from "../components/StatusBadge";
import { TVPressable } from "../components/TVPressable";
import { SciFiOrb } from "../components/SciFiOrb";
import { StreamingText } from "../components/StreamingText";
import { LiveChat, type LiveCallbacks, type ToolCallResult } from "../lib/live-session";
import { StreamingPlayer, MicRecorder } from "../lib/audio";
import { useEntitySummary } from "../lib/useEntitySummary";
import { useHA } from "../lib/ha-context";
import { resolveToolCall } from "../lib/ha-tools";
import { BRIDGE_TOOL_NAMES } from "../lib/bridge-tools";
import { fetchDevStatus, fetchPendingApprovals, resolveApproval, fetchDirectives, sendDirective } from "../lib/bridge-api";
import { Keypad } from "../components/Keypad";

const QUICK_PROMPTS = [
  { label: "Status Report", message: "Give me a full status report of all systems" },
  { label: "Devices", message: "What devices are on right now and their states?" },
] as const;

export default function ChatScreen() {
  const router = useRouter();
  const entitySummary = useEntitySummary();
  const { callService } = useHA();

  const [showKeypad, setShowKeypad] = useState(false);
  const pendingApprovalRef = useRef<{
    id: string;
    approved: boolean;
    resolve: (result: ToolCallResult) => void;
  } | null>(null);

  const handleToolCall = useCallback(
    async (name: string, args: Record<string, unknown>): Promise<ToolCallResult> => {
      // ── Bridge tools ──
      if (BRIDGE_TOOL_NAMES.has(name)) {
        try {
          if (name === "get_dev_status") {
            const entries = await fetchDevStatus();
            if (entries.length === 0) {
              return { success: true, message: "No recent dev activity." };
            }
            const summary = entries
              .slice(-10)
              .map((e) => `[${e.timestamp}] ${e.event}: ${e.tool} — ${e.message}`)
              .join("\n");
            return { success: true, message: summary };
          }

          if (name === "get_pending_approvals") {
            const pending = await fetchPendingApprovals();
            // Filter out directive-plan approvals — those are handled via get_directives
            const nonDirective = pending.filter((a) => a.tool !== "directive_plan");
            if (nonDirective.length === 0) {
              return { success: true, message: "No pending approvals." };
            }
            const list = nonDirective
              .map((a) => `${a.id}: ${a.risk} risk, ${a.tool}, ${a.description}`)
              .join(". ");
            return { success: true, message: `${nonDirective.length} pending. ${list}` };
          }

          if (name === "approve_action") {
            const approvalId = args.approval_id as string;
            const approved = args.approved !== false;
            const needsUserPin = args.needs_user_pin !== false;
            if (!approvalId) {
              return { success: false, message: "Missing approval_id" };
            }
            // Auto-approve: June handles routine ops with stored PIN
            if (!needsUserPin) {
              const autoPin = process.env.EXPO_PUBLIC_BRIDGE_PIN ?? "";
              if (!autoPin) {
                return { success: false, message: "Auto-approve failed: no BRIDGE_PIN configured." };
              }
              try {
                const result = await resolveApproval(approvalId, approved, autoPin);
                if (result.error) {
                  return { success: false, message: result.error };
                }
                return {
                  success: true,
                  message: approved
                    ? `Auto-approved action ${approvalId}. Cipher can proceed.`
                    : `Auto-denied action ${approvalId}.`,
                };
              } catch (err: any) {
                return { success: false, message: err?.message ?? "Auto-approve failed" };
              }
            }
            // Escalate: show keypad for King Kazuma's PIN
            return new Promise<ToolCallResult>((resolve) => {
              pendingApprovalRef.current = { id: approvalId, approved, resolve };
              setShowKeypad(true);
            });
          }

          if (name === "send_dev_directive") {
            const type = args.type as string;
            const title = args.title as string;
            const description = args.description as string;
            if (!type || !description) {
              return { success: false, message: "Missing required fields: type, description" };
            }
            const result = await sendDirective(type, title, description);
            const d = result.directive;
            return {
              success: true,
              message: `Directive created: ${d.id} [${d.type}] "${d.title}" — status: ${d.status}`,
            };
          }

          if (name === "get_directives") {
            const status = args.status as string | undefined;
            const directives = await fetchDirectives(status);
            if (directives.length === 0) {
              return { success: true, message: status ? `No directives with status: ${status}` : "No directives found." };
            }
            const list = directives
              .map((d) => {
                let line = `${d.title || "Untitled"}, type: ${d.type}, status: ${d.status}`;
                if (d.plan) line += ", has plan ready for review";
                if (d.directiveApprovalId) line += `, approval: ${d.directiveApprovalId}`;
                return line;
              })
              .join(". ");
            return { success: true, message: `${directives.length} directive(s). ${list}` };
          }
        } catch (err: any) {
          return { success: false, message: err?.message ?? "Bridge call failed" };
        }
      }

      // ── HA tools ──
      const resolved = resolveToolCall(name, args);
      if (!resolved) {
        return { success: false, message: `Entity ${args.entity_id} is not controllable or not recognized.` };
      }
      try {
        await callService(resolved.domain, resolved.service, resolved.data, {
          entity_id: resolved.entityId,
        });
        return { success: true, message: `Called ${resolved.domain}.${resolved.service} on ${resolved.entityId}` };
      } catch (err: any) {
        return { success: false, message: err?.message ?? "Service call failed" };
      }
    },
    [callService]
  );

  const handleKeypadSubmit = useCallback(async (pin: string) => {
    setShowKeypad(false);
    const pending = pendingApprovalRef.current;
    if (!pending) return;
    pendingApprovalRef.current = null;
    try {
      const result = await resolveApproval(pending.id, pending.approved, pin);
      if (result.error) {
        pending.resolve({ success: false, message: result.error });
      } else {
        pending.resolve({
          success: true,
          message: pending.approved
            ? `Action ${pending.id} approved.`
            : `Action ${pending.id} denied.`,
        });
      }
    } catch (err: any) {
      pending.resolve({ success: false, message: err?.message ?? "Resolve failed" });
    }
  }, []);

  const handleKeypadCancel = useCallback(() => {
    setShowKeypad(false);
    const pending = pendingApprovalRef.current;
    if (pending) {
      pendingApprovalRef.current = null;
      pending.resolve({ success: false, message: "PIN entry cancelled by user." });
    }
  }, []);

  const [responseText, setResponseText] = useState("");
  const [inputTranscript, setInputTranscript] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [customInput, setCustomInput] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [connectError, setConnectError] = useState("");
  const inputRef = useRef<TextInput>(null);

  const liveChatRef = useRef<LiveChat>(new LiveChat());
  const playerRef = useRef<StreamingPlayer>(new StreamingPlayer());
  const micRef = useRef<MicRecorder>(new MicRecorder());
  const entitySummaryRef = useRef(entitySummary);
  entitySummaryRef.current = entitySummary;
  const handleToolCallRef = useRef(handleToolCall);
  handleToolCallRef.current = handleToolCall;

  // Connect once on mount — uses refs for latest entity data and tool handler
  useEffect(() => {
    const liveChat = liveChatRef.current;
    let cancelled = false;

    // Wait briefly for HA entity data to arrive, then connect
    const timer = setTimeout(() => {
      if (cancelled) return;

      const callbacks: LiveCallbacks = {
        onAudioChunk: (pcm) => {
          playerRef.current.addChunk(pcm);
        },
        onTranscript: (text) => {
          setResponseText((prev) => prev + text);
        },
        onTurnComplete: () => {
          setIsStreaming(false);
        },
        onError: (msg) => {
          console.error("LiveChat session error:", msg);
          setResponseText((prev) => prev + `\n[Error: ${msg}]`);
          setIsStreaming(false);
        },
        onInterrupted: () => {
          playerRef.current.flush();
          setResponseText("");
          setIsStreaming(true);
        },
        onInputTranscript: (text) => {
          setInputTranscript((prev) => prev + text);
        },
        onToolCall: (name, args) => handleToolCallRef.current(name, args),
      };

      const context = entitySummaryRef.current || "(No entity data available yet)";
      console.log("Connecting LiveChat with context length:", context.length);

      liveChat
        .connect(context, callbacks)
        .then(() => {
          if (cancelled) return;
          setSessionReady(true);
          setConnectError("");
        })
        .catch((err) => {
          console.error("LiveChat connect error:", err);
          if (cancelled) return;
          setSessionReady(false);
          setConnectError(err?.message ?? "Failed to connect to AI");
        });
    }, 2000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      liveChat.close();
      playerRef.current.stop();
      micRef.current.stop();
    };
  }, []);

  const sendMessage = useCallback(
    (message: string) => {
      if (isStreaming || !message.trim() || !sessionReady) return;

      // Stop any current audio + reset
      playerRef.current.stop();
      playerRef.current = new StreamingPlayer();

      // Re-wire callbacks for this turn's player
      liveChatRef.current.setCallbacks({
        onAudioChunk: (pcm) => playerRef.current.addChunk(pcm),
        onTranscript: (text) => setResponseText((prev) => prev + text),
        onTurnComplete: () => setIsStreaming(false),
        onError: (msg) => {
          setResponseText((prev) => prev + `\n[Error: ${msg}]`);
          setIsStreaming(false);
        },
        onInterrupted: () => {
          playerRef.current.flush();
          setResponseText("");
          setIsStreaming(true);
        },
        onInputTranscript: (text) => {
          setInputTranscript((prev) => prev + text);
        },
        onToolCall: handleToolCall,
      });

      setIsStreaming(true);
      setResponseText("");
      setInputTranscript("");
      setShowInput(false);

      liveChatRef.current.send(message);
    },
    [isStreaming, sessionReady, handleToolCall]
  );

  const toggleMic = useCallback(async () => {
    if (isListening) {
      // Stop listening
      micRef.current.stop();
      setIsListening(false);
      return;
    }

    // Request mic permission
    if (Platform.OS === "android") {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) return;
    }

    if (!sessionReady) return;

    // Stop any current playback + reset for new turn
    playerRef.current.stop();
    playerRef.current = new StreamingPlayer();

    liveChatRef.current.setCallbacks({
      onAudioChunk: (pcm) => playerRef.current.addChunk(pcm),
      onTranscript: (text) => setResponseText((prev) => prev + text),
      onTurnComplete: () => setIsStreaming(false),
      onError: (msg) => {
        setResponseText((prev) => prev + `\n[Error: ${msg}]`);
        setIsStreaming(false);
      },
      onInterrupted: () => {
        playerRef.current.flush();
        setResponseText("");
        setIsStreaming(true);
      },
      onInputTranscript: (text) => {
        setInputTranscript((prev) => prev + text);
      },
      onToolCall: handleToolCall,
    });

    setResponseText("");
    setInputTranscript("");
    setIsStreaming(true);
    setIsListening(true);

    micRef.current.start((pcmBase64) => {
      liveChatRef.current.sendAudio(pcmBase64);
    });
  }, [isListening, sessionReady, handleToolCall]);

  const handleCustomSubmit = useCallback(() => {
    if (customInput.trim()) {
      sendMessage(customInput.trim());
      setCustomInput("");
    }
  }, [customInput, sendMessage]);

  const handleAskPress = useCallback(() => {
    setShowInput(true);
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: "#111111" }}>
      {/* Top Bar */}
      <View
        style={{
          height: 48,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 16,
        }}
      >
        <Text style={{ color: "#F59E0B", fontSize: 24, fontWeight: "bold" }}>
          JUNE
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          <TVPressable
            onPress={() => router.back()}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 6,
            }}
          >
            <Text
              style={{
                color: "#A3A3A3",
                fontSize: 12,
                fontWeight: "bold",
                letterSpacing: 1,
              }}
            >
              {"◀ EQUIPMENT"}
            </Text>
          </TVPressable>
          <StatusBadge />
        </View>
      </View>

      {/* Center Content */}
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingBottom: 80,
        }}
      >
        <SciFiOrb active={isStreaming || isListening} />
        {!sessionReady && !connectError && (
          <Text style={{ color: "#525252", fontSize: 13, fontFamily: "monospace", marginTop: 12 }}>
            Connecting to AI...
          </Text>
        )}
        {connectError ? (
          <Text style={{ color: "#EF4444", fontSize: 13, fontFamily: "monospace", marginTop: 12 }}>
            {connectError}
          </Text>
        ) : null}
        {isListening && inputTranscript ? (
          <Text style={{ color: "#6B7280", fontSize: 12, fontFamily: "monospace", marginBottom: 8, fontStyle: "italic" }}>
            {inputTranscript}
          </Text>
        ) : null}
        <StreamingText text={responseText} streaming={isStreaming} />
      </View>

      {/* Bottom Prompts */}
      <View
        style={{
          flexDirection: "row",
          justifyContent: "center",
          gap: 12,
          paddingBottom: 24,
          paddingHorizontal: 24,
        }}
      >
        {QUICK_PROMPTS.map((qp) => (
          <TVPressable
            key={qp.label}
            rarity="rare"
            onPress={() => sendMessage(qp.message)}
            style={{
              paddingHorizontal: 20,
              paddingVertical: 12,
              borderRadius: 8,
            }}
          >
            <Text
              style={{
                color: "#93C5FD",
                fontSize: 13,
                fontWeight: "bold",
                letterSpacing: 1,
              }}
            >
              {qp.label}
            </Text>
          </TVPressable>
        ))}

        {/* Mic button */}
        <TVPressable
          rarity={isListening ? "legendary" : "epic"}
          onPress={toggleMic}
          style={{
            paddingHorizontal: 20,
            paddingVertical: 12,
            borderRadius: 8,
          }}
        >
          <Text
            style={{
              color: isListening ? "#FCD34D" : "#C084FC",
              fontSize: 13,
              fontWeight: "bold",
              letterSpacing: 1,
            }}
          >
            {isListening ? "Stop" : "Speak"}
          </Text>
        </TVPressable>

        {showInput ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              borderWidth: 2,
              borderColor: "#06B6D4",
              borderRadius: 8,
              backgroundColor: "rgba(6,182,212,0.08)",
              paddingHorizontal: 12,
            }}
          >
            <TextInput
              ref={inputRef}
              value={customInput}
              onChangeText={setCustomInput}
              onSubmitEditing={handleCustomSubmit}
              placeholder="Ask something..."
              placeholderTextColor="#525252"
              style={{
                color: "#E0E0E0",
                fontSize: 13,
                fontFamily: "monospace",
                minWidth: 200,
                paddingVertical: 10,
              }}
              returnKeyType="send"
            />
          </View>
        ) : (
          <TVPressable
            rarity="epic"
            onPress={handleAskPress}
            style={{
              paddingHorizontal: 20,
              paddingVertical: 12,
              borderRadius: 8,
            }}
          >
            <Text
              style={{
                color: "#C084FC",
                fontSize: 13,
                fontWeight: "bold",
                letterSpacing: 1,
              }}
            >
              Ask...
            </Text>
          </TVPressable>
        )}
      </View>

      <Keypad
        visible={showKeypad}
        title="AUTHORIZE ACTION"
        onSubmit={handleKeypadSubmit}
        onCancel={handleKeypadCancel}
      />

      <StatusBar style="light" />
    </View>
  );
}
