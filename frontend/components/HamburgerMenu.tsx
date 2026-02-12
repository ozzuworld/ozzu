import { useState, useRef, useEffect } from "react";
import { View, Text, Pressable, Animated, Dimensions } from "react-native";
import { useRouter } from "expo-router";

const MENU_WIDTH = 200;
const SCREEN_WIDTH = Dimensions.get("window").width;

const menuItems = [
  { label: "CHAT", route: "/chat" as const },
  { label: "EQUIPMENT", route: "/equipment" as const },
];

export function HamburgerMenu() {
  const router = useRouter();
  const [visible, setVisible] = useState(false);
  const slideAnim = useRef(new Animated.Value(-MENU_WIDTH)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: -MENU_WIDTH,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible]);

  const navigate = (route: string) => {
    setVisible(false);
    router.push(route as any);
  };

  return (
    <>
      {/* Hamburger icon button */}
      <Pressable
        onPress={() => setVisible(true)}
        style={{ padding: 8 }}
        hitSlop={8}
      >
        <View style={{ gap: 4 }}>
          <View style={{ width: 20, height: 2, backgroundColor: "#737373", borderRadius: 1 }} />
          <View style={{ width: 20, height: 2, backgroundColor: "#737373", borderRadius: 1 }} />
          <View style={{ width: 20, height: 2, backgroundColor: "#737373", borderRadius: 1 }} />
        </View>
      </Pressable>

      {/* Menu overlay */}
      {visible && (
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 100,
          }}
        >
          {/* Backdrop */}
          <Animated.View
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: "rgba(0,0,0,0.7)",
              opacity: fadeAnim,
            }}
          >
            <Pressable
              style={{ flex: 1 }}
              onPress={() => setVisible(false)}
            />
          </Animated.View>

          {/* Slide-out panel */}
          <Animated.View
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              bottom: 0,
              width: MENU_WIDTH,
              backgroundColor: "#1A1A1A",
              borderRightWidth: 1,
              borderRightColor: "#333333",
              paddingTop: 60,
              transform: [{ translateX: slideAnim }],
            }}
          >
            {menuItems.map((item) => (
              <Pressable
                key={item.route}
                onPress={() => navigate(item.route)}
                style={({ pressed }) => ({
                  paddingVertical: 16,
                  paddingHorizontal: 24,
                  backgroundColor: pressed ? "#262626" : "transparent",
                })}
              >
                <Text
                  style={{
                    color: "#A3A3A3",
                    fontSize: 13,
                    fontFamily: "monospace",
                    fontWeight: "bold",
                    letterSpacing: 2,
                  }}
                >
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </Animated.View>
        </View>
      )}
    </>
  );
}
