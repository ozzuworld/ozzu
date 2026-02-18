import { useState, useCallback, useRef, useEffect } from "react";
import { View, Text, Animated, Easing, useWindowDimensions, PermissionsAndroid, Platform, Pressable } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { StatusBadge } from "../components/StatusBadge";
import { HamburgerMenu } from "../components/HamburgerMenu";
import LottieView from "lottie-react-native";
import { TranscriptBubble } from "../components/TranscriptBubble";
import { BridgeSession, type BridgeCallbacks } from "../lib/bridge-session";
import { StreamingPlayer, MicRecorder } from "../lib/audio";
import { getDeviceType } from "../modules/pcm-player";
import { Keypad } from "../components/Keypad";
import { canUseBiometric, authenticateWithBiometric, BRIDGE_PIN } from "../lib/biometric-auth";
import { fetchPendingApprovals, resolveApproval } from "../lib/bridge-api";
import { CameraOverlay } from "../components/CameraOverlay";
import { ContentPanel } from "../components/ContentPanel";
import { useEntity } from "../lib/useEntity";
import { useKeepAwake } from "expo-keep-awake";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import * as CipherVoice from "../modules/cipher-voice";

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
  const pendingPinRef = useRef<{ approvalId: string; restResolve?: boolean } | null>(null);

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
  const [isMuted, setIsMuted] = useState(false);
  const isMutedRef = useRef(false);
  const spotifyEntity = useEntity("media_player.spotify_king_kazuma");

  // Detect cipher-voice availability (iPhone with on-device STT/TTS)
  const hasCipherVoice = useRef(false);
  try {
    hasCipherVoice.current = CipherVoice.isAvailable();
  } catch {
    hasCipherVoice.current = false;
  }

  const bridgeRef = useRef<BridgeSession>(new BridgeSession());
  const playerRef = useRef<StreamingPlayer>(new StreamingPlayer());
  const micRef = useRef<MicRecorder>(new MicRecorder());

  // Connect to bridge on mount
  useEffect(() => {
    const bridge = bridgeRef.current;
    const useCipherVoice = hasCipherVoice.current;
    let cancelled = false;
    let clearTranscriptTimer: ReturnType<typeof setTimeout> | null = null;

    // Tell bridge session about cipher-voice capability before connecting
    if (useCipherVoice) {
      bridge.setCipherVoice(true);
      console.log("[index] Cipher voice available — using on-device STT/TTS");
    }

    // ── Cipher voice event subscriptions (iPhone only) ──
    const cipherVoiceSubs: Array<{ remove: () => void }> = [];

    const startCipherVoiceListening = async () => {
      if (!useCipherVoice) return;
      bridge.sendDebug("STT: requesting permissions");
      const granted = await CipherVoice.requestPermissions();
      if (!granted || cancelled) {
        bridge.sendDebug(`STT: permissions denied (granted=${granted}, cancelled=${cancelled})`);
        return;
      }
      bridge.sendDebug("STT: calling startListening");
      try {
        const ok = await CipherVoice.startListening();
        bridge.sendDebug(`STT: startListening returned ${ok}`);
        if (ok) setIsListening(true);
      } catch (e: any) {
        bridge.sendDebug(`STT: startListening THREW: ${e.message}`);
      }
    };

    if (useCipherVoice) {
      // STT results from on-device speech recognition
      cipherVoiceSubs.push(
        CipherVoice.onSttResult((event) => {
          if (cancelled) return;
          bridge.sendDebug(`STT result: isFinal=${event.isFinal} text="${event.text.substring(0, 50)}"`);
          if (event.isFinal && event.text.trim()) {
            // Send transcribed text to bridge for Claude processing
            bridge.sendCipherText(event.text);
            setInputTranscript(event.text);
            setIsListening(false);
            setIsStreaming(true);
            // Restart listening for next utterance after a brief pause
            CipherVoice.stopListening();
          }
        })
      );

      // TTS audio captured for relay to tablets
      cipherVoiceSubs.push(
        CipherVoice.onTtsAudio((event) => {
          if (cancelled) return;
          bridge.sendCipherAudio(event.data);
        })
      );

      // TTS finished speaking
      cipherVoiceSubs.push(
        CipherVoice.onTtsDone(() => {
          if (cancelled) return;
          bridge.sendDebug("TTS done — restarting STT");
          bridge.sendCipherTtsDone();
          setIsStreaming(false);
          setIsListening(true);
          // Restart STT listening after Cipher finishes speaking
          startCipherVoiceListening();
        })
      );

      // STT errors
      cipherVoiceSubs.push(
        CipherVoice.onSttError((event) => {
          bridge.sendDebug(`STT error: ${event.error}`);
          // Auto-restart listening after error
          if (!cancelled) {
            setTimeout(() => startCipherVoiceListening(), 1000);
          }
        })
      );
    }

    const requestMicAndStart = async () => {
      if (useCipherVoice) {
        // iPhone with cipher-voice: use on-device STT instead of MicRecorder
        startCipherVoiceListening();
        return;
      }
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
        // iPhone with cipher-voice: auto-start on-device STT on ready
        if (isMic) {
          requestMicAndStart();
        }
      },
      onAudioChunk: (pcm) => {
        if (!isMutedRef.current) {
          playerRef.current.addChunk(pcm);
        }
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
        if (useCipherVoice) {
          CipherVoice.interrupt();
        }
        playerRef.current.flush();
        setResponseText("");
        setIsStreaming(true);
      },
      onPinRequest: async (approvalId) => {
        // Approvals are now handled via the dashboard — no auto-biometric popups
        console.log("[index] pinRequest received for", approvalId, "— handled via dashboard");
        return;
      },
      onPinResolved: () => {
        pendingPinRef.current = null;
        setShowKeypad(false);
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
      onConnected: async () => {
        if (cancelled) return;
        // Approvals are now handled via the dashboard — no auto-biometric on connect
      },
      onListeningReady: () => {
        // Cipher finished speaking — show listening state on orb
        setIsStreaming(false);
        setIsListening(true);
        // If using cipher-voice, restart listening
        if (useCipherVoice) {
          startCipherVoiceListening();
        }
      },
      // Phone-mode: bridge sends Claude response text for on-device TTS
      onCipherResponse: (text) => {
        if (!useCipherVoice || cancelled) return;
        bridge.sendDebug(`TTS: speaking "${text.substring(0, 40)}..."`);
        setResponseText(text);
        setIsStreaming(true);
        CipherVoice.speak(text).then((ok: boolean) => {
          bridge.sendDebug(`TTS: speak() returned ${ok}`);
        }).catch((e: any) => {
          bridge.sendDebug(`TTS: speak() THREW: ${e.message}`);
        });
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
      // Clean up cipher voice subscriptions
      for (const sub of cipherVoiceSubs) sub.remove();
      if (useCipherVoice) {
        CipherVoice.stopListening();
        CipherVoice.interrupt();
      }
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
    if (pending.restResolve) {
      resolveApproval(pending.approvalId, true, pin).catch(() => {});
    } else {
      bridgeRef.current.sendPinResponse(pending.approvalId, pin);
    }
  }, []);

  const handleKeypadCancel = useCallback(() => {
    setShowKeypad(false);
    pendingPinRef.current = null;
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      isMutedRef.current = next;
      if (next) {
        playerRef.current.flush();
      }
      return next;
    });
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: "#000000" }}>
      {/* ── HUD decorations (below Lottie layer) ── */}
      <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 0 }}>
        {/* Center glow */}
        <View
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
      </View>

      {/* Top Bar — hamburger left, status right */}
      <View
        style={{
          paddingTop: insets.top,
          height: 48 + insets.top,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: Math.max(20, insets.left, insets.right),
          backgroundColor: "#000000",
          zIndex: 10,
          elevation: 10,
        }}
      >
        <HamburgerMenu />
        <StatusBadge />
      </View>

      {/* Center — Lottie talking animation (tappable = mute toggle) */}
      <Pressable
        onPress={toggleMute}
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#000000",
          zIndex: 2,
          elevation: 2,
        }}
      >
        <LottieView
          source={require("../assets/talking.json")}
          autoPlay
          loop
          resizeMode="contain"
          style={{
            width: Math.min(screenWidth * 0.85, screenHeight * 0.5, 420),
            height: Math.min(screenWidth * 0.85, screenHeight * 0.5, 420),
            opacity: isMuted ? 0.4 : 1,
          }}
        />
        {isMuted && (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="volume-mute" size={48} color="rgba(255,255,255,0.6)" />
          </View>
        )}
      </Pressable>

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

      {/* Floating bottom-right — music button only */}
      {spotifyEntity && spotifyEntity.state !== "unavailable" && (
        <Pressable
          onPress={() => router.push("/music")}
          style={({ pressed }) => ({
            position: "absolute",
            bottom: Math.max(24, insets.bottom + 8),
            right: Math.max(24, insets.right + 8),
            zIndex: 90,
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: "rgba(255,255,255,0.1)",
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.5 : 1,
          })}
        >
          <Ionicons name="musical-notes" size={22} color="#FFFFFF" />
        </Pressable>
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
