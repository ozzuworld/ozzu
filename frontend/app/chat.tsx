import { useState, useCallback, useRef } from "react";
import { View, Text, TextInput } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StatusBadge } from "../components/StatusBadge";
import { TVPressable } from "../components/TVPressable";
import { SciFiOrb } from "../components/SciFiOrb";
import { StreamingText } from "../components/StreamingText";
import { streamChat } from "../lib/gemini";
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
  const [customInput, setCustomInput] = useState("");
  const [showInput, setShowInput] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const sendMessage = useCallback(
    async (message: string) => {
      if (isStreaming || !message.trim()) return;
      setIsStreaming(true);
      setResponseText("");
      setShowInput(false);

      try {
        for await (const chunk of streamChat(message, entitySummary)) {
          setResponseText((prev) => prev + chunk);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        setResponseText((prev) => prev + `\n[Error: ${msg}]`);
      } finally {
        setIsStreaming(false);
      }
    },
    [isStreaming, entitySummary]
  );

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
        <SciFiOrb active={isStreaming} />
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
