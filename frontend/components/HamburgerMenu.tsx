import { useState, useRef, useEffect } from "react";
import { View, Text, Pressable, Animated, Dimensions } from "react-native";
import { useRouter } from "expo-router";
import { TVPressable } from "./TVPressable";

const MENU_WIDTH = 250;

const menuItems = [
  { icon: "⚔️", label: "INVENTORY", route: "/equipment" as const },
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
        style={({ pressed }) => ({
          padding: 8,
          opacity: pressed ? 0.6 : 1,
        })}
        hitSlop={8}
      >
        <Text
          style={{
            color: "#525252",
            fontSize: 22,
            fontFamily: "monospace",
          }}
        >
          ☰
        </Text>
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
              backgroundColor: "rgba(0,0,0,0.85)",
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
              backgroundColor: "#111111",
              borderRightWidth: 1,
              borderRightColor: "#222",
              paddingTop: 60,
              paddingHorizontal: 16,
              transform: [{ translateX: slideAnim }],
            }}
          >
            {menuItems.map((item) => (
              <TVPressable
                key={item.route}
                onPress={() => navigate(item.route)}
                style={{
                  paddingVertical: 14,
                  paddingHorizontal: 16,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  borderRadius: 8,
                  borderWidth: 0,
                }}
              >
                <Text style={{ fontSize: 18 }}>{item.icon}</Text>
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
              </TVPressable>
            ))}
          </Animated.View>
        </View>
      )}
    </>
  );
}
