import { useEffect, useRef, useMemo } from "react";
import { View, Animated, Easing } from "react-native";
import { getDeviceType } from "../modules/pcm-player";

type OrbMode = "idle" | "ambient" | "active";

interface NebulaOrbProps {
  active: boolean;
  ambient?: boolean;
}

// ── Blob definition ──
interface BlobConfig {
  width: number;
  height: number;
  // RGB values (no alpha — alpha is controlled per-layer)
  r: number;
  g: number;
  b: number;
  // Base alpha for innermost layer (outer layers fade from this)
  alpha: number;
  // Initial position offset from center
  offsetX: number;
  offsetY: number;
  // Lissajous drift amplitudes
  driftX: number;
  driftY: number;
  // Base animation durations (ms) — use primes to avoid sync
  driftDuration: number;
  scaleDuration: number;
  opacityDuration: number;
  rotateDuration: number;
  // Scale range
  scaleMin: number;
  scaleMax: number;
  // Opacity range (multiplier on alpha)
  opacityMin: number;
  opacityMax: number;
  // Rotation range
  rotateStart: number;
  rotateEnd: number;
  // Number of feather layers (more = softer edge, default 4)
  layers?: number;
}

// Feather layer multipliers: each layer is progressively larger and more transparent
// This creates soft edges without needing blur
const FEATHER_RINGS = [
  { sizeMultiplier: 1.0, alphaMultiplier: 1.0 },
  { sizeMultiplier: 1.35, alphaMultiplier: 0.45 },
  { sizeMultiplier: 1.7, alphaMultiplier: 0.2 },
  { sizeMultiplier: 2.1, alphaMultiplier: 0.08 },
];

// ── Blob layers — wide spread, organic offsets, feathered edges ──
const BLOBS: BlobConfig[] = [
  // 1: Huge ambient field — barely visible, sets the tone
  {
    width: 350, height: 280, r: 6, g: 182, b: 212, alpha: 0.035,
    offsetX: -20, offsetY: 15,
    driftX: 40, driftY: 30, driftDuration: 11003, scaleDuration: 9007,
    opacityDuration: 8501, rotateDuration: 40000,
    scaleMin: 0.92, scaleMax: 1.08, opacityMin: 0.5, opacityMax: 1.0,
    rotateStart: 0, rotateEnd: 360, layers: 4,
  },
  // 2: Primary fog mass — upper-left, large
  {
    width: 200, height: 160, r: 6, g: 182, b: 212, alpha: 0.06,
    offsetX: -55, offsetY: -40,
    driftX: 50, driftY: 40, driftDuration: 7013, scaleDuration: 6007,
    opacityDuration: 5501, rotateDuration: 22000,
    scaleMin: 0.85, scaleMax: 1.12, opacityMin: 0.4, opacityMax: 1.0,
    rotateStart: 20, rotateEnd: -340, layers: 4,
  },
  // 3: Secondary fog mass — lower-right
  {
    width: 180, height: 150, r: 6, g: 182, b: 212, alpha: 0.055,
    offsetX: 50, offsetY: 35,
    driftX: 45, driftY: 50, driftDuration: 8501, scaleDuration: 7499,
    opacityDuration: 6503, rotateDuration: 25000,
    scaleMin: 0.88, scaleMax: 1.1, opacityMin: 0.4, opacityMax: 1.0,
    rotateStart: 140, rotateEnd: -220, layers: 4,
  },
  // 4: Bright cyan wisp — drifts through center area
  {
    width: 120, height: 90, r: 34, g: 211, b: 238, alpha: 0.09,
    offsetX: -15, offsetY: -12,
    driftX: 45, driftY: 35, driftDuration: 5987, scaleDuration: 5003,
    opacityDuration: 4507, rotateDuration: 16000,
    scaleMin: 0.8, scaleMax: 1.18, opacityMin: 0.3, opacityMax: 1.0,
    rotateStart: 70, rotateEnd: -290, layers: 4,
  },
  // 5: Purple accent — far upper-left
  {
    width: 160, height: 120, r: 139, g: 92, b: 246, alpha: 0.04,
    offsetX: -60, offsetY: -50,
    driftX: 35, driftY: 40, driftDuration: 8509, scaleDuration: 7507,
    opacityDuration: 6997, rotateDuration: 28000,
    scaleMin: 0.9, scaleMax: 1.1, opacityMin: 0.4, opacityMax: 1.0,
    rotateStart: 200, rotateEnd: -160, layers: 3,
  },
  // 6: Teal — far lower-right
  {
    width: 150, height: 180, r: 20, g: 184, b: 166, alpha: 0.045,
    offsetX: 45, offsetY: 55,
    driftX: 35, driftY: 40, driftDuration: 6491, scaleDuration: 7993,
    opacityDuration: 5497, rotateDuration: 20000,
    scaleMin: 0.85, scaleMax: 1.12, opacityMin: 0.3, opacityMax: 1.0,
    rotateStart: 300, rotateEnd: 660, layers: 3,
  },
  // 7: Wide wisp — elongated, sweeps horizontally
  {
    width: 240, height: 55, r: 6, g: 182, b: 212, alpha: 0.04,
    offsetX: 20, offsetY: -25,
    driftX: 55, driftY: 18, driftDuration: 7499, scaleDuration: 8503,
    opacityDuration: 6007, rotateDuration: 14000,
    scaleMin: 0.8, scaleMax: 1.2, opacityMin: 0.3, opacityMax: 1.0,
    rotateStart: -15, rotateEnd: 345, layers: 3,
  },
  // 8: Tall wisp — vertical, counter-sweeps
  {
    width: 50, height: 220, r: 6, g: 182, b: 212, alpha: 0.04,
    offsetX: -30, offsetY: 15,
    driftX: 25, driftY: 45, driftDuration: 6503, scaleDuration: 7499,
    opacityDuration: 8009, rotateDuration: 18000,
    scaleMin: 0.8, scaleMax: 1.18, opacityMin: 0.3, opacityMax: 1.0,
    rotateStart: 10, rotateEnd: -350, layers: 3,
  },
];

// Core luminous center — stays near middle
const CORE: BlobConfig = {
  width: 40, height: 40, r: 6, g: 182, b: 212, alpha: 0.25,
  offsetX: 0, offsetY: 0,
  driftX: 10, driftY: 10, driftDuration: 4001, scaleDuration: 3001,
  opacityDuration: 2503, rotateDuration: 30000,
  scaleMin: 0.85, scaleMax: 1.15, opacityMin: 0.5, opacityMax: 1.0,
  rotateStart: 0, rotateEnd: 360, layers: 4,
};

// Inner glow around core
const CORE_GLOW: BlobConfig = {
  width: 90, height: 90, r: 6, g: 182, b: 212, alpha: 0.07,
  offsetX: 0, offsetY: 0,
  driftX: 14, driftY: 14, driftDuration: 5003, scaleDuration: 4507,
  opacityDuration: 3499, rotateDuration: 25000,
  scaleMin: 0.9, scaleMax: 1.1, opacityMin: 0.4, opacityMax: 1.0,
  rotateStart: 0, rotateEnd: -360, layers: 4,
};

// ── Speed multipliers per mode ──
function modeMultipliers(mode: OrbMode) {
  switch (mode) {
    case "active":
      return { speed: 3.0, opacityBoost: 0.3, scaleBoost: 0.04 };
    case "ambient":
      return { speed: 1.5, opacityBoost: 0.15, scaleBoost: 0.02 };
    default:
      return { speed: 1.0, opacityBoost: 0, scaleBoost: 0 };
  }
}

// ── Hook: animate a single blob ──
function useBlob(config: BlobConfig, mode: OrbMode) {
  const translateX = useRef(new Animated.Value(config.offsetX)).current;
  const translateY = useRef(new Animated.Value(config.offsetY)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(config.opacityMax)).current;
  const rotate = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const m = modeMultipliers(mode);

    const loopDriftX = Animated.loop(
      Animated.sequence([
        Animated.timing(translateX, {
          toValue: config.offsetX + config.driftX,
          duration: config.driftDuration / m.speed,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(translateX, {
          toValue: config.offsetX - config.driftX,
          duration: config.driftDuration / m.speed,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );

    const loopDriftY = Animated.loop(
      Animated.sequence([
        Animated.timing(translateY, {
          toValue: config.offsetY - config.driftY,
          duration: (config.driftDuration * 0.7) / m.speed,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: config.offsetY + config.driftY,
          duration: (config.driftDuration * 0.7) / m.speed,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );

    const scaleMin = config.scaleMin - m.scaleBoost;
    const scaleMax = config.scaleMax + m.scaleBoost;
    const loopScale = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, {
          toValue: scaleMax,
          duration: config.scaleDuration / m.speed,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: scaleMin,
          duration: config.scaleDuration / m.speed,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );

    const opMin = Math.min(1, config.opacityMin + m.opacityBoost);
    const opMax = Math.min(1, config.opacityMax + m.opacityBoost);
    const loopOpacity = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: opMax,
          duration: config.opacityDuration / m.speed,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: opMin,
          duration: config.opacityDuration / m.speed,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );

    const loopRotate = Animated.loop(
      Animated.timing(rotate, {
        toValue: 1,
        duration: config.rotateDuration / m.speed,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );

    loopDriftX.start();
    loopDriftY.start();
    loopScale.start();
    loopOpacity.start();
    loopRotate.start();

    return () => {
      loopDriftX.stop();
      loopDriftY.stop();
      loopScale.stop();
      loopOpacity.stop();
      loopRotate.stop();
    };
  }, [mode]);

  const rotateInterp = rotate.interpolate({
    inputRange: [0, 1],
    outputRange: [
      `${config.rotateStart}deg`,
      `${config.rotateEnd}deg`,
    ],
  });

  return { translateX, translateY, scale, opacity, rotate: rotateInterp };
}

// ── Container pulse for active mode ──
function useContainerPulse(mode: OrbMode) {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (mode === "active") {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, {
            toValue: 1.08,
            duration: 300,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
          Animated.timing(pulse, {
            toValue: 1.0,
            duration: 300,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
        ])
      );
      loop.start();
      return () => loop.stop();
    } else {
      Animated.timing(pulse, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start();
    }
  }, [mode]);

  return pulse;
}

// ── Single blob view with feathered layers ──
// Renders multiple concentric layers per blob to simulate soft/blurred edges
function BlobView({ config, mode }: { config: BlobConfig; mode: OrbMode }) {
  const { translateX, translateY, scale, opacity, rotate } = useBlob(config, mode);
  const layerCount = config.layers || 4;
  const rings = FEATHER_RINGS.slice(0, layerCount);

  return (
    <Animated.View
      style={{
        position: "absolute",
        width: config.width * 2.2,
        height: config.height * 2.2,
        alignItems: "center",
        justifyContent: "center",
        opacity,
        transform: [
          { translateX },
          { translateY },
          { scale },
          { rotate },
        ],
      }}
    >
      {rings.map((ring, i) => {
        const w = config.width * ring.sizeMultiplier;
        const h = config.height * ring.sizeMultiplier;
        const a = config.alpha * ring.alphaMultiplier;
        return (
          <View
            key={i}
            style={{
              position: "absolute",
              width: w,
              height: h,
              borderRadius: Math.max(w, h) / 2,
              backgroundColor: `rgba(${config.r},${config.g},${config.b},${a})`,
            }}
          />
        );
      })}
    </Animated.View>
  );
}

// ── Main component ──
const CONTAINER_SIZE = 400;

export function NebulaOrb({ active, ambient }: NebulaOrbProps) {
  const mode: OrbMode = active ? "active" : ambient ? "ambient" : "idle";
  const containerPulse = useContainerPulse(mode);

  const isTV = useMemo(() => {
    try {
      return getDeviceType() === "tv";
    } catch {
      return false;
    }
  }, []);

  const blobConfigs = useMemo(() => {
    if (isTV) {
      return [BLOBS[0], BLOBS[1], BLOBS[3], BLOBS[6]];
    }
    return BLOBS;
  }, [isTV]);

  return (
    <Animated.View
      renderToHardwareTextureAndroid
      style={{
        width: CONTAINER_SIZE,
        height: CONTAINER_SIZE,
        alignItems: "center",
        justifyContent: "center",
        transform: [{ scale: containerPulse }],
      }}
    >
      {/* Main blobs */}
      {blobConfigs.map((blob, i) => (
        <BlobView key={i} config={blob} mode={mode} />
      ))}

      {/* Core glow */}
      <BlobView config={CORE_GLOW} mode={mode} />

      {/* Luminous core */}
      <BlobView config={CORE} mode={mode} />
    </Animated.View>
  );
}
