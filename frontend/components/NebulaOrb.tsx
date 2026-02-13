import { useEffect, useRef, useMemo } from "react";
import { Animated, Easing } from "react-native";
import { getDeviceType } from "../modules/pcm-player";

type OrbMode = "idle" | "ambient" | "active";

interface NebulaOrbProps {
  active: boolean;
  ambient?: boolean;
}

// ── Fog layer textures ──
const FOG_TEXTURES = {
  large: require("../assets/fog/fog-large.png"),
  bright: require("../assets/fog/fog-bright.png"),
  purple: require("../assets/fog/fog-purple.png"),
  teal: require("../assets/fog/fog-teal.png"),
  core: require("../assets/fog/fog-core.png"),
  wispH: require("../assets/fog/fog-wisp-h.png"),
  wispV: require("../assets/fog/fog-wisp-v.png"),
};

// ── Fog layer config ──
interface FogLayerConfig {
  texture: keyof typeof FOG_TEXTURES;
  width: number;
  height: number;
  // Initial position offset from center
  offsetX: number;
  offsetY: number;
  // Lissajous drift amplitudes
  driftX: number;
  driftY: number;
  // Base animation durations (ms) — primes avoid sync
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
  // Rotation range (degrees)
  rotateStart: number;
  rotateEnd: number;
}

// ── Fog layers — organic, drifting fog masses ──
const FOG_LAYERS: FogLayerConfig[] = [
  // 1: Huge background fog — sets the ambient tone
  {
    texture: "large", width: 420, height: 420,
    offsetX: -15, offsetY: 10,
    driftX: 35, driftY: 28, driftDuration: 11003, scaleDuration: 9007,
    opacityDuration: 8501, rotateDuration: 45000,
    scaleMin: 0.9, scaleMax: 1.1, opacityMin: 0.3, opacityMax: 0.7,
    rotateStart: 0, rotateEnd: 360,
  },
  // 2: Second large mass — opposite phase
  {
    texture: "large", width: 380, height: 380,
    offsetX: 20, offsetY: -15,
    driftX: 30, driftY: 35, driftDuration: 9503, scaleDuration: 8009,
    opacityDuration: 7499, rotateDuration: 38000,
    scaleMin: 0.88, scaleMax: 1.12, opacityMin: 0.25, opacityMax: 0.65,
    rotateStart: 180, rotateEnd: -180,
  },
  // 3: Bright cyan wisp — drifts through center
  {
    texture: "bright", width: 300, height: 300,
    offsetX: -10, offsetY: -8,
    driftX: 40, driftY: 32, driftDuration: 7013, scaleDuration: 6007,
    opacityDuration: 5501, rotateDuration: 22000,
    scaleMin: 0.82, scaleMax: 1.15, opacityMin: 0.2, opacityMax: 0.6,
    rotateStart: 30, rotateEnd: -330,
  },
  // 4: Purple accent — upper-left drift
  {
    texture: "purple", width: 320, height: 320,
    offsetX: -50, offsetY: -40,
    driftX: 45, driftY: 35, driftDuration: 8509, scaleDuration: 7507,
    opacityDuration: 6997, rotateDuration: 30000,
    scaleMin: 0.85, scaleMax: 1.12, opacityMin: 0.15, opacityMax: 0.5,
    rotateStart: 200, rotateEnd: -160,
  },
  // 5: Teal — lower-right drift
  {
    texture: "teal", width: 300, height: 340,
    offsetX: 40, offsetY: 45,
    driftX: 38, driftY: 42, driftDuration: 6491, scaleDuration: 7993,
    opacityDuration: 5497, rotateDuration: 26000,
    scaleMin: 0.85, scaleMax: 1.1, opacityMin: 0.15, opacityMax: 0.45,
    rotateStart: 300, rotateEnd: 660,
  },
  // 6: Horizontal wisp — sweeps across
  {
    texture: "wispH", width: 400, height: 150,
    offsetX: 15, offsetY: -20,
    driftX: 50, driftY: 15, driftDuration: 7499, scaleDuration: 8503,
    opacityDuration: 6007, rotateDuration: 18000,
    scaleMin: 0.8, scaleMax: 1.2, opacityMin: 0.2, opacityMax: 0.55,
    rotateStart: -10, rotateEnd: 350,
  },
  // 7: Vertical wisp — counter-sweeps
  {
    texture: "wispV", width: 150, height: 400,
    offsetX: -25, offsetY: 10,
    driftX: 20, driftY: 45, driftDuration: 6503, scaleDuration: 7499,
    opacityDuration: 8009, rotateDuration: 20000,
    scaleMin: 0.8, scaleMax: 1.15, opacityMin: 0.15, opacityMax: 0.5,
    rotateStart: 10, rotateEnd: -350,
  },
  // 8: Bright core — stays central, brighter
  {
    texture: "core", width: 180, height: 180,
    offsetX: 0, offsetY: 0,
    driftX: 12, driftY: 12, driftDuration: 4001, scaleDuration: 3499,
    opacityDuration: 2503, rotateDuration: 35000,
    scaleMin: 0.88, scaleMax: 1.12, opacityMin: 0.4, opacityMax: 0.85,
    rotateStart: 0, rotateEnd: 360,
  },
  // 9: Core glow halo — just slightly larger than core
  {
    texture: "core", width: 250, height: 250,
    offsetX: 0, offsetY: 0,
    driftX: 8, driftY: 8, driftDuration: 5003, scaleDuration: 4507,
    opacityDuration: 3499, rotateDuration: 28000,
    scaleMin: 0.92, scaleMax: 1.08, opacityMin: 0.15, opacityMax: 0.4,
    rotateStart: 0, rotateEnd: -360,
  },
];

// ── Speed multipliers per mode ──
function modeMultipliers(mode: OrbMode) {
  switch (mode) {
    case "active":
      return { speed: 3.0, opacityBoost: 0.2, scaleBoost: 0.04 };
    case "ambient":
      return { speed: 1.5, opacityBoost: 0.1, scaleBoost: 0.02 };
    default:
      return { speed: 1.0, opacityBoost: 0, scaleBoost: 0 };
  }
}

// ── Hook: animate a single fog layer ──
function useFogLayer(config: FogLayerConfig, mode: OrbMode) {
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
    outputRange: [`${config.rotateStart}deg`, `${config.rotateEnd}deg`],
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

// ── Single fog layer: animated Image ──
function FogLayer({ config, mode }: { config: FogLayerConfig; mode: OrbMode }) {
  const { translateX, translateY, scale, opacity, rotate } = useFogLayer(config, mode);
  const source = FOG_TEXTURES[config.texture];

  return (
    <Animated.Image
      source={source}
      resizeMode="contain"
      style={{
        position: "absolute",
        width: config.width,
        height: config.height,
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
const CONTAINER_SIZE = 420;

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

  // TV: fewer layers for performance
  const layers = useMemo(() => {
    if (isTV) {
      return [FOG_LAYERS[0], FOG_LAYERS[2], FOG_LAYERS[5], FOG_LAYERS[7], FOG_LAYERS[8]];
    }
    return FOG_LAYERS;
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
      {layers.map((layer, i) => (
        <FogLayer key={i} config={layer} mode={mode} />
      ))}
    </Animated.View>
  );
}
