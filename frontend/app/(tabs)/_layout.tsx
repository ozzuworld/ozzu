import { Tabs } from "expo-router";

export default function TabLayout() {
  return (
    <Tabs
      initialRouteName="directives"
      screenOptions={{
        headerShown: false,
        tabBarStyle: { display: "none" },
      }}
    >
      <Tabs.Screen name="directives" />
      <Tabs.Screen name="index" />
      <Tabs.Screen name="cipher" />
      <Tabs.Screen name="osint" />
      <Tabs.Screen name="business" />
      <Tabs.Screen name="files" />
      <Tabs.Screen name="music" />
      <Tabs.Screen name="ops" />
      <Tabs.Screen name="identity" />
    </Tabs>
  );
}
