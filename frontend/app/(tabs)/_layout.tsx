import { Tabs } from "expo-router";
import { Text } from "react-native";

function TabIcon({ emoji }: { emoji: string }) {
  return <Text style={{ fontSize: 18 }}>{emoji}</Text>;
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: "#111111",
          borderTopColor: "#222",
          borderTopWidth: 1,
          height: 56,
          paddingBottom: 6,
        },
        tabBarActiveTintColor: "#06B6D4",
        tabBarInactiveTintColor: "#525252",
        tabBarLabelStyle: {
          fontFamily: "monospace",
          fontSize: 10,
          fontWeight: "bold",
          letterSpacing: 1,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "HOME",
          tabBarIcon: () => <TabIcon emoji="🏠" />,
        }}
      />
      <Tabs.Screen
        name="cipher"
        options={{
          title: "CIPHER",
          tabBarIcon: () => <TabIcon emoji="🤖" />,
        }}
      />
      <Tabs.Screen
        name="osint"
        options={{
          title: "OSINT",
          tabBarIcon: () => <TabIcon emoji="🛡" />,
        }}
      />
      <Tabs.Screen
        name="business"
        options={{
          title: "BIZ",
          tabBarIcon: () => <TabIcon emoji="💼" />,
        }}
      />
      <Tabs.Screen
        name="music"
        options={{
          title: "MUSIC",
          tabBarIcon: () => <TabIcon emoji="🎵" />,
        }}
      />
    </Tabs>
  );
}
