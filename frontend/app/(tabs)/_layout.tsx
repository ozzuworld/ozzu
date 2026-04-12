import { Tabs } from "expo-router";
import { useEffect } from "react";

export default function TabLayout() {
  useEffect(() => { console.log("[boot] TabLayout mounted — initialRouteName=directives"); }, []);
  return (
    <Tabs
      initialRouteName="directives"
      screenOptions={{
        headerShown: false,
        tabBarStyle: { display: "none" },
      }}
    >
      <Tabs.Screen name="directives" />
      <Tabs.Screen name="cipher" />
      <Tabs.Screen name="osint" />
      <Tabs.Screen name="business" />
      <Tabs.Screen name="files" />
      <Tabs.Screen name="music" />
      <Tabs.Screen name="ops" />
      <Tabs.Screen name="identity" />
      <Tabs.Screen name="finance" />
      <Tabs.Screen name="influence" />
    </Tabs>
  );
}
