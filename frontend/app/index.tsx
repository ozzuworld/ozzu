import { useState, useCallback, useRef, useEffect } from "react";
import { View, Text, Animated, Easing, useWindowDimensions, PermissionsAndroid, Platform } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { StatusBadge } from "../components/StatusBadge";
import { HamburgerMenu } from "../components/HamburgerMenu";
import LottieView from "lottie-react-native";
import { TranscriptBubble } from "../components/TranscriptBubble";
import { BridgeSession, type BridgeCallbacks } from "../lib/bridge-session";
import { StreamingPlayer, MicRecorder } from "../lib/audio";
import { getDeviceType } from "../modules/pcm-player";
import { Keypad } from "../components/Keypad";
import { TVPressable } from "../components/TVPressable";
import { CameraOverlay } from "../components/CameraOverlay";
import { ContentPanel } from "../components/ContentPanel";
import { useEntity } from "../lib/useEntity";
import { useKeepAwake } from "expo-keep-awake";
import { usePhoneLayout } from "../lib/usePhoneLayout";

// ── HUD corner bracket ──
const BRACKET_LEN = 20;
const BRACKET_W = 2;
const BRACKET_COLOR = "rgba(6,182,212,0.3)";

function HudCorner({ top, left, right, bottom }: { top?: number; left?: number; right?: number; bottom?: number }) {
  const isTop = top !== undefined;
  const isLeft = left !== undefined;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top, left, right, bottom,
        width: BRACKET_LEN,
        height: BRACKET_LEN,
      }}
    >
      {/* Horizontal arm */}
      <View
        style={{
          position: "absolute",
          [isTop ? "top" : "bottom"]: 0,
          [isLeft ? "left" : "right"]: 0,
          width: BRACKET_LEN,
          height: BRACKET_W,
          backgroundColor: BRACKET_COLOR,
        }}
      />
      {/* Vertical arm */}
      <View
        style={{
          position: "absolute",
          [isTop ? "top" : "bottom"]: 0,
          [isLeft ? "left" : "right"]: 0,
          width: BRACKET_W,
          height: BRACKET_LEN,
          backgroundColor: BRACKET_COLOR,
        }}
      />
    </View>
  );
}

// ── Scan line ──
function ScanLine() {
  const translateY = useRef(new Animated.Value(0)).current;
  const { height: screenHeight } = useWindowDimensions();

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(translateY, {
        toValue: screenHeight,
        duration: 8000,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [screenHeight]);

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: 0,
        height: 2,
        backgroundColor: "rgba(6,182,212,0.04)",
        transform: [{ translateY }],
      }}
    />
  );
}

export default function LandingScreen() {
  useKeepAwake();
  const router = useRouter();
  const { insets, isPhone, screenWidth, screenHeight } = usePhoneLayout();

  // Detect device role once
  const deviceRole = useRef<"mic" | "speaker">("mic");
  try {
    deviceRole.current = getDeviceType() === "tv" ? "speaker" : "mic";
  } catch {}

  const isMic = deviceRole.current === "mic";

  const [showKeypad, setShowKeypad] = useState(false);
  const pendingPinRef = useRef<{ approvalId: string } | null>(null);

  const [cameraOverlay, setCameraOverlay] = useState<{
    visible: boolean;
    streamUrl: string;
    cameraName: string;
  }>({ visible: false, streamUrl: "", cameraName: "" });

  const [contentPanel, setContentPanel] = useState<{
    visible: boolean;
    title: string;
    content: string;
  }>({ visible: false, title: "", content: "" });

  const [responseText, setResponseText] = useState("");
  const [inputTranscript, setInputTranscript] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const spotifyEntity = useEntity("media_player.spotify_king_kazuma");

  const bridgeRef = useRef<BridgeSession>(new BridgeSession());
  const playerRef = useRef<StreamingPlayer>(new StreamingPlayer());
  const micRef = useRef<MicRecorder>(new MicRecorder());

  // Connect to bridge on mount
  useEffect(() => {
    const bridge = bridgeRef.current;
    let cancelled = false;
    let clearTranscriptTimer: ReturnType<typeof setTimeout> | null = null;

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
        setIsStreaming(true);
      },
      onInputTranscript: (text) => {
        setInputTranscript((prev) => prev + text);
      },
      onTurnComplete: () => {
        setIsStreaming(false);
        // Clear transcripts for next turn after delay so user sees final text
        if (clearTranscriptTimer) clearTimeout(clearTranscriptTimer);
        clearTranscriptTimer = setTimeout(() => {
          if (!cancelled) {
            setResponseText("");
            setInputTranscript("");
          }
          clearTranscriptTimer = null;
        }, 5000);
      },
      onInterrupted: () => {
        playerRef.current.flush();
        setResponseText("");
        setIsStreaming(true);
      },
      onPinRequest: (approvalId) => {
        pendingPinRef.current = { approvalId };
        setShowKeypad(true);
      },
      onPinResolved: () => {
        setShowKeypad(false);
        pendingPinRef.current = null;
      },
      onShowCamera: (_cameraId, streamUrl, cameraName) => {
        setCameraOverlay({ visible: true, streamUrl, cameraName });
      },
      onHideCamera: () => {
        setCameraOverlay({ visible: false, streamUrl: "", cameraName: "" });
      },
      onShowContent: (title, content) => {
        setContentPanel({ visible: true, title, content });
      },
      onHideContent: () => {
        setContentPanel({ visible: false, title: "", content: "" });
      },
      onListeningReady: () => {
        // Cipher finished speaking — show listening state on orb
        setIsStreaming(false);
        setIsListening(true);
      },
      onError: (msg) => {
        console.error("BridgeSession error:", msg);
        setResponseText((prev) => prev + `\n[Error: ${msg}]`);
        setIsStreaming(false);
      },
    };

    bridge.connect(callbacks);

    return () => {
      cancelled = true;
      if (clearTranscriptTimer) clearTimeout(clearTranscriptTimer);
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

  return (
    <View style={{ flex: 1, backgroundColor: "#000000" }}>
      {/* ── Subtle background depth ── */}
      {/* Center glow */}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: "30%",
          left: "25%",
          width: "50%",
          height: "40%",
          borderRadius: 9999,
          backgroundColor: "rgba(6,182,212,0.03)",
        }}
      />
      {/* Vignette corners — top-left */}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "40%",
          height: "30%",
          backgroundColor: "rgba(0,0,0,0.15)",
          borderBottomRightRadius: 9999,
        }}
      />
      {/* Vignette corners — bottom-right */}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          bottom: 0,
          right: 0,
          width: "40%",
          height: "30%",
          backgroundColor: "rgba(0,0,0,0.15)",
          borderTopLeftRadius: 9999,
        }}
      />

      {/* ── HUD corner brackets ── */}
      <HudCorner top={Math.max(12, insets.top)} left={Math.max(12, insets.left)} />
      <HudCorner top={Math.max(12, insets.top)} right={Math.max(12, insets.right)} />
      <HudCorner bottom={Math.max(12, insets.bottom)} left={Math.max(12, insets.left)} />
      <HudCorner bottom={Math.max(12, insets.bottom)} right={Math.max(12, insets.right)} />

      {/* ── Scan line ── */}
      <ScanLine />

      {/* Top Bar — hamburger left, status right */}
      <View
        style={{
          paddingTop: insets.top,
          height: 48 + insets.top,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: Math.max(20, insets.left, insets.right),
          zIndex: 10,
        }}
      >
        <HamburgerMenu />
        <StatusBadge />
      </View>

      {/* Center — Lottie talking animation */}
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#000000",
          zIndex: 1,
        }}
      >
        <LottieView
          source={require("../assets/talking.json")}
          autoPlay
          loop
          style={{
            width: Math.min(screenWidth * 0.85, screenHeight * 0.5, 420),
            height: Math.min(screenWidth * 0.85, screenHeight * 0.5, 420),
          }}
        />
      </View>

      {/* Transcription bubble — bottom-left corner */}
      <TranscriptBubble
        inputTranscript={inputTranscript}
        responseText={responseText}
        isStreaming={isStreaming}
      />

      <CameraOverlay
        visible={cameraOverlay.visible}
        streamUrl={cameraOverlay.streamUrl}
        cameraName={cameraOverlay.cameraName}
        onClose={() =>
          setCameraOverlay({ visible: false, streamUrl: "", cameraName: "" })
        }
      />

      <ContentPanel
        visible={contentPanel.visible}
        title={contentPanel.title}
        content={contentPanel.content}
        onClose={() =>
          setContentPanel({ visible: false, title: "", content: "" })
        }
      />

      {/* Floating music button */}
      {spotifyEntity && spotifyEntity.state !== "unavailable" && (
        <View
          style={{
            position: "absolute",
            bottom: Math.max(24, insets.bottom + 8),
            right: Math.max(24, insets.right + 8),
            zIndex: 90,
          }}
        >
          <TVPressable
            rarity="legendary"
            onPress={() => router.push("/music")}
            style={{ paddingHorizontal: 10, paddingVertical: 8 }}
          >
            <Text style={{ fontSize: 20 }}>🎵</Text>
          </TVPressable>
        </View>
      )}

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
