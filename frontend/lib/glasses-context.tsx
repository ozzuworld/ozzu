// GlassesProvider — background glasses engine
// Runs connection, streaming, and gesture detection without taking over the screen.
// Photo capture overlay renders globally on top of whatever screen is active.

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";
import { AppState } from "react-native";
import * as Glasses from "../modules/expo-glasses";
import * as MediaPipe from "../modules/expo-mediapipe";
import { detectGesture, resetSwipeTracking, type GestureResult } from "./gestures";
import { GestureCommandManager, type GestureCommand } from "./gesture-commands";
import { BridgeSession, type BridgeCallbacks } from "./bridge-session";
import PhotoCaptureOverlay, { type CapturedPhoto } from "../components/glasses/PhotoCaptureOverlay";

type ConnectionState = Glasses.ConnectionState;

interface GlassesContextValue {
  connectionState: ConnectionState;
  streamState: string;
  isConnected: boolean;
  isStreaming: boolean;
  fps: number;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  capturePhoto: () => Promise<void>;
}

const GlassesContext = createContext<GlassesContextValue>({
  connectionState: "disconnected",
  streamState: "stopped",
  isConnected: false,
  isStreaming: false,
  fps: 0,
  error: null,
  connect: async () => {},
  disconnect: async () => {},
  capturePhoto: async () => {},
});

export function useGlasses() {
  return useContext(GlassesContext);
}

export function GlassesProvider({ children }: { children: React.ReactNode }) {
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [streamState, setStreamState] = useState("stopped");
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [capturedPhoto, setCapturedPhoto] = useState<CapturedPhoto | null>(null);

  const bridgeRef = useRef(new BridgeSession());
  const connectedRef = useRef(false);
  const gestureManager = useRef(new GestureCommandManager());
  const mediapipeReady = useRef(false);
  const processingFrame = useRef(false);
  const frameCountRef = useRef(0);
  const lastFrameTimeRef = useRef(0);
  const frameUpdatePending = useRef(false);
  const connectionStateRef = useRef<ConnectionState>("disconnected");
  const streamingRef = useRef(false);

  const isConnected = connectionState === "connected";
  const isStreaming = streamState === "started" || streamState === "streaming";

  // Keep refs in sync
  useEffect(() => { connectionStateRef.current = connectionState; }, [connectionState]);
  useEffect(() => { streamingRef.current = isStreaming; }, [isStreaming]);

  // Bridge connection (for sending photos + gesture commands)
  useEffect(() => {
    const noop = () => {};
    const callbacks: BridgeCallbacks = {
      onReady: () => { connectedRef.current = true; },
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
      onVisionResult: noop,
      onGestureControlFeedback: noop,
      onGlassesImmersiveRequest: noop,
      onError: (msg) => setError(msg),
    };
    bridgeRef.current.connect(callbacks);
    return () => bridgeRef.current.close();
  }, []);

  // Gesture command handler — palm = capture photo
  useEffect(() => {
    gestureManager.current.setCallback((command: GestureCommand) => {
      if (command.gesture === "open_palm") {
        handleCapture();
      }
      // Forward other gestures to bridge
      if (connectedRef.current && command.gesture !== "open_palm") {
        bridgeRef.current.sendGestureCommand({
          gesture: command.compound || command.gesture,
          action: command.gesture,
          fingerCount: command.fingerCount,
          timestamp: command.timestamp,
        });
      }
    });
    gestureManager.current.setEnabled(true);
  }, []);

  // Native event listeners
  useEffect(() => {
    const subs = [
      Glasses.onConnectionChanged((event) => {
        setConnectionState(event.state);
        if (event.error) setError(event.error);
        if (connectedRef.current) {
          bridgeRef.current.sendGlassesStatus(event.state);
        }
        // Auto-start streaming on connect
        if (event.state === "connected") {
          startStream();
        }
      }),
      Glasses.onVideoFrame((event) => {
        // No frame display — just process for gestures
        frameCountRef.current++;

        // FPS counter
        const now = Date.now();
        if (now - lastFrameTimeRef.current >= 1000) {
          setFps(frameCountRef.current);
          frameCountRef.current = 0;
          lastFrameTimeRef.current = now;
        }

        // Hand detection for gesture commands (skip if already processing)
        if (mediapipeReady.current && !processingFrame.current) {
          processingFrame.current = true;
          MediaPipe.detectHands(event.data)
            .then((results) => {
              if (results.length > 0) {
                const gesture = detectGesture(results[0].landmarks);
                gestureManager.current.update(gesture);
              } else {
                gestureManager.current.update({ gesture: "none", confidence: 0, activeFingers: [] });
              }
            })
            .catch(() => {})
            .finally(() => {
              processingFrame.current = false;
            });
        }
      }),
      Glasses.onPhotoCaptured((event) => {
        const photo: CapturedPhoto = { data: event.data, timestamp: Date.now() };
        setCapturedPhoto(photo);
        Glasses.speakFeedback("Photo captured");
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

  const startStream = useCallback(async () => {
    try {
      await Glasses.startVideoStream({ quality: "medium", frameRate: 15 });
    } catch (e: any) {
      setError(`Stream: ${e.message || "Failed to start stream"}`);
      return;
    }
    // Initialize hand detection for gesture commands (non-blocking)
    try {
      if (MediaPipe.isAvailable() && !mediapipeReady.current) {
        const ok = await MediaPipe.initialize();
        if (ok) mediapipeReady.current = true;
      }
    } catch (e: any) {
      // MediaPipe init failure is non-fatal — gestures won't work but photos still will
      console.warn("MediaPipe init failed:", e.message);
    }
  }, []);

  const handleConnect = useCallback(async () => {
    setError(null);
    try {
      await Glasses.registerDevice();
    } catch (e: any) {
      setError(e.message || "Failed to connect");
    }
  }, []);

  const handleDisconnect = useCallback(async () => {
    try {
      if (mediapipeReady.current) {
        mediapipeReady.current = false;
        await MediaPipe.dispose();
      }
      await Glasses.stopVideoStream();
      await Glasses.unregisterDevice();
      setFps(0);
      resetSwipeTracking();
      gestureManager.current.reset();
    } catch (e: any) {
      setError(e.message || "Failed to disconnect");
    }
  }, []);

  const handleCapture = useCallback(async () => {
    try {
      await Glasses.capturePhoto();
    } catch (e: any) {
      setError(e.message || "Failed to capture photo");
    }
  }, []);

  // Auto-reconnect stream when app returns to foreground
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && connectionStateRef.current === "connected" && !streamingRef.current) {
        startStream();
      }
    });
    return () => sub.remove();
  }, [startStream]);

  const value: GlassesContextValue = {
    connectionState,
    streamState,
    isConnected,
    isStreaming,
    fps,
    error,
    connect: handleConnect,
    disconnect: handleDisconnect,
    capturePhoto: handleCapture,
  };

  return (
    <GlassesContext.Provider value={value}>
      {children}
      {/* Global photo capture overlay — renders on top of everything */}
      <PhotoCaptureOverlay
        photo={capturedPhoto}
        onDismiss={() => setCapturedPhoto(null)}
      />
    </GlassesContext.Provider>
  );
}
