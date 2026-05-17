// Glasses screen — lightweight connect/status page
// All processing runs in GlassesProvider (background context)
// This screen just shows connection status and provides connect/disconnect controls

import { View, Text, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useGlasses } from "../lib/glasses-context";
import { GroupNav } from "../components/GroupNav";

import { colors } from "../lib/design-tokens";
const CYAN = colors.accent;
const DIM = colors.gray[400];

export default function GlassesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    connectionState,
    isConnected,
    isStreaming,
    fps,
    error,
    connect,
    disconnect,
    capturePhoto,
  } = useGlasses();

  const stateColor = isConnected ? "#10B981" : connectionState === "connecting" ? colors.brand.amber : DIM;
  const stateLabel = isConnected
    ? isStreaming ? `CONNECTED ${fps} FPS` : "CONNECTED"
    : connectionState === "connecting" ? "CONNECTING..." : "DISCONNECTED";

  return (
    <View style={{ flex: 1, backgroundColor: colors.gray[850], paddingTop: insets.top }}>
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 16, marginBottom: 16 }}>
        <Pressable onPress={() => router.back()} hitSlop={20} style={{ padding: 8 }}>
          <Text style={{ color: DIM, fontSize: 22 }}>{"\u2190"}</Text>
        </Pressable>
        <Text style={{ color: "#fff", fontSize: 16, fontFamily: "monospace", fontWeight: "700", letterSpacing: 2 }}>
          META GLASSES
        </Text>
        <View style={{ width: 38 }} />
      </View>

      <GroupNav group="ops" />

      <View style={{ paddingHorizontal: 20, paddingTop: 16, flex: 1 }}>

      {/* Status indicator */}
      <View style={{ alignItems: "center", marginBottom: 40 }}>
        <View style={{
          width: 120, height: 120, borderRadius: 60,
          borderWidth: 2, borderColor: stateColor,
          justifyContent: "center", alignItems: "center",
          backgroundColor: "rgba(0,0,0,0.5)",
        }}>
          <Text style={{ fontSize: 40 }}>{isConnected ? "\u{1F453}" : "\u{1F50C}"}</Text>
        </View>
        <Text style={{
          color: stateColor, fontSize: 12, fontFamily: "monospace",
          fontWeight: "700", letterSpacing: 2, marginTop: 16,
        }}>
          {stateLabel}
        </Text>
      </View>

      {/* Connect / Disconnect button */}
      <Pressable
        onPress={isConnected ? disconnect : connect}
        style={{
          backgroundColor: isConnected ? "rgba(239,68,68,0.15)" : "rgba(6,182,212,0.15)",
          borderWidth: 1,
          borderColor: isConnected ? colors.error : CYAN,
          borderRadius: 12,
          paddingVertical: 16,
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <Text style={{
          color: isConnected ? colors.error : CYAN,
          fontSize: 14, fontFamily: "monospace", fontWeight: "700", letterSpacing: 2,
        }}>
          {isConnected ? "DISCONNECT" : "CONNECT GLASSES"}
        </Text>
      </Pressable>

      {/* Capture button (only when streaming) */}
      {isStreaming && (
        <Pressable
          onPress={capturePhoto}
          style={{
            backgroundColor: "rgba(168,85,247,0.15)",
            borderWidth: 1,
            borderColor: colors.brand.purple,
            borderRadius: 12,
            paddingVertical: 16,
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <Text style={{
            color: colors.brand.purple,
            fontSize: 14, fontFamily: "monospace", fontWeight: "700", letterSpacing: 2,
          }}>
            CAPTURE PHOTO
          </Text>
        </Pressable>
      )}

      {/* Info */}
      {isStreaming && (
        <View style={{
          backgroundColor: "rgba(255,255,255,0.05)",
          borderRadius: 8,
          padding: 16,
          marginBottom: 16,
        }}>
          <Text style={{ color: DIM, fontSize: 11, fontFamily: "monospace", marginBottom: 8 }}>
            RUNNING IN BACKGROUND
          </Text>
          <Text style={{ color: "#9CA3AF", fontSize: 12, fontFamily: "monospace", lineHeight: 20 }}>
            Glasses are processing in the background. You can navigate to other screens.{"\n\n"}
            Show your open palm to the camera to capture a photo — it will appear as an overlay wherever you are.
          </Text>
        </View>
      )}

      {/* Error */}
      {error && (
        <View style={{
          backgroundColor: "rgba(239,68,68,0.1)",
          borderRadius: 8,
          padding: 12,
        }}>
          <Text style={{ color: colors.error, fontSize: 11, fontFamily: "monospace" }}>{error}</Text>
        </View>
      )}
      </View>
    </View>
  );
}
