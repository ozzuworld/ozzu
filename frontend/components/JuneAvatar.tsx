import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Image,
  StyleSheet,
  View,
  type ImageSourcePropType,
  type ViewStyle,
} from "react-native";
import { colors, withAlpha } from "../lib/design-tokens";

const FACES = {
  smile: require("../assets/june/smile.png"),
  happy: require("../assets/june/happy.png"),
  amazed: require("../assets/june/amazed.png"),
  disappointed: require("../assets/june/disappointed.png"),
} as const;

type Expression = keyof typeof FACES;

interface Props {
  speaking?: boolean;
  expression?: Expression;
  style?: ViewStyle;
}

const SPEAK_CYCLE: Expression[] = ["happy", "amazed", "happy", "smile"];
const SPEAK_INTERVAL = 180;
const BLINK_MIN = 2500;
const BLINK_MAX = 5500;

export function JuneAvatar({ speaking = false, expression, style }: Props) {
  const [currentFace, setCurrentFace] = useState<Expression>("smile");
  const breathAnim = useRef(new Animated.Value(0)).current;
  const blinkAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const speakIndex = useRef(0);
  const blinkTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Breathing animation — gentle continuous scale
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathAnim, {
          toValue: 1,
          duration: 2800,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(breathAnim, {
          toValue: 0,
          duration: 2800,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [breathAnim]);

  // Blink animation — random interval
  useEffect(() => {
    function scheduleBlink() {
      const delay = BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN);
      blinkTimeout.current = setTimeout(() => {
        Animated.sequence([
          Animated.timing(blinkAnim, {
            toValue: 0.05,
            duration: 80,
            useNativeDriver: true,
          }),
          Animated.timing(blinkAnim, {
            toValue: 1,
            duration: 120,
            useNativeDriver: true,
          }),
        ]).start();
        scheduleBlink();
      }, delay);
    }
    scheduleBlink();
    return () => {
      if (blinkTimeout.current) clearTimeout(blinkTimeout.current);
    };
  }, [blinkAnim]);

  // Speaking: cycle through mouth shapes
  useEffect(() => {
    if (expression) {
      setCurrentFace(expression);
      return;
    }
    if (!speaking) {
      setCurrentFace("smile");
      speakIndex.current = 0;
      return;
    }
    setCurrentFace(SPEAK_CYCLE[0]);
    const timer = setInterval(() => {
      speakIndex.current = (speakIndex.current + 1) % SPEAK_CYCLE.length;
      setCurrentFace(SPEAK_CYCLE[speakIndex.current]);
    }, SPEAK_INTERVAL);
    return () => clearInterval(timer);
  }, [speaking, expression]);

  // Cross-fade on expression change
  useEffect(() => {
    Animated.sequence([
      Animated.timing(fadeAnim, {
        toValue: 0.85,
        duration: 40,
        useNativeDriver: true,
      }),
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 60,
        useNativeDriver: true,
      }),
    ]).start();
  }, [currentFace, fadeAnim]);

  const breathScale = breathAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.012],
  });

  const breathY = breathAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -1.5],
  });

  return (
    <View style={[styles.container, style]}>
      {/* Background gradient circle */}
      <View style={styles.bgCircle}>
        <View style={styles.bgInner} />
      </View>

      {/* Face with breathing + blink */}
      <Animated.View
        style={[
          styles.faceWrap,
          {
            opacity: fadeAnim,
            transform: [
              { scale: breathScale },
              { translateY: breathY },
            ],
          },
        ]}
      >
        {/* Blink overlay — squishes eyes vertically */}
        <Animated.View style={[styles.faceInner, { transform: [{ scaleY: blinkAnim }] }]}>
          <Image
            source={FACES[currentFace]}
            style={styles.faceImage}
            resizeMode="contain"
          />
        </Animated.View>
      </Animated.View>

      {/* Glow ring when speaking */}
      {speaking && <View style={styles.speakRing} />}
    </View>
  );
}

const FACE_SIZE = 220;

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    aspectRatio: 1,
  },
  bgCircle: {
    position: "absolute",
    width: FACE_SIZE + 60,
    height: FACE_SIZE + 60,
    borderRadius: (FACE_SIZE + 60) / 2,
    backgroundColor: withAlpha(colors.brand.purple, 0.08),
    alignItems: "center",
    justifyContent: "center",
  },
  bgInner: {
    width: FACE_SIZE + 30,
    height: FACE_SIZE + 30,
    borderRadius: (FACE_SIZE + 30) / 2,
    backgroundColor: withAlpha(colors.brand.purple, 0.12),
  },
  faceWrap: {
    width: FACE_SIZE,
    height: FACE_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  faceInner: {
    width: "100%",
    height: "100%",
  },
  faceImage: {
    width: "100%",
    height: "100%",
  },
  speakRing: {
    position: "absolute",
    width: FACE_SIZE + 70,
    height: FACE_SIZE + 70,
    borderRadius: (FACE_SIZE + 70) / 2,
    borderWidth: 2,
    borderColor: withAlpha(colors.brand.cyan, 0.4),
  },
});
