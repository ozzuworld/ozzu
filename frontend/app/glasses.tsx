import { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  Image,
  ActivityIndicator,
  StyleSheet,
  LayoutChangeEvent,
  Linking,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { useKeepAwake } from "expo-keep-awake";
import { TVPressable } from "../components/TVPressable";
import { BridgeSession, type BridgeCallbacks } from "../lib/bridge-session";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import * as Glasses from "../modules/expo-glasses";
import * as MediaPipe from "../modules/expo-mediapipe";
import type { HandResult, FaceResult } from "../modules/expo-mediapipe";
import HandOverlay from "../components/glasses/HandOverlay";
import FaceOverlay from "../components/glasses/FaceOverlay";
import PoseOverlay from "../components/glasses/PoseOverlay";
import ExerciseHUD from "../components/glasses/ExerciseHUD";
import { detectExpression, type ExpressionResult } from "../lib/expressions";
import { ExerciseTracker, type ExerciseState } from "../lib/exercise-tracker";
import type { PoseResult, ObjectDetection } from "../modules/expo-mediapipe";
import ObjectOverlay from "../components/glasses/ObjectOverlay";
import { detectGesture, gestureEmoji, gestureLabel, resetSwipeTracking, type GestureResult } from "../lib/gestures";
import { GestureCommandManager, type GestureCommand } from "../lib/gesture-commands";
import { executeGestureCommand, sendTargetedGestureCommand, type GestureAction } from "../lib/gesture-actions";
import VisionOverlay, { type VisionMode, type VisionResult } from "../components/glasses/VisionOverlay";
import { GestureTargetEngine, type TargetLock } from "../lib/gesture-target";
import { loadCalibration } from "../lib/device-map";
import SettingsSheet from "../components/glasses/SettingsSheet";

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
  const [logs, setLogs] = useState<Array<{ ts: string; msg: string }> | null>(null);
  const [urlEvents, setUrlEvents] = useState<string[]>([]);

  // AR mode state
  const [arMode, setArMode] = useState(false);
  const [hands, setHands] = useState<HandResult[]>([]);
  const [currentGesture, setCurrentGesture] = useState<GestureResult | null>(
    null
  );
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const mediapipeReady = useRef(false);
  const processingFrame = useRef(false);

  // Face detection state
  const [faceMode, setFaceMode] = useState(false);
  const [faces, setFaces] = useState<FaceResult[]>([]);
  const [expressions, setExpressions] = useState<ExpressionResult[]>([]);
  const faceReady = useRef(false);
  const processingFace = useRef(false);
  const frameCounter = useRef(0); // for alternating hand/face frames

  // Pose detection state
  const [poseMode, setPoseMode] = useState(false);
  const [poses, setPoses] = useState<PoseResult[]>([]);
  const [exerciseState, setExerciseState] = useState<ExerciseState | null>(null);
  const poseReady = useRef(false);
  const processingPose = useRef(false);
  const exerciseTracker = useRef(new ExerciseTracker());

  // Object detection state
  const [objectMode, setObjectMode] = useState(false);
  const [detectedObjects, setDetectedObjects] = useState<ObjectDetection[]>([]);
  const objectReady = useRef(false);
  const processingObjects = useRef(false);
  const prevObjectLabels = useRef<string>("");

  // Gesture command system
  const [commandMode, setCommandMode] = useState(false);
  const [lastAction, setLastAction] = useState<GestureAction | null>(null);
  const lastActionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gestureManager = useRef(new GestureCommandManager());

  // Target mode — point at device + gesture to control
  const [targetMode, setTargetMode] = useState(false);
  const [lockedTarget, setLockedTarget] = useState<TargetLock | null>(null);
  const [candidateLabel, setCandidateLabel] = useState<string | null>(null);
  const [controlFeedback, setControlFeedback] = useState<string | null>(null);
  const controlFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const targetEngine = useRef(new GestureTargetEngine());
  const lastContinuousSend = useRef(0);

  // Vision mode state
  const [visionMode, setVisionMode] = useState<VisionMode>("describe");
  const [visionResult, setVisionResult] = useState<VisionResult | null>(null);
  const [visionLoading, setVisionLoading] = useState(false);
  const latestFrameRef = useRef<{ data: string; width: number; height: number } | null>(null);

  // Settings sheet
  const [settingsOpen, setSettingsOpen] = useState(false);

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
      onVisionResult: (mode: string, text: string) => {
        setVisionLoading(false);
        setVisionResult({
          mode: mode as VisionMode,
          text,
          timestamp: Date.now(),
        });
      },
      onGestureControlFeedback: (data) => {
        const fb = data.error
          ? `${data.deviceName}: ERROR`
          : `${data.deviceName}: ${data.action}${data.state ? ` ${data.state}` : ""}`;
        setControlFeedback(fb);
        if (controlFeedbackTimer.current) clearTimeout(controlFeedbackTimer.current);
        controlFeedbackTimer.current = setTimeout(() => setControlFeedback(null), 2000);
      },
      onError: (msg) => setError(msg),
    };
    bridgeRef.current.connect(callbacks);
    loadCalibration(); // load device map overrides from AsyncStorage
    return () => bridgeRef.current.close();
  }, []);

  // Gesture command handler
  useEffect(() => {
    gestureManager.current.setCallback((command: GestureCommand) => {
      // Targeted mode: send to specific HA entity
      const lock = targetEngine.current.getLockedTarget();
      if (targetMode && lock) {
        const gesture = command.compound || command.gesture;
        const action = sendTargetedGestureCommand(
          bridgeRef.current,
          gesture,
          lock.target
        );
        if (action) {
          setLastAction(action);
          if (lastActionTimer.current) clearTimeout(lastActionTimer.current);
          lastActionTimer.current = setTimeout(() => setLastAction(null), 1500);
        }
        return;
      }
      // Untargeted mode: generic gesture command
      const action = executeGestureCommand(bridgeRef.current, command);
      if (action) {
        setLastAction(action);
        if (lastActionTimer.current) clearTimeout(lastActionTimer.current);
        lastActionTimer.current = setTimeout(() => setLastAction(null), 1500);
      }
    });
    return () => {
      if (lastActionTimer.current) clearTimeout(lastActionTimer.current);
    };
  }, [targetMode]);

  // Sync command mode to gesture manager (target mode also enables gesture commands)
  useEffect(() => {
    gestureManager.current.setEnabled((commandMode || targetMode) && arMode);
  }, [commandMode, targetMode, arMode]);

  // Target mode auto-enables object detection
  useEffect(() => {
    if (targetMode && !objectMode && objectReady.current === false) {
      (async () => {
        try {
          const ok = await MediaPipe.initializeObjects();
          if (ok) {
            objectReady.current = true;
            setObjectMode(true);
          }
        } catch {}
      })();
    }
  }, [targetMode, objectMode]);

  // Reset target engine when target mode turns off
  useEffect(() => {
    if (!targetMode) {
      targetEngine.current.reset();
      setLockedTarget(null);
      setCandidateLabel(null);
    }
  }, [targetMode]);

  // Listen for ALL incoming URLs (catches Meta AI callback if it arrives via RN Linking)
  useEffect(() => {
    const handler = (event: { url: string }) => {
      console.log("[Glasses] RN Linking URL:", event.url);
      setUrlEvents((prev) => [...prev, `${new Date().toISOString().slice(11,19)} ${event.url}`]);
    };
    const sub = Linking.addEventListener("url", handler);
    // Also check if app was opened with a URL
    Linking.getInitialURL().then((url) => {
      if (url) {
        console.log("[Glasses] Initial URL:", url);
        setUrlEvents((prev) => [...prev, `INITIAL: ${url}`]);
      }
    });
    return () => sub.remove();
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
        latestFrameRef.current = { data: event.data, width: event.width, height: event.height };
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

        // Track frame number for alternating hand/face detection
        frameCounter.current++;

        // AR hand detection (skip if already processing to prevent pile-up)
        // When both hand+face active, alternate frames (even→hands, odd→faces)
        const shouldDetectHands = mediapipeReady.current && !processingFrame.current &&
          (!faceReady.current || frameCounter.current % 2 === 0);

        if (shouldDetectHands) {
          processingFrame.current = true;
          MediaPipe.detectHands(event.data)
            .then((results) => {
              setHands(results);
              if (results.length > 0) {
                const gesture = detectGesture(results[0].landmarks);
                setCurrentGesture(gesture);
                gestureManager.current.update(gesture);

                // Targeting engine: update with landmarks + latest detected objects
                if (targetMode) {
                  const lock = targetEngine.current.update(results[0].landmarks, detectedObjects);
                  setLockedTarget(lock);
                  const cand = targetEngine.current.getCandidate();
                  setCandidateLabel(cand ? cand.object.label : null);

                  // Continuous control: when grab gesture + locked target with continuous support
                  if (lock && lock.target.continuous && gesture.gesture === "grab") {
                    const now = Date.now();
                    if (now - lastContinuousSend.current >= 100) {
                      lastContinuousSend.current = now;
                      // Compute pinch distance (thumb tip to index tip) → map to device range
                      const thumbTip = results[0].landmarks[4];
                      const indexTip = results[0].landmarks[8];
                      const dx = thumbTip.x - indexTip.x;
                      const dy = thumbTip.y - indexTip.y;
                      const pinchDist = Math.sqrt(dx * dx + dy * dy);
                      // Map 0.02-0.2 distance to device min-max range
                      const normalized = Math.max(0, Math.min(1, (pinchDist - 0.02) / 0.18));
                      const min = lock.target.min ?? 0;
                      const max = lock.target.max ?? 1;
                      const value = min + normalized * (max - min);
                      sendTargetedGestureCommand(
                        bridgeRef.current,
                        "grab",
                        lock.target,
                        Math.round(value * 100) / 100
                      );
                    }
                  }
                }
              } else {
                setCurrentGesture(null);
                gestureManager.current.update({ gesture: "none", confidence: 0, activeFingers: [] });
                // Update targeting with no hand
                if (targetMode) {
                  const lock = targetEngine.current.update(null, detectedObjects);
                  setLockedTarget(lock);
                  setCandidateLabel(null);
                }
              }
            })
            .catch(() => {})
            .finally(() => {
              processingFrame.current = false;
            });
        }

        // Face detection (alternates with hand detection when both active)
        const shouldDetectFaces = faceReady.current && !processingFace.current &&
          (!mediapipeReady.current || frameCounter.current % 2 === 1);

        if (shouldDetectFaces) {
          processingFace.current = true;
          MediaPipe.detectFaces(event.data)
            .then((results) => {
              setFaces(results);
              setExpressions(results.map((f) => detectExpression(f.blendshapes)));
            })
            .catch(() => {})
            .finally(() => {
              processingFace.current = false;
            });
        }

        // Pose detection (runs every 3rd frame to save CPU)
        if (poseReady.current && !processingPose.current && frameCounter.current % 3 === 0) {
          processingPose.current = true;
          MediaPipe.detectPose(event.data)
            .then((results) => {
              setPoses(results);
              if (results.length > 0 && results[0].landmarks) {
                setExerciseState(exerciseTracker.current.update(results[0].landmarks));
              }
            })
            .catch(() => {})
            .finally(() => {
              processingPose.current = false;
            });
        }

        // Object detection (runs every 4th frame to save CPU)
        if (objectReady.current && !processingObjects.current && frameCounter.current % 4 === 1) {
          processingObjects.current = true;
          MediaPipe.detectObjects(event.data)
            .then((results) => {
              setDetectedObjects(results);
              // Send scene change events to bridge
              if (connectedRef.current && results.length > 0) {
                const labels = results.map((o) => o.label).sort().join(",");
                if (labels !== prevObjectLabels.current) {
                  prevObjectLabels.current = labels;
                  bridgeRef.current.sendSceneChange(
                    results.map((o) => ({ label: o.label, score: Math.round(o.score * 100) })),
                  );
                }
              }
            })
            .catch(() => {})
            .finally(() => {
              processingObjects.current = false;
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
      // If already registered (e.g. after crash), unregister first then retry
      if (e.message?.includes("already registered")) {
        try {
          await Glasses.unregisterDevice();
          await Glasses.registerDevice();
        } catch (retryErr: any) {
          setError(retryErr.message || "Failed to register after retry");
        }
      } else {
        setError(e.message || "Failed to register");
      }
    }
  }, []);

  const handleToggleFace = useCallback(async () => {
    if (!faceMode) {
      try {
        const ok = await MediaPipe.initializeFaces();
        if (ok) {
          faceReady.current = true;
          setFaceMode(true);
        } else {
          setError("Face detection not available on this device");
        }
      } catch (e: any) {
        setError(e.message || "Failed to initialize face detection");
      }
    } else {
      setFaceMode(false);
      faceReady.current = false;
      setFaces([]);
      setExpressions([]);
      await MediaPipe.disposeFaces();
    }
  }, [faceMode]);

  const handleTogglePose = useCallback(async () => {
    if (!poseMode) {
      try {
        const ok = await MediaPipe.initializePose();
        if (ok) {
          poseReady.current = true;
          exerciseTracker.current.reset();
          setPoseMode(true);
        } else {
          setError("Pose detection not available on this device");
        }
      } catch (e: any) {
        setError(e.message || "Failed to initialize pose detection");
      }
    } else {
      setPoseMode(false);
      poseReady.current = false;
      setPoses([]);
      setExerciseState(null);
      exerciseTracker.current.reset();
      await MediaPipe.disposePose();
    }
  }, [poseMode]);

  const handleToggleObjects = useCallback(async () => {
    if (!objectMode) {
      try {
        const ok = await MediaPipe.initializeObjects();
        if (ok) {
          objectReady.current = true;
          setObjectMode(true);
        } else {
          setError("Object detection not available on this device");
        }
      } catch (e: any) {
        setError(e.message || "Failed to initialize object detection");
      }
    } else {
      setObjectMode(false);
      objectReady.current = false;
      setDetectedObjects([]);
      await MediaPipe.disposeObjects();
    }
  }, [objectMode]);

  const handleDisconnect = useCallback(async () => {
    setError(null);
    try {
      // Clean up AR mode
      if (arMode) {
        setArMode(false);
        mediapipeReady.current = false;
        setHands([]);
        setCurrentGesture(null);
        setCommandMode(false);
        setTargetMode(false);
        targetEngine.current.reset();
        setLockedTarget(null);
        setCandidateLabel(null);
        gestureManager.current.reset();
        resetSwipeTracking();
        await MediaPipe.dispose();
      }
      // Clean up face mode
      if (faceMode) {
        setFaceMode(false);
        faceReady.current = false;
        setFaces([]);
        setExpressions([]);
        await MediaPipe.disposeFaces();
      }
      // Clean up pose mode
      if (poseMode) {
        setPoseMode(false);
        poseReady.current = false;
        setPoses([]);
        setExerciseState(null);
        exerciseTracker.current.reset();
        await MediaPipe.disposePose();
      }
      // Clean up object mode
      if (objectMode) {
        setObjectMode(false);
        objectReady.current = false;
        setDetectedObjects([]);
        await MediaPipe.disposeObjects();
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
  }, [streamState, arMode, faceMode, poseMode, objectMode]);

  const handleStartStream = useCallback(async () => {
    setError(null);
    setFrameCount(0);
    frameCountRef.current = 0;
    lastFrameTimeRef.current = Date.now();
    try {
      await Glasses.startVideoStream({ quality, frameRate: 15 });
      // Auto-enable gesture control pipeline: AR + Objects + Target + Command
      if (MediaPipe.isAvailable()) {
        try {
          const handOk = await MediaPipe.initialize();
          if (handOk) {
            mediapipeReady.current = true;
            setArMode(true);
          }
        } catch {}
        try {
          const objOk = await MediaPipe.initializeObjects();
          if (objOk) {
            objectReady.current = true;
            setObjectMode(true);
          }
        } catch {}
        setTargetMode(true);
        setCommandMode(true);
      }
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
        setCommandMode(false);
        setTargetMode(false);
        targetEngine.current.reset();
        setLockedTarget(null);
        setCandidateLabel(null);
        gestureManager.current.reset();
        resetSwipeTracking();
        await MediaPipe.dispose();
      }
      if (faceMode) {
        setFaceMode(false);
        faceReady.current = false;
        setFaces([]);
        setExpressions([]);
        await MediaPipe.disposeFaces();
      }
      if (poseMode) {
        setPoseMode(false);
        poseReady.current = false;
        setPoses([]);
        setExerciseState(null);
        exerciseTracker.current.reset();
        await MediaPipe.disposePose();
      }
      if (objectMode) {
        setObjectMode(false);
        objectReady.current = false;
        setDetectedObjects([]);
        await MediaPipe.disposeObjects();
      }
      await Glasses.stopVideoStream();
      setFrameData(null);
      setFps(0);
    } catch (e: any) {
      setError(e.message || "Failed to stop stream");
    }
  }, [arMode, faceMode, poseMode, objectMode]);

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
      setCommandMode(false);
      gestureManager.current.reset();
      resetSwipeTracking();
      await MediaPipe.dispose();
    }
  }, [arMode]);

  // Vision: send current frame for analysis in selected mode
  const handleVisionAnalyze = useCallback((mode?: VisionMode) => {
    const m = mode ?? visionMode;
    if (!latestFrameRef.current || !connectedRef.current) return;
    if (mode) setVisionMode(m);
    setVisionLoading(true);
    setVisionResult(null);
    const { data, width, height } = latestFrameRef.current;
    bridgeRef.current.sendVisionRequest(m, data, width, height);
  }, [visionMode]);

  // Auto-dismiss vision result after 15s
  const visionDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (visionDismissTimer.current) clearTimeout(visionDismissTimer.current);
    if (visionResult) {
      visionDismissTimer.current = setTimeout(() => setVisionResult(null), 15000);
    }
    return () => { if (visionDismissTimer.current) clearTimeout(visionDismissTimer.current); };
  }, [visionResult]);

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
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <StatusBar style="light" hidden={isStreaming} />

      {/* FULL-SCREEN CAMERA / PRE-STREAM STATES */}
      <View
        onLayout={onPreviewLayout}
        style={{ flex: 1, backgroundColor: "#0A0A0A", justifyContent: "center", alignItems: "center" }}
      >
        {/* === Disconnected === */}
        {!isConnected && !isConnecting && !initializing && (
          <View style={{ gap: 16, alignItems: "center" }}>
            <View
              style={{
                width: 100,
                height: 100,
                borderRadius: 50,
                borderWidth: 2,
                borderColor: "#333",
                justifyContent: "center",
                alignItems: "center",
                backgroundColor: "#1A1A1A",
              }}
            >
              <Text style={{ fontSize: 44 }}>{"\uD83D\uDC53"}</Text>
            </View>
            <Text style={{ color: "#525252", fontSize: 13, fontFamily: "monospace", textAlign: "center" }}>
              {"Connect your Meta Ray-Ban glasses\nvia the Meta AI companion app"}
            </Text>
            <TVPressable
              onPress={handleConnect}
              rarity="rare"
              style={{ paddingHorizontal: 40, paddingVertical: 16, borderRadius: 12, alignItems: "center" }}
            >
              <Text style={{ color: "#FFF", fontSize: 14, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 2 }}>
                CONNECT
              </Text>
            </TVPressable>
          </View>
        )}

        {initializing && (
          <View style={{ gap: 8, alignItems: "center" }}>
            <ActivityIndicator size="large" color="#06B6D4" />
            <Text style={{ color: "#737373", fontSize: 12, fontFamily: "monospace" }}>Initializing...</Text>
          </View>
        )}

        {isConnecting && (
          <View style={{ alignItems: "center", gap: 12 }}>
            <ActivityIndicator size="large" color="#F59E0B" />
            <Text style={{ color: "#F59E0B", fontSize: 13, fontFamily: "monospace", letterSpacing: 2 }}>
              CONNECTING...
            </Text>
            <Text style={{ color: "#525252", fontSize: 11, fontFamily: "monospace", textAlign: "center" }}>
              Follow the prompts in the Meta AI app
            </Text>
          </View>
        )}

        {/* === Connected, not streaming — big shutter button === */}
        {isConnected && !isStreaming && (
          <View style={{ gap: 16, alignItems: "center" }}>
            <TVPressable
              onPress={handleStartStream}
              style={{
                width: 80,
                height: 80,
                borderRadius: 40,
                borderWidth: 4,
                borderColor: "#FFF",
                backgroundColor: "transparent",
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: "#FFF" }} />
            </TVPressable>
            <TVPressable onPress={handleDisconnect} style={{ paddingHorizontal: 20, paddingVertical: 8 }}>
              <Text style={{ color: "#525252", fontSize: 11, fontFamily: "monospace" }}>DISCONNECT</Text>
            </TVPressable>
          </View>
        )}

        {/* === Full-screen feed === */}
        {isStreaming && frameData && (
          <Image
            source={{ uri: `data:image/jpeg;base64,${frameData}` }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
          />
        )}
        {isStreaming && !frameData && (
          <Text style={{ color: "#333", fontSize: 13, fontFamily: "monospace" }}>Waiting for frames...</Text>
        )}

        {/* === Detection overlays === */}
        {arMode && hands.length > 0 && frameSize.width > 0 && (
          <View style={StyleSheet.absoluteFill}>
            <HandOverlay hands={hands} width={frameSize.width} height={frameSize.height} activeFingers={currentGesture?.activeFingers} />
          </View>
        )}
        {faceMode && faces.length > 0 && frameSize.width > 0 && (
          <View style={StyleSheet.absoluteFill}>
            <FaceOverlay faces={faces} expressions={expressions} width={frameSize.width} height={frameSize.height} />
          </View>
        )}
        {poseMode && poses.length > 0 && frameSize.width > 0 && (
          <View style={StyleSheet.absoluteFill}>
            <PoseOverlay poses={poses} width={frameSize.width} height={frameSize.height} formQuality={exerciseState?.formQuality} />
          </View>
        )}
        {poseMode && exerciseState && <ExerciseHUD state={exerciseState} />}
        {objectMode && detectedObjects.length > 0 && frameSize.width > 0 && (
          <View style={StyleSheet.absoluteFill}>
            <ObjectOverlay
              objects={detectedObjects}
              width={frameSize.width}
              height={frameSize.height}
              lockedLabel={lockedTarget?.object.label}
              lockedDeviceName={lockedTarget?.target.name}
              candidateLabel={candidateLabel ?? undefined}
            />
          </View>
        )}

        {/* Vision overlay */}
        {isStreaming && <VisionOverlay result={visionResult} mode={visionMode} loading={visionLoading} />}

        {/* === Minimal floating HUD — only contextual feedback === */}
        {isStreaming && (
          <>
            {/* Tiny LIVE dot — top left */}
            <View style={{ position: "absolute", top: insets.top + 8, left: 12, flexDirection: "row", alignItems: "center", gap: 4 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#EF4444" }} />
              <Text style={{ color: "rgba(255,255,255,0.5)", fontSize: 8, fontFamily: "monospace" }}>LIVE</Text>
            </View>

            {/* Gesture feedback — only shows when a gesture is detected */}
            {arMode && currentGesture && currentGesture.gesture !== "none" && (
              <View
                style={{
                  position: "absolute",
                  top: insets.top + 8,
                  alignSelf: "center",
                  backgroundColor: "rgba(0,0,0,0.6)",
                  paddingHorizontal: 12,
                  paddingVertical: 4,
                  borderRadius: 12,
                }}
              >
                <Text style={{ color: "#00FF88", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>
                  {gestureEmoji(currentGesture.gesture)} {gestureLabel(currentGesture)}
                </Text>
              </View>
            )}

            {/* Target lock — shows when pointing at a controllable device */}
            {lockedTarget && (
              <View
                style={{
                  position: "absolute",
                  bottom: insets.bottom + 80,
                  alignSelf: "center",
                  backgroundColor: "rgba(0,255,136,0.9)",
                  paddingHorizontal: 16,
                  paddingVertical: 6,
                  borderRadius: 16,
                }}
              >
                <Text style={{ color: "#000", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>
                  {lockedTarget.target.name.toUpperCase()}
                </Text>
              </View>
            )}

            {/* Action result — shows briefly after a gesture command fires */}
            {lastAction && (
              <View
                style={{
                  position: "absolute",
                  bottom: insets.bottom + 110,
                  alignSelf: "center",
                  backgroundColor: "rgba(245,158,11,0.9)",
                  paddingHorizontal: 16,
                  paddingVertical: 6,
                  borderRadius: 16,
                }}
              >
                <Text style={{ color: "#000", fontSize: 13, fontFamily: "monospace", fontWeight: "bold" }}>
                  {lastAction.icon} {lastAction.label}
                </Text>
              </View>
            )}

            {/* HA control feedback — shows device state after action */}
            {controlFeedback && (
              <View
                style={{
                  position: "absolute",
                  bottom: insets.bottom + 140,
                  alignSelf: "center",
                  backgroundColor: "rgba(0,0,0,0.8)",
                  paddingHorizontal: 14,
                  paddingVertical: 4,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: "#FF6600",
                }}
              >
                <Text style={{ color: "#FF6600", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>
                  {controlFeedback}
                </Text>
              </View>
            )}
          </>
        )}

        {/* Back button — pre-stream only */}
        {!isStreaming && (
          <TVPressable
            onPress={() => router.back()}
            style={{ position: "absolute", top: insets.top + 8, left: 12, paddingHorizontal: 12, paddingVertical: 6 }}
          >
            <Text style={{ color: "#A3A3A3", fontSize: 12, fontWeight: "bold" }}>{"\u25C0 BACK"}</Text>
          </TVPressable>
        )}

        {/* Error — auto-dismissing banner */}
        {error && (
          <TVPressable
            onPress={() => setError(null)}
            style={{
              position: "absolute",
              top: insets.top + 28,
              left: 16,
              right: 16,
              backgroundColor: "rgba(239,68,68,0.15)",
              borderRadius: 8,
              padding: 10,
            }}
          >
            <Text style={{ color: "#EF4444", fontSize: 11, fontFamily: "monospace" }}>{error}</Text>
          </TVPressable>
        )}

        {/* Captured photo toast */}
        {capturedPhoto && (
          <TVPressable
            onPress={() => setCapturedPhoto(null)}
            style={{
              position: "absolute",
              top: insets.top + 28,
              right: 12,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: "#A855F7",
              overflow: "hidden",
            }}
          >
            <Image
              source={{ uri: `data:image/jpeg;base64,${capturedPhoto}` }}
              style={{ width: 80, height: 60 }}
              resizeMode="cover"
            />
          </TVPressable>
        )}
      </View>

      {/* === Bottom: stop button only (like iOS camera shutter) === */}
      {isStreaming && (
        <View
          style={{
            position: "absolute",
            bottom: Math.max(24, insets.bottom + 12),
            alignSelf: "center",
            alignItems: "center",
          }}
        >
          <TVPressable
            onPress={handleDisconnect}
            style={{
              width: 60,
              height: 60,
              borderRadius: 30,
              borderWidth: 3,
              borderColor: "rgba(255,255,255,0.3)",
              backgroundColor: "rgba(239,68,68,0.8)",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <View style={{ width: 20, height: 20, borderRadius: 4, backgroundColor: "#FFF" }} />
          </TVPressable>
        </View>
      )}

      {/* Settings sheet — accessible via long-press on stop button or from outside */}
      <SettingsSheet
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        quality={quality}
        onQualityChange={setQuality}
        visionMode={visionMode}
        onVisionModeChange={(m) => { setVisionMode(m); setVisionResult(null); }}
        onAnalyze={() => handleVisionAnalyze()}
        visionLoading={visionLoading}
        onDiagnostics={() => { try { setDiagnostics(Glasses.getDiagnostics()); } catch {} }}
        onLogs={() => { try { setLogs(Glasses.getLogs()); } catch {} }}
        diagnostics={diagnostics}
        logs={logs}
        onClearDiagnostics={() => setDiagnostics(null)}
        onClearLogs={() => setLogs(null)}
        onRefreshLogs={() => { try { setLogs(Glasses.getLogs()); } catch {} }}
        urlEvents={urlEvents}
        isStreaming={isStreaming}
      />
    </View>
  );
}
