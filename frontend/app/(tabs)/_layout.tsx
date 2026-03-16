import { Tabs } from "expo-router";

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { display: "none" },
      }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="cipher" />
      <Tabs.Screen name="osint" />
      <Tabs.Screen name="business" />
      <Tabs.Screen name="files" />
      <Tabs.Screen name="music" />
      <Tabs.Screen name="ops" />
    </Tabs>
  );
}
