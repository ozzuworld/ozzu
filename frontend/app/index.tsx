import { useState, useCallback, useRef, useEffect } from "react";
import { View, PermissionsAndroid, Platform } from "react-native";
import { StatusBar } from "expo-status-bar";
import { StatusBadge } from "../components/StatusBadge";
import { HamburgerMenu } from "../components/HamburgerMenu";
import { SciFiOrb } from "../components/SciFiOrb";
import { TranscriptBubble } from "../components/TranscriptBubble";
import { BridgeSession, type BridgeCallbacks } from "../lib/bridge-session";
import { StreamingPlayer, MicRecorder } from "../lib/audio";
import { getDeviceType } from "../modules/pcm-player";
import { Keypad } from "../components/Keypad";
import { CameraOverlay } from "../components/CameraOverlay";
import { useKeepAwake } from "expo-keep-awake";

export default function LandingScreen() {
  useKeepAwake();

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

  const [responseText, setResponseText] = useState("");
  const [inputTranscript, setInputTranscript] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);

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
      onError: (msg) => {
        console.error("BridgeSession error:", msg);
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

  return (
    <View style={{ flex: 1, backgroundColor: "#000000" }}>
      {/* Top Bar — hamburger left, status right */}
      <View
        style={{
          height: 48,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 20,
        }}
      >
        <HamburgerMenu />
        <StatusBadge />
      </View>

      {/* Center — SciFiOrb only */}
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <SciFiOrb
          active={isStreaming}
          ambient={isListening && !isStreaming}
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
