import { useState, useCallback, useRef, useEffect } from "react";
import { View, Text, TextInput, PermissionsAndroid, Platform } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StatusBadge } from "../components/StatusBadge";
import { TVPressable } from "../components/TVPressable";
import { SciFiOrb } from "../components/SciFiOrb";
import { StreamingText } from "../components/StreamingText";
import { BridgeSession, type BridgeCallbacks } from "../lib/bridge-session";
import { StreamingPlayer, MicRecorder } from "../lib/audio";
import { getDeviceType } from "../modules/pcm-player";
import { Keypad } from "../components/Keypad";

export default function ChatScreen() {
  const router = useRouter();

  // Detect device role once
  const deviceRole = useRef<"mic" | "speaker">("mic");
  try {
    deviceRole.current = getDeviceType() === "tv" ? "speaker" : "mic";
  } catch {}

  const isMic = deviceRole.current === "mic";
  const isSpeaker = deviceRole.current === "speaker";

  const [showKeypad, setShowKeypad] = useState(false);
  const pendingPinRef = useRef<{ approvalId: string } | null>(null);

  const [responseText, setResponseText] = useState("");
  const [inputTranscript, setInputTranscript] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [customInput, setCustomInput] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [connectError, setConnectError] = useState("");
  const inputRef = useRef<TextInput>(null);

  const bridgeRef = useRef<BridgeSession>(new BridgeSession());
  const playerRef = useRef<StreamingPlayer>(new StreamingPlayer());
  const micRef = useRef<MicRecorder>(new MicRecorder());

  // Connect to bridge on mount
  useEffect(() => {
    const bridge = bridgeRef.current;
    let cancelled = false;

    const requestMicAndStart = async () => {
      if (Platform.OS === "android") {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) return;
      }
      if (cancelled) return;
      micRef.current.start((pcmBase64) => {
        bridge.sendAudio(pcmBase64);
      });
      setIsListening(true);
    };

    const callbacks: BridgeCallbacks = {
      onReady: () => {
        if (cancelled) return;
        setSessionReady(true);
        setConnectError("");

        // Tablets: auto-start mic on ready
        if (isMic) {
          requestMicAndStart();
        }
      },
      onAudioChunk: (pcm) => {
        playerRef.current.addChunk(pcm);
      },
      onTranscript: (text) => {
        setResponseText((prev) => prev + text);
      },
      onInputTranscript: (text) => {
        setInputTranscript((prev) => prev + text);
      },
      onTurnComplete: () => {
        setIsStreaming(false);
      },
      onInterrupted: () => {
        playerRef.current.flush();
        setResponseText("");
        setIsStreaming(true);
      },
      onPinRequest: (approvalId, description) => {
        pendingPinRef.current = { approvalId };
        setShowKeypad(true);
      },
      onError: (msg) => {
        console.error("BridgeSession error:", msg);
        if (!sessionReady) {
          setConnectError(msg);
        }
        setResponseText((prev) => prev + `\n[Error: ${msg}]`);
        setIsStreaming(false);
      },
    };

    bridge.connect(callbacks);

    return () => {
      cancelled = true;
      bridge.close();
      playerRef.current.stop();
      micRef.current.stop();
    };
  }, []);

  const handleKeypadSubmit = useCallback((pin: string) => {
    setShowKeypad(false);
    const pending = pendingPinRef.current;
    if (!pending) return;
    pendingPinRef.current = null;
    bridgeRef.current.sendPinResponse(pending.approvalId, pin);
  }, []);

  const handleKeypadCancel = useCallback(() => {
    setShowKeypad(false);
    pendingPinRef.current = null;
  }, []);

  const sendTextMessage = useCallback(
    (message: string) => {
      if (!message.trim() || !sessionReady) return;

      // Reset player for new response
      playerRef.current.stop();
      playerRef.current = new StreamingPlayer();

      setIsStreaming(true);
      setResponseText("");
      setInputTranscript("");
      setShowInput(false);

      bridgeRef.current.sendText(message);
    },
    [sessionReady]
  );

  const handleCustomSubmit = useCallback(() => {
    if (customInput.trim()) {
      sendTextMessage(customInput.trim());
      setCustomInput("");
    }
  }, [customInput, sendTextMessage]);

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
          <Text
            style={{
              color: isMic ? "#34D399" : "#60A5FA",
              fontSize: 10,
              fontWeight: "bold",
              letterSpacing: 1,
              fontFamily: "monospace",
            }}
          >
            {isMic ? "MIC" : "SPEAKER"}
          </Text>
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
          <Text
            style={{
              color: "#525252",
              fontSize: 13,
              fontFamily: "monospace",
              marginTop: 12,
            }}
          >
            Connecting to bridge...
          </Text>
        )}
        {connectError ? (
          <Text
            style={{
              color: "#EF4444",
              fontSize: 13,
              fontFamily: "monospace",
              marginTop: 12,
            }}
          >
            {connectError}
          </Text>
        ) : null}
        {isListening && inputTranscript ? (
          <Text
            style={{
              color: "#6B7280",
              fontSize: 12,
              fontFamily: "monospace",
              marginBottom: 8,
              fontStyle: "italic",
            }}
          >
            {inputTranscript}
          </Text>
        ) : null}
        <StreamingText text={responseText} streaming={isStreaming} />
      </View>

      {/* Bottom Bar */}
      <View
        style={{
          flexDirection: "row",
          justifyContent: "center",
          gap: 12,
          paddingBottom: 24,
          paddingHorizontal: 24,
        }}
      >
        {isMic && isListening && (
          <View
            style={{
              paddingHorizontal: 20,
              paddingVertical: 12,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: "rgba(52,211,153,0.3)",
              backgroundColor: "rgba(52,211,153,0.08)",
            }}
          >
            <Text
              style={{
                color: "#34D399",
                fontSize: 13,
                fontWeight: "bold",
                letterSpacing: 1,
              }}
            >
              LISTENING
            </Text>
          </View>
        )}

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
