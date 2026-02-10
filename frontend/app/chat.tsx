import { useState, useCallback, useRef, useEffect } from "react";
import { View, Text, TextInput, PermissionsAndroid, Platform } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StatusBadge } from "../components/StatusBadge";
import { TVPressable } from "../components/TVPressable";
import { SciFiOrb } from "../components/SciFiOrb";
import { StreamingText } from "../components/StreamingText";
import { LiveChat, type LiveCallbacks } from "../lib/live-session";
import { StreamingPlayer, MicRecorder } from "../lib/audio";
import { useEntitySummary } from "../lib/useEntitySummary";

const QUICK_PROMPTS = [
  { label: "Status Report", message: "Give me a full status report of all systems" },
  { label: "Devices", message: "What devices are on right now and their states?" },
] as const;

export default function ChatScreen() {
  const router = useRouter();
  const entitySummary = useEntitySummary();

  const [responseText, setResponseText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [customInput, setCustomInput] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const liveChatRef = useRef<LiveChat>(new LiveChat());
  const playerRef = useRef<StreamingPlayer>(new StreamingPlayer());
  const micRef = useRef<MicRecorder>(new MicRecorder());

  // Connect persistent session on mount
  useEffect(() => {
    if (!entitySummary) return;

    const liveChat = liveChatRef.current;

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
        setResponseText((prev) => prev + `\n[Error: ${msg}]`);
        setIsStreaming(false);
      },
    };

    liveChat
      .connect(entitySummary, callbacks)
      .then(() => setSessionReady(true))
      .catch(() => setSessionReady(false));

    return () => {
      liveChat.close();
      playerRef.current.stop();
      micRef.current.stop();
    };
  }, [entitySummary]);

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
      });

      setIsStreaming(true);
      setResponseText("");
      setShowInput(false);

      liveChatRef.current.send(message);
    },
    [isStreaming, sessionReady]
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
    });

    setResponseText("");
    setIsStreaming(true);
    setIsListening(true);

    micRef.current.start((pcmBase64) => {
      liveChatRef.current.sendAudio(pcmBase64);
    });
  }, [isListening, sessionReady]);

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
          ozzu
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

      <StatusBar style="light" />
    </View>
  );
}
