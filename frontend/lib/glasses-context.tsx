// GlassesProvider — background glasses engine
// Runs connection, streaming, gesture detection, and device control.
// Photo capture overlay renders globally on top of whatever screen is active.
// Gesture → Home Control: thumbs_up=ON, grab=OFF, pinch=toggle, swipe=analog

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";
import { AppState } from "react-native";
import * as Glasses from "../modules/expo-glasses";
import * as MediaPipe from "../modules/expo-mediapipe";
import { detectGesture, resetSwipeTracking, type GestureResult } from "./gestures";
import { GestureCommandManager, type GestureCommand } from "./gesture-commands";
import { BridgeSession, type BridgeCallbacks } from "./bridge-session";
import PhotoCaptureOverlay, { type CapturedPhoto } from "../components/glasses/PhotoCaptureOverlay";
import { useHA } from "./ha-context";
import { findDeviceForObject, type DeviceTarget } from "./device-map";

type ConnectionState = Glasses.ConnectionState;

// Focused device — set by any screen to indicate what device gestures should target
export interface FocusedDevice {
  entityId: string;
  domain: string; // "switch", "climate", "vacuum", "media_player", etc.
  name: string; // human-readable for audio feedback
}

interface GlassesContextValue {
  connectionState: ConnectionState;
  streamState: string;
  isConnected: boolean;
  isStreaming: boolean;
  fps: number;
  error: string | null;
  focusedDevice: FocusedDevice | null;
  lastGestureAction: string | null; // e.g. "AC → ON" for UI feedback
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  capturePhoto: () => Promise<void>;
  setFocusedDevice: (device: FocusedDevice | null) => void;
}

const GlassesContext = createContext<GlassesContextValue>({
  connectionState: "disconnected",
  streamState: "stopped",
  isConnected: false,
  isStreaming: false,
  fps: 0,
  error: null,
  focusedDevice: null,
  lastGestureAction: null,
  connect: async () => {},
  disconnect: async () => {},
  capturePhoto: async () => {},
  setFocusedDevice: () => {},
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
  const [focusedDevice, setFocusedDevice] = useState<FocusedDevice | null>(null);
  const [lastGestureAction, setLastGestureAction] = useState<string | null>(null);

  const { callService, entities } = useHA();
  const callServiceRef = useRef(callService);
  const entitiesRef = useRef(entities);
  const focusedDeviceRef = useRef<FocusedDevice | null>(null);

  // Keep refs in sync to avoid stale closures in gesture callback
  useEffect(() => { callServiceRef.current = callService; }, [callService]);
  useEffect(() => { entitiesRef.current = entities; }, [entities]);
  useEffect(() => { focusedDeviceRef.current = focusedDevice; }, [focusedDevice]);

  const bridgeRef = useRef(new BridgeSession());
  const connectedRef = useRef(false);
  const gestureManager = useRef(new GestureCommandManager());
  const mediapipeReady = useRef(false);
  const objectDetectionReady = useRef(false);
  const processingFrame = useRef(false);
  const processingObjects = useRef(false);
  const frameCountRef = useRef(0);
  const lastFrameTimeRef = useRef(0);
  const lastObjectDetectTime = useRef(0);
  const connectionStateRef = useRef<ConnectionState>("disconnected");
  const streamingRef = useRef(false);
  // What the camera currently sees — updated by object detection
  const visibleDeviceRef = useRef<DeviceTarget | null>(null);
  const visibleDeviceLabelRef = useRef<string | null>(null);
  // Auto-dismiss focus after inactivity
  const focusDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isConnected = connectionState === "connected";
  const isStreaming = streamState === "started" || streamState === "streaming";

  // Keep refs in sync
  useEffect(() => { connectionStateRef.current = connectionState; }, [connectionState]);
  useEffect(() => { streamingRef.current = isStreaming; }, [isStreaming]);

  // Clear gesture action feedback after 2s
  useEffect(() => {
    if (!lastGestureAction) return;
    const t = setTimeout(() => setLastGestureAction(null), 2000);
    return () => clearTimeout(t);
  }, [lastGestureAction]);

  // ── Execute gesture on focused device ──
  const executeGestureAction = useCallback((command: GestureCommand) => {
    const device = focusedDeviceRef.current;
    if (!device) return;

    const e = entitiesRef.current[device.entityId];
    if (!e) return;

    const isOn = e.state === "on" || e.state === "playing" || e.state === "cleaning"
      || e.state === "cool" || e.state === "heat" || e.state === "auto";

    let action: string | null = null;
    let feedbackText = "";

    switch (command.gesture) {
      case "thumbs_up": {
        // Turn ON
        if (isOn) {
          feedbackText = `${device.name} already on`;
        } else {
          if (device.domain === "climate") {
            callServiceRef.current("climate", "turn_on", {}, { entity_id: device.entityId });
          } else if (device.domain === "vacuum") {
            callServiceRef.current("vacuum", "start", {}, { entity_id: device.entityId });
          } else if (device.domain === "media_player") {
            callServiceRef.current("media_player", "turn_on", {}, { entity_id: device.entityId });
          } else {
            callServiceRef.current("switch", "turn_on", {}, { entity_id: device.entityId });
          }
          action = `${device.name} ON`;
          feedbackText = `${device.name} on`;
        }
        break;
      }
      case "grab": {
        // Turn OFF (fist)
        if (!isOn) {
          feedbackText = `${device.name} already off`;
        } else {
          if (device.domain === "climate") {
            callServiceRef.current("climate", "turn_off", {}, { entity_id: device.entityId });
          } else if (device.domain === "vacuum") {
            callServiceRef.current("vacuum", "return_to_base", {}, { entity_id: device.entityId });
          } else if (device.domain === "media_player") {
            callServiceRef.current("media_player", "turn_off", {}, { entity_id: device.entityId });
          } else {
            callServiceRef.current("switch", "turn_off", {}, { entity_id: device.entityId });
          }
          action = `${device.name} OFF`;
          feedbackText = `${device.name} off`;
        }
        break;
      }
      case "pinch": {
        // Media player: play/pause. Others: toggle on/off.
        if (device.domain === "media_player") {
          callServiceRef.current("media_player", "media_play_pause", {}, { entity_id: device.entityId });
          action = `${device.name} ${isOn ? "Pause" : "Play"}`;
          feedbackText = isOn ? "Pause" : "Play";
        } else if (device.domain === "climate") {
          callServiceRef.current("climate", isOn ? "turn_off" : "turn_on", {}, { entity_id: device.entityId });
          action = `${device.name} ${isOn ? "OFF" : "ON"}`;
          feedbackText = `${device.name} ${isOn ? "off" : "on"}`;
        } else if (device.domain === "vacuum") {
          callServiceRef.current("vacuum", isOn ? "return_to_base" : "start", {}, { entity_id: device.entityId });
          action = `${device.name} ${isOn ? "Dock" : "Clean"}`;
          feedbackText = isOn ? "Docking" : "Cleaning";
        } else {
          callServiceRef.current("switch", "toggle", {}, { entity_id: device.entityId });
          action = `${device.name} ${isOn ? "OFF" : "ON"}`;
          feedbackText = `${device.name} ${isOn ? "off" : "on"}`;
        }
        break;
      }
      case "peace": {
        // AC specific: toggle cool/heat mode
        if (device.domain === "climate" && isOn) {
          const currentMode = e.attributes?.hvac_action || e.state;
          const newMode = currentMode === "cooling" ? "heat" : "cool";
          callServiceRef.current("climate", "set_hvac_mode", { hvac_mode: newMode }, { entity_id: device.entityId });
          action = `${device.name} → ${newMode}`;
          feedbackText = `${device.name} ${newMode} mode`;
        }
        break;
      }
      case "swipe_right": {
        // Media player: next track. Climate: temp up.
        if (device.domain === "media_player") {
          callServiceRef.current("media_player", "media_next_track", {}, { entity_id: device.entityId });
          action = `${device.name} Next`;
          feedbackText = "Next";
        } else if (device.domain === "climate") {
          const currentTemp = e.attributes?.temperature || 24;
          callServiceRef.current("climate", "set_temperature", { temperature: currentTemp + 1 }, { entity_id: device.entityId });
          action = `${device.name} → ${currentTemp + 1}°`;
          feedbackText = `${currentTemp + 1} degrees`;
        }
        break;
      }
      case "swipe_left": {
        // Media player: prev track. Climate: temp down.
        if (device.domain === "media_player") {
          callServiceRef.current("media_player", "media_previous_track", {}, { entity_id: device.entityId });
          action = `${device.name} Previous`;
          feedbackText = "Previous";
        } else if (device.domain === "climate") {
          const currentTemp = e.attributes?.temperature || 24;
          callServiceRef.current("climate", "set_temperature", { temperature: currentTemp - 1 }, { entity_id: device.entityId });
          action = `${device.name} → ${currentTemp - 1}°`;
          feedbackText = `${currentTemp - 1} degrees`;
        }
        break;
      }
    }

    if (action) {
      setLastGestureAction(action);
      // Audio feedback through glasses speaker
      try { Glasses.speakFeedback(feedbackText); } catch {}
    } else if (feedbackText) {
      try { Glasses.speakFeedback(feedbackText); } catch {}
    }
  }, []);

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

  // ── Lock visible device as focused (swipe_down trigger) ──
  const lockVisibleDevice = useCallback(() => {
    const target = visibleDeviceRef.current;
    const label = visibleDeviceLabelRef.current;
    if (!target) {
      try { Glasses.speakFeedback("No device detected"); } catch {}
      return;
    }

    // Set as focused device
    const device: FocusedDevice = {
      entityId: target.entityId,
      domain: target.domain as any,
      name: target.name,
    };
    setFocusedDevice(device);
    setLastGestureAction(`${target.name} targeted`);
    try { Glasses.speakFeedback(`${target.name}`); } catch {}

    // Auto-dismiss after 15 seconds of no gesture activity
    if (focusDismissTimer.current) clearTimeout(focusDismissTimer.current);
    focusDismissTimer.current = setTimeout(() => {
      setFocusedDevice(null);
      setLastGestureAction(null);
      try { Glasses.speakFeedback("Released"); } catch {}
    }, 15000);
  }, []);

  // ── Dismiss focused device (open_palm when focused) ──
  const dismissFocusedDevice = useCallback(() => {
    if (focusDismissTimer.current) clearTimeout(focusDismissTimer.current);
    setFocusedDevice(null);
    setLastGestureAction(null);
    try { Glasses.speakFeedback("Released"); } catch {}
  }, []);

  // Gesture command handler
  useEffect(() => {
    gestureManager.current.setCallback((command: GestureCommand) => {
      // Two-finger swipe down = target lock
      if (command.gesture === "swipe_down") {
        lockVisibleDevice();
        return;
      }

      // Open palm: if focused → dismiss, otherwise capture photo
      if (command.gesture === "open_palm") {
        if (focusedDeviceRef.current) {
          dismissFocusedDevice();
        } else {
          handleCapture();
        }
        return;
      }

      // Home device control gestures (when a device is focused)
      const controlGestures = new Set(["thumbs_up", "grab", "pinch", "peace", "swipe_left", "swipe_right"]);
      if (controlGestures.has(command.gesture) && focusedDeviceRef.current) {
        // Reset auto-dismiss timer on each gesture
        if (focusDismissTimer.current) clearTimeout(focusDismissTimer.current);
        focusDismissTimer.current = setTimeout(() => {
          setFocusedDevice(null);
          setLastGestureAction(null);
          try { Glasses.speakFeedback("Released"); } catch {}
        }, 15000);
        executeGestureAction(command);
        return;
      }

      // Forward other gestures to bridge
      if (connectedRef.current) {
        bridgeRef.current.sendGestureCommand({
          gesture: command.compound || command.gesture,
          action: command.gesture,
          fingerCount: command.fingerCount,
          timestamp: command.timestamp,
        });
      }
    });
    gestureManager.current.setEnabled(true);
  }, [executeGestureAction, lockVisibleDevice, dismissFocusedDevice]);

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
        // No frame display — just process for gestures + object detection
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

        // Object detection — run every 500ms to track what camera sees
        if (objectDetectionReady.current && !processingObjects.current && now - lastObjectDetectTime.current >= 500) {
          processingObjects.current = true;
          lastObjectDetectTime.current = now;
          MediaPipe.detectObjects(event.data)
            .then((objects) => {
              if (objects.length > 0) {
                // Find the highest-confidence object that maps to a device
                let bestTarget: DeviceTarget | null = null;
                let bestLabel: string | null = null;
                let bestScore = 0;
                for (const obj of objects) {
                  if (obj.score < 0.4) continue; // skip low confidence
                  const target = findDeviceForObject(obj.label);
                  if (target && obj.score > bestScore) {
                    bestTarget = target;
                    bestLabel = obj.label;
                    bestScore = obj.score;
                  }
                }
                visibleDeviceRef.current = bestTarget;
                visibleDeviceLabelRef.current = bestLabel;
              } else {
                visibleDeviceRef.current = null;
                visibleDeviceLabelRef.current = null;
              }
            })
            .catch(() => {})
            .finally(() => {
              processingObjects.current = false;
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
    // Initialize object detection for spatial targeting (non-blocking)
    try {
      if (MediaPipe.isAvailable() && !objectDetectionReady.current) {
        const ok = await MediaPipe.initializeObjects();
        if (ok) objectDetectionReady.current = true;
      }
    } catch (e: any) {
      console.warn("Object detection init failed:", e.message);
    }
  }, []);

  const handleConnect = useCallback(async () => {
    setError(null);
    try {
      await Glasses.initialize();

      // Check if already registered from a previous session
      const diag = Glasses.getDiagnostics();
      const regState = diag?.registrationState || "";
      if (regState.toLowerCase().includes("registered") && !regState.toLowerCase().includes("un")) {
        // Stale registration — unregister first, then re-register
        try { await Glasses.unregisterDevice(); } catch {}
      }

      await Glasses.registerDevice();
    } catch (e: any) {
      const msg = e.message || "Failed to connect";
      // If "already registered", try unregister + re-register once
      if (msg.toLowerCase().includes("already registered")) {
        try {
          await Glasses.unregisterDevice();
          await Glasses.registerDevice();
          return; // success on retry
        } catch (retryErr: any) {
          setError(retryErr.message || "Failed to reconnect");
          return;
        }
      }
      setError(msg);
    }
  }, []);

  const handleDisconnect = useCallback(async () => {
    try {
      if (mediapipeReady.current) {
        mediapipeReady.current = false;
        await MediaPipe.dispose();
      }
      if (objectDetectionReady.current) {
        objectDetectionReady.current = false;
        await MediaPipe.disposeObjects();
      }
      if (focusDismissTimer.current) {
        clearTimeout(focusDismissTimer.current);
        focusDismissTimer.current = null;
      }
      await Glasses.stopVideoStream();
      await Glasses.unregisterDevice();
      setFps(0);
      setFocusedDevice(null);
      visibleDeviceRef.current = null;
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
    focusedDevice,
    lastGestureAction,
    connect: handleConnect,
    disconnect: handleDisconnect,
    capturePhoto: handleCapture,
    setFocusedDevice,
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
