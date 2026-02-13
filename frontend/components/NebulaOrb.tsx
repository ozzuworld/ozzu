import { useEffect, useRef, useMemo } from "react";
import { Animated, Easing } from "react-native";
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
  color: string;
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
  // Opacity range
  opacityMin: number;
  opacityMax: number;
  // Rotation range
  rotateStart: number;
  rotateEnd: number;
}

// ── Blob layers — organic offsets, soft colors, varied shapes ──
const BLOBS: BlobConfig[] = [
  // 1: Large soft background wash — barely visible, sets the field
  {
    width: 260, height: 220, color: "rgba(6,182,212,0.04)",
    offsetX: -15, offsetY: 10,
    driftX: 25, driftY: 20, driftDuration: 9007, scaleDuration: 8003,
    opacityDuration: 7001, rotateDuration: 30000,
    scaleMin: 0.9, scaleMax: 1.1, opacityMin: 0.5, opacityMax: 1.0,
    rotateStart: 0, rotateEnd: 360,
  },
  // 2: Primary fog — offset upper-left
  {
    width: 180, height: 140, color: "rgba(6,182,212,0.08)",
    offsetX: -30, offsetY: -20,
    driftX: 35, driftY: 28, driftDuration: 7013, scaleDuration: 6007,
    opacityDuration: 5501, rotateDuration: 22000,
    scaleMin: 0.85, scaleMax: 1.1, opacityMin: 0.4, opacityMax: 1.0,
    rotateStart: 20, rotateEnd: -340,
  },
  // 3: Secondary fog — offset lower-right
  {
    width: 160, height: 130, color: "rgba(6,182,212,0.07)",
    offsetX: 25, offsetY: 15,
    driftX: 30, driftY: 35, driftDuration: 8501, scaleDuration: 7499,
    opacityDuration: 6503, rotateDuration: 25000,
    scaleMin: 0.88, scaleMax: 1.08, opacityMin: 0.4, opacityMax: 1.0,
    rotateStart: 140, rotateEnd: -220,
  },
  // 4: Bright wisp — smaller, brighter, off-center
  {
    width: 110, height: 80, color: "rgba(34,211,238,0.12)",
    offsetX: -10, offsetY: -8,
    driftX: 30, driftY: 25, driftDuration: 5987, scaleDuration: 5003,
    opacityDuration: 4507, rotateDuration: 16000,
    scaleMin: 0.8, scaleMax: 1.15, opacityMin: 0.3, opacityMax: 1.0,
    rotateStart: 70, rotateEnd: -290,
  },
  // 5: Purple accent — high and left
  {
    width: 140, height: 100, color: "rgba(139,92,246,0.05)",
    offsetX: -35, offsetY: -25,
    driftX: 28, driftY: 32, driftDuration: 8509, scaleDuration: 7507,
    opacityDuration: 6997, rotateDuration: 28000,
    scaleMin: 0.9, scaleMax: 1.1, opacityMin: 0.4, opacityMax: 1.0,
    rotateStart: 200, rotateEnd: -160,
  },
  // 6: Teal — low and right
  {
    width: 130, height: 160, color: "rgba(20,184,166,0.06)",
    offsetX: 20, offsetY: 30,
    driftX: 25, driftY: 30, driftDuration: 6491, scaleDuration: 7993,
    opacityDuration: 5497, rotateDuration: 20000,
    scaleMin: 0.85, scaleMax: 1.1, opacityMin: 0.3, opacityMax: 1.0,
    rotateStart: 300, rotateEnd: 660,
  },
  // 7: Elongated wisp — wide, thin, drifts across
  {
    width: 200, height: 50, color: "rgba(255,255,255,0.03)",
    offsetX: 15, offsetY: -15,
    driftX: 40, driftY: 15, driftDuration: 7499, scaleDuration: 8503,
    opacityDuration: 6007, rotateDuration: 14000,
    scaleMin: 0.8, scaleMax: 1.2, opacityMin: 0.3, opacityMax: 1.0,
    rotateStart: -15, rotateEnd: 345,
  },
  // 8: Vertical wisp — tall, thin, counter-rotates
  {
    width: 45, height: 180, color: "rgba(6,182,212,0.05)",
    offsetX: -20, offsetY: 10,
    driftX: 20, driftY: 35, driftDuration: 6503, scaleDuration: 7499,
    opacityDuration: 8009, rotateDuration: 18000,
    scaleMin: 0.8, scaleMax: 1.15, opacityMin: 0.3, opacityMax: 1.0,
    rotateStart: 10, rotateEnd: -350,
  },
  // 9: Indigo accent — small, deep
  {
    width: 90, height: 70, color: "rgba(99,102,241,0.06)",
    offsetX: 30, offsetY: -20,
    driftX: 22, driftY: 18, driftDuration: 9001, scaleDuration: 6011,
    opacityDuration: 7507, rotateDuration: 32000,
    scaleMin: 0.85, scaleMax: 1.1, opacityMin: 0.4, opacityMax: 1.0,
    rotateStart: 250, rotateEnd: -110,
  },
  // 10: Extra cyan puff — fills gaps
  {
    width: 120, height: 110, color: "rgba(6,182,212,0.06)",
    offsetX: 10, offsetY: -30,
    driftX: 32, driftY: 26, driftDuration: 7703, scaleDuration: 6509,
    opacityDuration: 5993, rotateDuration: 21000,
    scaleMin: 0.88, scaleMax: 1.12, opacityMin: 0.3, opacityMax: 1.0,
    rotateStart: 90, rotateEnd: 450,
  },
];

// Core luminous center — stays near middle
const CORE: BlobConfig = {
  width: 50, height: 50, color: "rgba(6,182,212,0.20)",
  offsetX: 0, offsetY: 0,
  driftX: 8, driftY: 8, driftDuration: 4001, scaleDuration: 3001,
  opacityDuration: 2503, rotateDuration: 30000,
  scaleMin: 0.85, scaleMax: 1.15, opacityMin: 0.5, opacityMax: 1.0,
  rotateStart: 0, rotateEnd: 360,
};

// Inner glow around core — soft spread
const CORE_GLOW: BlobConfig = {
  width: 100, height: 100, color: "rgba(6,182,212,0.08)",
  offsetX: 0, offsetY: 0,
  driftX: 12, driftY: 12, driftDuration: 5003, scaleDuration: 4507,
  opacityDuration: 3499, rotateDuration: 25000,
  scaleMin: 0.9, scaleMax: 1.1, opacityMin: 0.4, opacityMax: 1.0,
  rotateStart: 0, rotateEnd: -360,
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

// ── Single blob view ──
function BlobView({ config, mode }: { config: BlobConfig; mode: OrbMode }) {
  const { translateX, translateY, scale, opacity, rotate } = useBlob(config, mode);

  return (
    <Animated.View
      style={{
        position: "absolute",
        width: config.width,
        height: config.height,
        borderRadius: Math.max(config.width, config.height) / 2,
        backgroundColor: config.color,
        opacity,
        transform: [
          { translateX },
          { translateY },
          { scale },
          { rotate },
        ],
      }}
    />
  );
}

// ── Main component ──
const CONTAINER_SIZE = 320;

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
      // Reduced set for TV performance
      return [BLOBS[0], BLOBS[1], BLOBS[3], BLOBS[6], BLOBS[9]];
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
