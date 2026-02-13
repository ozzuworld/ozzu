import { useEffect, useRef, useMemo } from "react";
import { View, Animated, Easing } from "react-native";
import { getDeviceType } from "../modules/pcm-player";

type OrbMode = "idle" | "ambient" | "active";

interface NebulaOrbProps {
  active: boolean;
  ambient?: boolean;
}

// ── Blob definitions ──
interface BlobConfig {
  width: number;
  height: number;
  color: string;
  // Lissajous drift amplitudes
  driftX: number;
  driftY: number;
  // Base animation durations (ms)
  driftDuration: number;
  scaleDuration: number;
  opacityDuration: number;
  rotateDuration: number;
  // Scale range
  scaleMin: number;
  scaleMax: number;
  // Opacity range (multiplied by mode factor)
  opacityMin: number;
  opacityMax: number;
  // Initial rotation offset
  rotateStart: number;
  rotateEnd: number;
}

const BLOBS: BlobConfig[] = [
  // 1: Background mass — deep blue
  {
    width: 200, height: 180, color: "rgba(15,23,42,0.6)",
    driftX: 18, driftY: 15, driftDuration: 8000, scaleDuration: 7000,
    opacityDuration: 6000, rotateDuration: 20000,
    scaleMin: 0.95, scaleMax: 1.05, opacityMin: 0.7, opacityMax: 1.0,
    rotateStart: 0, rotateEnd: 360,
  },
  // 2: Primary fog — cyan
  {
    width: 140, height: 120, color: "rgba(6,182,212,0.12)",
    driftX: 22, driftY: 18, driftDuration: 7013, scaleDuration: 6007,
    opacityDuration: 5003, rotateDuration: 18000,
    scaleMin: 0.95, scaleMax: 1.05, opacityMin: 0.6, opacityMax: 1.0,
    rotateStart: 45, rotateEnd: -315,
  },
  // 3: Bright wisp — bright cyan
  {
    width: 100, height: 90, color: "rgba(34,211,238,0.18)",
    driftX: 25, driftY: 20, driftDuration: 5987, scaleDuration: 5501,
    opacityDuration: 6997, rotateDuration: 15000,
    scaleMin: 0.9, scaleMax: 1.08, opacityMin: 0.5, opacityMax: 1.0,
    rotateStart: 120, rotateEnd: -240,
  },
  // 4: Purple accent
  {
    width: 120, height: 100, color: "rgba(139,92,246,0.08)",
    driftX: 20, driftY: 22, driftDuration: 8509, scaleDuration: 7507,
    opacityDuration: 6503, rotateDuration: 22000,
    scaleMin: 0.95, scaleMax: 1.05, opacityMin: 0.6, opacityMax: 1.0,
    rotateStart: 200, rotateEnd: -160,
  },
  // 5: Teal variation
  {
    width: 110, height: 130, color: "rgba(20,184,166,0.10)",
    driftX: 17, driftY: 24, driftDuration: 6491, scaleDuration: 7993,
    opacityDuration: 5497, rotateDuration: 19000,
    scaleMin: 0.93, scaleMax: 1.06, opacityMin: 0.5, opacityMax: 1.0,
    rotateStart: 70, rotateEnd: 430,
  },
  // 6: Indigo deep accent
  {
    width: 80, height: 70, color: "rgba(99,102,241,0.10)",
    driftX: 20, driftY: 16, driftDuration: 9001, scaleDuration: 6011,
    opacityDuration: 7507, rotateDuration: 25000,
    scaleMin: 0.92, scaleMax: 1.07, opacityMin: 0.6, opacityMax: 1.0,
    rotateStart: 300, rotateEnd: -60,
  },
  // 7: Edge wisp — elongated horizontal, rotates
  {
    width: 160, height: 60, color: "rgba(255,255,255,0.06)",
    driftX: 15, driftY: 12, driftDuration: 7499, scaleDuration: 8503,
    opacityDuration: 6007, rotateDuration: 12000,
    scaleMin: 0.9, scaleMax: 1.1, opacityMin: 0.4, opacityMax: 1.0,
    rotateStart: 0, rotateEnd: 360,
  },
  // 8: Edge wisp — vertical, counter-rotates
  {
    width: 50, height: 140, color: "rgba(6,182,212,0.12)",
    driftX: 14, driftY: 20, driftDuration: 6503, scaleDuration: 7499,
    opacityDuration: 8009, rotateDuration: 14000,
    scaleMin: 0.9, scaleMax: 1.08, opacityMin: 0.4, opacityMax: 1.0,
    rotateStart: 0, rotateEnd: -360,
  },
];

// Core luminous center
const CORE: BlobConfig = {
  width: 60, height: 60, color: "rgba(6,182,212,0.25)",
  driftX: 5, driftY: 5, driftDuration: 4001, scaleDuration: 3001,
  opacityDuration: 2503, rotateDuration: 30000,
  scaleMin: 0.9, scaleMax: 1.1, opacityMin: 0.6, opacityMax: 1.0,
  rotateStart: 0, rotateEnd: 360,
};

// Outer ambient halo
const HALO: BlobConfig = {
  width: 280, height: 280, color: "rgba(6,182,212,0.04)",
  driftX: 8, driftY: 8, driftDuration: 10007, scaleDuration: 9001,
  opacityDuration: 8003, rotateDuration: 40000,
  scaleMin: 0.97, scaleMax: 1.03, opacityMin: 0.5, opacityMax: 1.0,
  rotateStart: 0, rotateEnd: 360,
};

// ── Speed multipliers per mode ──
function modeMultipliers(mode: OrbMode) {
  switch (mode) {
    case "active":
      return { speed: 3.0, opacityBoost: 0.3, scaleBoost: 0.03 };
    case "ambient":
      return { speed: 1.5, opacityBoost: 0.15, scaleBoost: 0.01 };
    default:
      return { speed: 1.0, opacityBoost: 0, scaleBoost: 0 };
  }
}

// ── Hook: animate a single blob ──
function useBlob(config: BlobConfig, mode: OrbMode) {
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(config.opacityMax)).current;
  const rotate = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const m = modeMultipliers(mode);

    const loopDriftX = Animated.loop(
      Animated.sequence([
        Animated.timing(translateX, {
          toValue: config.driftX,
          duration: config.driftDuration / m.speed,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(translateX, {
          toValue: -config.driftX,
          duration: config.driftDuration / m.speed,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );

    const loopDriftY = Animated.loop(
      Animated.sequence([
        Animated.timing(translateY, {
          toValue: -config.driftY,
          duration: (config.driftDuration * 0.7) / m.speed,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: config.driftY,
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
function BlobView({
  config,
  mode,
}: {
  config: BlobConfig;
  mode: OrbMode;
}) {
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
const CONTAINER_SIZE = 240;

export function NebulaOrb({ active, ambient }: NebulaOrbProps) {
  const mode: OrbMode = active ? "active" : ambient ? "ambient" : "idle";
  const containerPulse = useContainerPulse(mode);

  // On TV, use fewer blobs for performance
  const isTV = useMemo(() => {
    try {
      return getDeviceType() === "tv";
    } catch {
      return false;
    }
  }, []);

  const blobConfigs = useMemo(() => {
    if (isTV) {
      // Reduced set: background, primary fog, bright wisp, core, halo
      return [BLOBS[0], BLOBS[1], BLOBS[2], BLOBS[4], BLOBS[6]];
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
        overflow: "hidden",
        transform: [{ scale: containerPulse }],
      }}
    >
      {/* Outer halo */}
      <BlobView config={HALO} mode={mode} />

      {/* Main blobs */}
      {blobConfigs.map((blob, i) => (
        <BlobView key={i} config={blob} mode={mode} />
      ))}

      {/* Luminous core */}
      <BlobView config={CORE} mode={mode} />
    </Animated.View>
  );
}
