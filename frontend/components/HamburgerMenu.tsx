import { useState, useRef, useEffect } from "react";
import { View, Text, Pressable, Animated, Modal } from "react-native";
import { useRouter } from "expo-router";
import { TVPressable } from "./TVPressable";

const PANEL_WIDTH = 200;

type MenuItem =
  | { icon: string; label: string; route: string }
  | { icon: string; label: string; action: () => void };

const staticMenuItems: MenuItem[] = [
  { icon: "🕵️", label: "INTEL", route: "/osint" },
  { icon: "🚀", label: "VENTURES", route: "/business" },
  { icon: "📦", label: "FILES", route: "/files" },
  { icon: "🪪", label: "IDENTITY", route: "/identity" },
  { icon: "🎵", label: "MUSIC", route: "/music" },
  { icon: "📋", label: "DIRECTIVES", route: "/directives" },
  { icon: "📤", label: "UPLOAD", route: "/upload" },
  { icon: "👓", label: "GLASSES", route: "/glasses" },
  { icon: "💾", label: "BACKUPS", route: "/backup" },
  { icon: "🧠", label: "TRAINING", route: "/training" },
];

export function HamburgerMenu() {
  const router = useRouter();
  const [visible, setVisible] = useState(false);
  const scaleAnim = useRef(new Animated.Value(0.9)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let anim: Animated.CompositeAnimation;
    if (visible) {
      anim = Animated.parallel([
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
      ]);
    } else {
      anim = Animated.parallel([
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
      ]);
    }
    anim.start();
    return () => anim.stop();
  }, [visible]);

  const menuItems: MenuItem[] = staticMenuItems;

  const handleItemPress = (item: MenuItem) => {
    setVisible(false);
    if ("route" in item) {
      router.push(item.route as any);
    } else {
      item.action();
    }
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

      {/* Menu overlay — Modal ensures full-screen centering */}
      <Modal
        visible={visible}
        transparent
        animationType="none"
        statusBarTranslucent
        onRequestClose={() => setVisible(false)}
      >
        <View
          style={{
            flex: 1,
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
                key={item.label}
                onPress={() => handleItemPress(item)}
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
      </Modal>
    </>
  );
}

// Support both import styles:
// import HamburgerMenu from '...'        ← default
// import { HamburgerMenu } from '...'   ← named
export default HamburgerMenu;
