import { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  Image,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  LayoutChangeEvent,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { useKeepAwake } from "expo-keep-awake";
import { StatusBadge } from "../components/StatusBadge";
import { TVPressable } from "../components/TVPressable";
import { BridgeSession, type BridgeCallbacks } from "../lib/bridge-session";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import * as Glasses from "../modules/expo-glasses";
import * as MediaPipe from "../modules/expo-mediapipe";
import type { HandResult } from "../modules/expo-mediapipe";
import HandOverlay from "../components/glasses/HandOverlay";
import { detectGesture, gestureEmoji, type GestureResult } from "../lib/gestures";

const TOP_BAR_HEIGHT = 48;

type Quality = "low" | "medium" | "high";

const QUALITY_LABELS: Record<Quality, string> = {
  low: "LOW",
  medium: "MED",
  high: "HIGH",
};

export default function GlassesScreen() {
  useKeepAwake();
  const router = useRouter();
  const { insets, isPhone } = usePhoneLayout();

  const [available, setAvailable] = useState<boolean | null>(null);
  const [connectionState, setConnectionState] =
    useState<Glasses.ConnectionState>("disconnected");
  const [streamState, setStreamState] = useState<string>("stopped");
  const [quality, setQuality] = useState<Quality>("medium");
  const [frameData, setFrameData] = useState<string | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Record<string, any> | null>(null);

  // AR mode state
  const [arMode, setArMode] = useState(false);
  const [hands, setHands] = useState<HandResult[]>([]);
  const [currentGesture, setCurrentGesture] = useState<GestureResult | null>(
    null
  );
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const mediapipeReady = useRef(false);
  const processingFrame = useRef(false);

  const bridgeRef = useRef<BridgeSession>(new BridgeSession());
  const connectedRef = useRef(false);
  const frameCountRef = useRef(0);
  const lastFrameTimeRef = useRef(0);
  const [fps, setFps] = useState(0);

  // Bridge connection for forwarding frames/photos
  useEffect(() => {
    const noop = () => {};
    const callbacks: BridgeCallbacks = {
      onReady: () => {
        connectedRef.current = true;
      },
      onAudioChunk: noop,
      onTranscript: noop,
      onInputTranscript: noop,
      onTurnComplete: noop,
      onInterrupted: noop,
      onPinRequest: noop,
      onPinResolved: noop,
      onShowCamera: noop,
      onHideCamera: noop,
      onShowContent: noop,
      onHideContent: noop,
      onConnected: noop,
      onListeningReady: noop,
      onError: (msg) => setError(msg),
    };
    bridgeRef.current.connect(callbacks);
    return () => bridgeRef.current.close();
  }, []);

  // Check availability and initialize
  useEffect(() => {
    const avail = Glasses.isAvailable();
    setAvailable(avail);
    if (avail) {
      setInitializing(true);
      Glasses.initialize()
        .then(() => setInitializing(false))
        .catch(() => setInitializing(false));
    }
  }, []);

  // Native event listeners
  useEffect(() => {
    const subs = [
      Glasses.onConnectionChanged((event) => {
        setConnectionState(event.state);
        if (event.error) setError(event.error);
        // Report to bridge
        if (connectedRef.current) {
          bridgeRef.current.sendGlassesStatus(event.state);
        }
      }),
      Glasses.onVideoFrame((event) => {
        setFrameData(event.data);
        frameCountRef.current++;
        setFrameCount(frameCountRef.current);

        // Calculate FPS
        const now = Date.now();
        if (now - lastFrameTimeRef.current >= 1000) {
          setFps(frameCountRef.current);
          frameCountRef.current = 0;
          lastFrameTimeRef.current = now;
        }

        // Forward frame to bridge for Gemini vision (throttled to ~2fps)
        if (connectedRef.current && frameCountRef.current % 8 === 0) {
          bridgeRef.current.sendGlassesFrame(
            event.data,
            event.width,
            event.height
          );
        }

        // AR hand detection (skip if already processing to prevent pile-up)
        if (
          mediapipeReady.current &&
          !processingFrame.current
        ) {
          processingFrame.current = true;
          MediaPipe.detectHands(event.data)
            .then((results) => {
              setHands(results);
              if (results.length > 0) {
                setCurrentGesture(detectGesture(results[0].landmarks));
              } else {
                setCurrentGesture(null);
              }
            })
            .catch(() => {})
            .finally(() => {
              processingFrame.current = false;
            });
        }
      }),
      Glasses.onPhotoCaptured((event) => {
        setCapturedPhoto(event.data);
        // Forward photo to bridge
        if (connectedRef.current) {
          bridgeRef.current.sendGlassesPhoto(event.data);
        }
      }),
      Glasses.onStreamStateChanged((event) => {
        setStreamState(event.state);
      }),
      Glasses.onError((event) => {
        setError(`[${event.code}] ${event.message}`);
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  const handleConnect = useCallback(async () => {
    setError(null);
    // Log diagnostics before connect attempt
    try {
      const diag = Glasses.getDiagnostics();
      console.log("[Glasses] Pre-connect diagnostics:", JSON.stringify(diag));
    } catch {}
    try {
      await Glasses.registerDevice();
    } catch (e: any) {
      setError(e.message || "Failed to register");
    }
  }, []);

  const handleDisconnect = useCallback(async () => {
    setError(null);
    try {
      // Clean up AR mode
      if (arMode) {
        setArMode(false);
        mediapipeReady.current = false;
        setHands([]);
        setCurrentGesture(null);
        await MediaPipe.dispose();
      }
      if (streamState !== "stopped") {
        await Glasses.stopVideoStream();
      }
      await Glasses.unregisterDevice();
      setFrameData(null);
      setFrameCount(0);
      setFps(0);
    } catch (e: any) {
      setError(e.message || "Failed to disconnect");
    }
  }, [streamState, arMode]);

  const handleStartStream = useCallback(async () => {
    setError(null);
    setFrameCount(0);
    frameCountRef.current = 0;
    lastFrameTimeRef.current = Date.now();
    try {
      await Glasses.startVideoStream({ quality, frameRate: 15 });
    } catch (e: any) {
      setError(e.message || "Failed to start stream");
    }
  }, [quality]);

  const handleStopStream = useCallback(async () => {
    setError(null);
    try {
      // Clean up AR mode when stopping stream
      if (arMode) {
        setArMode(false);
        mediapipeReady.current = false;
        setHands([]);
        setCurrentGesture(null);
        await MediaPipe.dispose();
      }
      await Glasses.stopVideoStream();
      setFrameData(null);
      setFps(0);
    } catch (e: any) {
      setError(e.message || "Failed to stop stream");
    }
  }, [arMode]);

  const handleCapture = useCallback(async () => {
    setError(null);
    try {
      await Glasses.capturePhoto();
    } catch (e: any) {
      setError(e.message || "Failed to capture photo");
    }
  }, []);

  const handleToggleAR = useCallback(async () => {
    if (!arMode) {
      // Turn ON
      try {
        const ok = await MediaPipe.initialize();
        if (ok) {
          mediapipeReady.current = true;
          setArMode(true);
        } else {
          setError("MediaPipe not available on this device");
        }
      } catch (e: any) {
        setError(e.message || "Failed to initialize MediaPipe");
      }
    } else {
      // Turn OFF
      setArMode(false);
      mediapipeReady.current = false;
      setHands([]);
      setCurrentGesture(null);
      await MediaPipe.dispose();
    }
  }, [arMode]);

  const onPreviewLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setFrameSize({ width, height });
  }, []);

  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting";
  const isStreaming = streamState === "started";

  // Unavailable — native module not in binary or device unsupported
  if (available === false) {
    const needsRebuild = !Glasses.nativeAvailable;
    return (
      <View style={{ flex: 1, backgroundColor: "#111111", justifyContent: "center", alignItems: "center" }}>
        <Text style={{ color: "#525252", fontSize: 14, fontFamily: "monospace", textAlign: "center" }}>
          {needsRebuild
            ? "GLASSES MODULE NOT INSTALLED\nA native rebuild is required"
            : "GLASSES NOT AVAILABLE\non this device"}
        </Text>
        <TVPressable
          onPress={() => router.back()}
          style={{ marginTop: 24, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: "#333" }}
        >
          <Text style={{ color: "#A3A3A3", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>
            {"◀ BACK"}
          </Text>
        </TVPressable>
        <StatusBar style="light" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#111111" }}>
      {/* Top Bar */}
      <View
        style={{
          paddingTop: insets.top,
          height: TOP_BAR_HEIGHT + insets.top,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: Math.max(16, insets.left, insets.right),
        }}
      >
        <Text style={{ color: "#F59E0B", fontSize: 24, fontWeight: "bold" }}>
          ozzu
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          <TVPressable
            onPress={() => router.back()}
            style={{ paddingHorizontal: 12, paddingVertical: 4, borderRadius: 6 }}
          >
            <Text style={{ color: "#A3A3A3", fontSize: 12, fontWeight: "bold", letterSpacing: 1 }}>
              {"◀ BACK"}
            </Text>
          </TVPressable>
          <StatusBadge />
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          padding: Math.max(24, insets.left, insets.right),
          paddingBottom: Math.max(24, insets.bottom),
          gap: 16,
        }}
      >
        {/* Title + Connection Status */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text
            style={{
              color: "#06B6D4",
              fontSize: 16,
              fontFamily: "monospace",
              fontWeight: "bold",
              letterSpacing: 4,
            }}
          >
            GLASSES
          </Text>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: 10,
              paddingVertical: 4,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: isConnected ? "#059669" : isConnecting ? "#D97706" : "#333",
              backgroundColor: isConnected
                ? "rgba(5,150,105,0.15)"
                : isConnecting
                ? "rgba(217,119,6,0.15)"
                : "rgba(51,51,51,0.15)",
            }}
          >
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: isConnected ? "#10B981" : isConnecting ? "#F59E0B" : "#525252",
              }}
            />
            <Text
              style={{
                color: isConnected ? "#10B981" : isConnecting ? "#F59E0B" : "#525252",
                fontSize: 10,
                fontFamily: "monospace",
                fontWeight: "bold",
                letterSpacing: 1,
                textTransform: "uppercase",
              }}
            >
              {connectionState}
            </Text>
          </View>
        </View>

        {initializing && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <ActivityIndicator size="small" color="#06B6D4" />
            <Text style={{ color: "#737373", fontSize: 12, fontFamily: "monospace" }}>
              Initializing...
            </Text>
          </View>
        )}

        {/* Error */}
        {error && (
          <View style={{ backgroundColor: "rgba(239,68,68,0.1)", borderWidth: 1, borderColor: "#7F1D1D", borderRadius: 8, padding: 10, gap: 6 }}>
            <Text style={{ color: "#EF4444", fontSize: 11, fontFamily: "monospace" }}>
              {error}
            </Text>
            {!diagnostics && (
              <TVPressable
                onPress={() => {
                  try { setDiagnostics(Glasses.getDiagnostics()); } catch {}
                }}
                style={{ paddingVertical: 4, paddingHorizontal: 8, borderRadius: 4, borderWidth: 1, borderColor: "#7F1D1D", alignSelf: "flex-start" }}
              >
                <Text style={{ color: "#EF4444", fontSize: 9, fontFamily: "monospace", letterSpacing: 1 }}>
                  SHOW DIAGNOSTICS
                </Text>
              </TVPressable>
            )}
          </View>
        )}

        {/* Diagnostics panel */}
        {diagnostics && (
          <View style={{ backgroundColor: "rgba(6,182,212,0.05)", borderWidth: 1, borderColor: "#164E63", borderRadius: 8, padding: 10, gap: 4 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ color: "#06B6D4", fontSize: 10, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 1 }}>
                DIAGNOSTICS
              </Text>
              <TVPressable onPress={() => setDiagnostics(null)} style={{ padding: 4 }}>
                <Text style={{ color: "#525252", fontSize: 9, fontFamily: "monospace" }}>CLOSE</Text>
              </TVPressable>
            </View>
            {Object.entries(diagnostics).map(([key, val]) => (
              <Text key={key} style={{ color: "#737373", fontSize: 9, fontFamily: "monospace" }}>
                {key}: {typeof val === "object" ? JSON.stringify(val) : String(val)}
              </Text>
            ))}
          </View>
        )}

        {/* Disconnected state */}
        {!isConnected && !isConnecting && !initializing && (
          <View style={{ gap: 12, alignItems: "center", paddingVertical: 20 }}>
            <View
              style={{
                width: 80,
                height: 80,
                borderRadius: 40,
                borderWidth: 2,
                borderColor: "#333",
                justifyContent: "center",
                alignItems: "center",
                backgroundColor: "#1A1A1A",
              }}
            >
              <Text style={{ fontSize: 36 }}>{"👓"}</Text>
            </View>
            <Text style={{ color: "#525252", fontSize: 12, fontFamily: "monospace", textAlign: "center" }}>
              {"Connect your Meta Ray-Ban glasses\nvia the Meta AI companion app"}
            </Text>
            <TVPressable
              onPress={handleConnect}
              rarity="rare"
              style={{
                paddingHorizontal: 32,
                paddingVertical: 14,
                borderRadius: 8,
                alignItems: "center",
              }}
            >
              <Text style={{ color: "#FFF", fontSize: 13, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 2 }}>
                CONNECT GLASSES
              </Text>
            </TVPressable>
          </View>
        )}

        {/* Connecting state */}
        {isConnecting && (
          <View style={{ alignItems: "center", paddingVertical: 20, gap: 12 }}>
            <ActivityIndicator size="large" color="#F59E0B" />
            <Text style={{ color: "#F59E0B", fontSize: 12, fontFamily: "monospace", letterSpacing: 2 }}>
              CONNECTING...
            </Text>
            <Text style={{ color: "#525252", fontSize: 11, fontFamily: "monospace", textAlign: "center" }}>
              Follow the prompts in the Meta AI app
            </Text>
          </View>
        )}

        {/* Connected state */}
        {isConnected && (
          <View style={{ gap: 16 }}>
            {/* Video Preview Area */}
            <View
              onLayout={onPreviewLayout}
              style={{
                aspectRatio: 16 / 9,
                maxHeight: isPhone ? 200 : 320,
                backgroundColor: "#0A0A0A",
                borderRadius: 12,
                borderWidth: 1,
                borderColor: arMode
                  ? "#00FF88"
                  : isStreaming
                  ? "#06B6D4"
                  : "#222",
                overflow: "hidden",
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              {isStreaming && frameData ? (
                <Image
                  source={{ uri: `data:image/jpeg;base64,${frameData}` }}
                  style={{ width: "100%", height: "100%" }}
                  resizeMode="contain"
                />
              ) : (
                <Text
                  style={{
                    color: "#333",
                    fontSize: 13,
                    fontFamily: "monospace",
                  }}
                >
                  {isStreaming ? "Waiting for frames..." : "Camera off"}
                </Text>
              )}

              {/* AR Hand Overlay */}
              {arMode && hands.length > 0 && frameSize.width > 0 && (
                <View style={StyleSheet.absoluteFill}>
                  <HandOverlay
                    hands={hands}
                    width={frameSize.width}
                    height={frameSize.height}
                    activeFingers={currentGesture?.activeFingers}
                  />
                </View>
              )}

              {/* Gesture label pill */}
              {arMode &&
                currentGesture &&
                currentGesture.gesture !== "none" && (
                  <View
                    style={{
                      position: "absolute",
                      top: 8,
                      alignSelf: "center",
                      backgroundColor: "rgba(0,0,0,0.7)",
                      paddingHorizontal: 12,
                      paddingVertical: 4,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: "#00FF88",
                    }}
                  >
                    <Text
                      style={{
                        color: "#00FF88",
                        fontSize: 11,
                        fontFamily: "monospace",
                        fontWeight: "bold",
                        letterSpacing: 2,
                      }}
                    >
                      {gestureEmoji(currentGesture.gesture)}{" "}
                      {currentGesture.gesture.toUpperCase()}
                    </Text>
                  </View>
                )}

              {/* HUD overlay */}
              {isStreaming && (
                <>
                  {/* Top-left: stream indicator */}
                  <View
                    style={{
                      position: "absolute",
                      top: 8,
                      left: 10,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: "#EF4444",
                      }}
                    />
                    <Text
                      style={{
                        color: "#EF4444",
                        fontSize: 9,
                        fontFamily: "monospace",
                        fontWeight: "bold",
                      }}
                    >
                      LIVE
                    </Text>
                  </View>
                  {/* Top-right: FPS counter + AR badge */}
                  <View
                    style={{
                      position: "absolute",
                      top: 8,
                      right: 10,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {arMode && (
                      <Text
                        style={{
                          color: "#00FF88",
                          fontSize: 9,
                          fontFamily: "monospace",
                          fontWeight: "bold",
                        }}
                      >
                        AR
                      </Text>
                    )}
                    <Text
                      style={{
                        color: "#06B6D4",
                        fontSize: 9,
                        fontFamily: "monospace",
                      }}
                    >
                      {fps} FPS
                    </Text>
                  </View>
                  {/* Corner brackets */}
                  <View
                    style={{
                      position: "absolute",
                      top: 4,
                      left: 4,
                      width: 16,
                      height: 16,
                      borderTopWidth: 1,
                      borderLeftWidth: 1,
                      borderColor: arMode ? "#00FF88" : "#06B6D4",
                    }}
                  />
                  <View
                    style={{
                      position: "absolute",
                      top: 4,
                      right: 4,
                      width: 16,
                      height: 16,
                      borderTopWidth: 1,
                      borderRightWidth: 1,
                      borderColor: arMode ? "#00FF88" : "#06B6D4",
                    }}
                  />
                  <View
                    style={{
                      position: "absolute",
                      bottom: 4,
                      left: 4,
                      width: 16,
                      height: 16,
                      borderBottomWidth: 1,
                      borderLeftWidth: 1,
                      borderColor: arMode ? "#00FF88" : "#06B6D4",
                    }}
                  />
                  <View
                    style={{
                      position: "absolute",
                      bottom: 4,
                      right: 4,
                      width: 16,
                      height: 16,
                      borderBottomWidth: 1,
                      borderRightWidth: 1,
                      borderColor: arMode ? "#00FF88" : "#06B6D4",
                    }}
                  />
                </>
              )}
            </View>

            {/* Quality Selector */}
            <View style={{ flexDirection: "row", gap: 8, justifyContent: "center" }}>
              {(["low", "medium", "high"] as Quality[]).map((q) => (
                <TVPressable
                  key={q}
                  onPress={() => setQuality(q)}
                  style={{
                    paddingHorizontal: 16,
                    paddingVertical: 6,
                    borderRadius: 6,
                    backgroundColor: quality === q ? "#06B6D4" : "#1A1A1A",
                    borderWidth: 1,
                    borderColor: quality === q ? "#06B6D4" : "#333",
                  }}
                >
                  <Text
                    style={{
                      color: quality === q ? "#000" : "#737373",
                      fontSize: 11,
                      fontFamily: "monospace",
                      fontWeight: "bold",
                      letterSpacing: 1,
                    }}
                  >
                    {QUALITY_LABELS[q]}
                  </Text>
                </TVPressable>
              ))}
            </View>

            {/* Stream Controls */}
            <View style={{ flexDirection: "row", gap: 10 }}>
              {!isStreaming ? (
                <TVPressable
                  onPress={handleStartStream}
                  rarity="rare"
                  style={{
                    flex: 1,
                    paddingVertical: 14,
                    borderRadius: 8,
                    alignItems: "center",
                  }}
                >
                  <Text
                    style={{
                      color: "#FFF",
                      fontSize: 12,
                      fontFamily: "monospace",
                      fontWeight: "bold",
                      letterSpacing: 2,
                    }}
                  >
                    START CAMERA
                  </Text>
                </TVPressable>
              ) : (
                <>
                  {/* AR Toggle */}
                  {MediaPipe.isAvailable() && (
                    <TVPressable
                      onPress={handleToggleAR}
                      style={{
                        paddingHorizontal: 14,
                        paddingVertical: 14,
                        borderRadius: 8,
                        backgroundColor: arMode
                          ? "rgba(0,255,136,0.15)"
                          : "#1A1A1A",
                        borderWidth: 1,
                        borderColor: arMode ? "#00FF88" : "#333",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Text
                        style={{
                          color: arMode ? "#00FF88" : "#737373",
                          fontSize: 11,
                          fontFamily: "monospace",
                          fontWeight: "bold",
                          letterSpacing: 1,
                        }}
                      >
                        {arMode ? "AR: ON" : "AR: OFF"}
                      </Text>
                    </TVPressable>
                  )}
                  <TVPressable
                    onPress={handleCapture}
                    rarity="epic"
                    style={{
                      flex: 1,
                      paddingVertical: 14,
                      borderRadius: 8,
                      alignItems: "center",
                    }}
                  >
                    <Text
                      style={{
                        color: "#FFF",
                        fontSize: 12,
                        fontFamily: "monospace",
                        fontWeight: "bold",
                        letterSpacing: 2,
                      }}
                    >
                      CAPTURE
                    </Text>
                  </TVPressable>
                  <TVPressable
                    onPress={handleStopStream}
                    style={{
                      flex: 1,
                      paddingVertical: 14,
                      borderRadius: 8,
                      backgroundColor: "#1A1A1A",
                      borderWidth: 1,
                      borderColor: "#333",
                      alignItems: "center",
                    }}
                  >
                    <Text
                      style={{
                        color: "#A3A3A3",
                        fontSize: 12,
                        fontFamily: "monospace",
                        fontWeight: "bold",
                        letterSpacing: 2,
                      }}
                    >
                      STOP CAMERA
                    </Text>
                  </TVPressable>
                </>
              )}
            </View>

            {/* Captured Photo Preview */}
            {capturedPhoto && (
              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={{ color: "#737373", fontSize: 11, fontFamily: "monospace", letterSpacing: 1 }}>
                    LAST CAPTURE
                  </Text>
                  <TVPressable onPress={() => setCapturedPhoto(null)} style={{ padding: 4 }}>
                    <Text style={{ color: "#525252", fontSize: 11, fontFamily: "monospace" }}>
                      DISMISS
                    </Text>
                  </TVPressable>
                </View>
                <View
                  style={{
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: "#A855F7",
                    overflow: "hidden",
                  }}
                >
                  <Image
                    source={{ uri: `data:image/jpeg;base64,${capturedPhoto}` }}
                    style={{ width: "100%", height: isPhone ? 140 : 200 }}
                    resizeMode="contain"
                  />
                </View>
              </View>
            )}

            {/* Disconnect Button */}
            <TVPressable
              onPress={handleDisconnect}
              style={{
                paddingVertical: 10,
                borderRadius: 8,
                backgroundColor: "rgba(239,68,68,0.1)",
                borderWidth: 1,
                borderColor: "#7F1D1D",
                alignItems: "center",
              }}
            >
              <Text style={{ color: "#EF4444", fontSize: 11, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 2 }}>
                DISCONNECT
              </Text>
            </TVPressable>
          </View>
        )}
      </ScrollView>

      <StatusBar style="light" />
    </View>
  );
}
