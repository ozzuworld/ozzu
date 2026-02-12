import { useState, useEffect } from "react";
import { View, Text } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { StatusBadge } from "../components/StatusBadge";
import { SciFiOrb } from "../components/SciFiOrb";
import { TVPressable } from "../components/TVPressable";
import { EntityStatusCards } from "../components/EntityStatusCards";

const TOP_BAR_HEIGHT = 48;

function useGreeting(): string {
  const [greeting, setGreeting] = useState(() => getGreeting());
  useEffect(() => {
    const id = setInterval(() => setGreeting(getGreeting()), 60000);
    return () => clearInterval(id);
  }, []);
  return greeting;
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Late night, King Kazuma";
  if (hour < 12) return "Good morning, King Kazuma";
  if (hour < 17) return "Good afternoon, King Kazuma";
  if (hour < 21) return "Good evening, King Kazuma";
  return "Good night, King Kazuma";
}

function useClock() {
  const [time, setTime] = useState(() => formatTime());
  useEffect(() => {
    const id = setInterval(() => setTime(formatTime()), 1000);
    return () => clearInterval(id);
  }, []);
  return time;
}

function formatTime(): string {
  const d = new Date();
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function LandingScreen() {
  const router = useRouter();
  const greeting = useGreeting();
  const clock = useClock();

  return (
    <View style={{ flex: 1, backgroundColor: "#111111" }}>
      {/* Top Bar */}
      <View
        style={{
          height: TOP_BAR_HEIGHT,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 16,
        }}
      >
        <Text style={{ color: "#F59E0B", fontSize: 24, fontWeight: "bold" }}>
          ozzu
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          <StatusBadge />
          <Text
            style={{
              color: "#525252",
              fontSize: 14,
              fontFamily: "monospace",
            }}
          >
            {clock}
          </Text>
        </View>
      </View>

      {/* Center Content */}
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingBottom: 40,
          gap: 24,
        }}
      >
        {/* Greeting */}
        <Text
          style={{
            color: "#737373",
            fontSize: 14,
            fontFamily: "monospace",
            letterSpacing: 1,
          }}
        >
          {greeting}
        </Text>

        {/* June Orb centerpiece */}
        <TVPressable
          rarity="epic"
          onPress={() => router.push("/chat")}
          style={{
            padding: 20,
            borderRadius: 80,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <SciFiOrb active={false} />
        </TVPressable>

        {/* June label */}
        <Text
          style={{
            color: "#06B6D4",
            fontSize: 12,
            fontWeight: "bold",
            letterSpacing: 3,
            fontFamily: "monospace",
          }}
        >
          JUNE
        </Text>
        <Text
          style={{
            color: "#444",
            fontSize: 11,
            fontFamily: "monospace",
          }}
        >
          Tap the orb to talk
        </Text>

        {/* Entity Status Cards */}
        <View style={{ marginTop: 16 }}>
          <EntityStatusCards />
        </View>

        {/* Quick Actions */}
        <View
          style={{
            flexDirection: "row",
            gap: 12,
            marginTop: 8,
          }}
        >
          <TVPressable
            rarity="rare"
            onPress={() => router.push("/equipment")}
            style={{
              paddingHorizontal: 20,
              paddingVertical: 12,
              borderRadius: 8,
            }}
          >
            <Text
              style={{
                color: "#93C5FD",
                fontSize: 12,
                fontWeight: "bold",
                letterSpacing: 1,
              }}
            >
              EQUIPMENT
            </Text>
          </TVPressable>

          <TVPressable
            rarity="epic"
            onPress={() => router.push("/chat")}
            style={{
              paddingHorizontal: 20,
              paddingVertical: 12,
              borderRadius: 8,
            }}
          >
            <Text
              style={{
                color: "#C084FC",
                fontSize: 12,
                fontWeight: "bold",
                letterSpacing: 1,
              }}
            >
              ASK JUNE
            </Text>
          </TVPressable>
        </View>
      </View>

      <StatusBar style="light" />
    </View>
  );
}
