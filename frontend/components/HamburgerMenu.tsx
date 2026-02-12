import { useState, useRef, useEffect } from "react";
import { View, Text, Pressable, Animated } from "react-native";
import { useRouter } from "expo-router";
import { TVPressable } from "./TVPressable";

const PANEL_WIDTH = 200;

const menuItems = [
  { icon: "⚔️", label: "INVENTORY", route: "/equipment" as const },
];

export function HamburgerMenu() {
  const router = useRouter();
  const [visible, setVisible] = useState(false);
  const scaleAnim = useRef(new Animated.Value(0.9)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(scaleAnim, {
          toValue: 1,
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
        Animated.timing(scaleAnim, {
          toValue: 0.9,
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
            alignItems: "center",
            justifyContent: "center",
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

          {/* Centered HUD panel */}
          <Animated.View
            style={{
              width: PANEL_WIDTH,
              backgroundColor: "#111111",
              borderWidth: 1,
              borderColor: "#333",
              borderRadius: 12,
              paddingTop: 16,
              paddingBottom: 8,
              paddingHorizontal: 16,
              shadowColor: "#06B6D4",
              shadowOpacity: 0.15,
              shadowRadius: 16,
              shadowOffset: { width: 0, height: 0 },
              elevation: 8,
              opacity: fadeAnim,
              transform: [{ scale: scaleAnim }],
            }}
          >
            {/* Panel title */}
            <Text
              style={{
                color: "#06B6D4",
                fontSize: 12,
                fontFamily: "monospace",
                fontWeight: "bold",
                letterSpacing: 3,
                textAlign: "center",
              }}
            >
              MENU
            </Text>
            <View
              style={{
                height: 1,
                backgroundColor: "#222",
                marginTop: 10,
                marginBottom: 12,
              }}
            />

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
