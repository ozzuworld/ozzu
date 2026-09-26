import React, { useCallback, useEffect, useState } from "react";
import { StatusBar, View } from "react-native";
import { NavigationContainer, DarkTheme } from "@react-navigation/native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useKeepAwake } from "expo-keep-awake";
import * as Updates from "expo-updates";
import { isDeviceOwner, getVersionCode, downloadAndInstall } from "expo-device-owner";

import { RootNavigator } from "./src/navigation/RootNavigator";
import { Spinner } from "./src/components/States";
import { colors } from "./src/lib/theme";
import {
  configureClient,
  setBaseUrl,
  setAccessToken,
  setUserId,
  DEFAULT_BASE_URL,
} from "./src/lib/jellyfin/client";
import { getOrCreateDeviceId, loadBaseUrl, loadSession } from "./src/lib/jellyfin/storage";

const DEFAULT_BRIDGE = process.env.EXPO_PUBLIC_BRIDGE_URL || "https://home.ozzu.world/bridge";
const UPDATE_CHECK_INTERVAL = 5 * 60 * 1000;

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg.base,
    card: colors.bg.base,
    text: colors.text.primary,
    primary: colors.accent,
    border: colors.border,
  },
};

export default function App() {
  useKeepAwake();
  const [ready, setReady] = useState(false);
  const [initialRoute, setInitialRoute] = useState<"Home" | "Login">("Login");

  useEffect(() => {
    StatusBar.setHidden(true);
  }, []);

  // Bootstrap the Jellyfin client + restore a persisted session.
  useEffect(() => {
    (async () => {
      try {
        const deviceId = await getOrCreateDeviceId();
        configureClient(deviceId);
        const base = (await loadBaseUrl()) || DEFAULT_BASE_URL;
        setBaseUrl(base);
        const session = await loadSession();
        if (session?.accessToken && session.userId) {
          setAccessToken(session.accessToken);
          setUserId(session.userId);
          setInitialRoute("Home");
        }
      } catch {
        /* fall through to Login */
      } finally {
        setReady(true);
      }
    })();
  }, []);

  // OTA + device-owner self-update loop (preserved from the original TV app — R10).
  const checkForUpdates = useCallback(async () => {
    try {
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        await Updates.fetchUpdateAsync();
        await Updates.reloadAsync();
        return;
      }
      if (!isDeviceOwner()) return;
      const res = await fetch(`${DEFAULT_BRIDGE}/tv/release/check?versionCode=${getVersionCode()}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.updateAvailable) await downloadAndInstall(`${DEFAULT_BRIDGE}/tv/release/download`);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(checkForUpdates, 10_000);
    const i = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL);
    return () => {
      clearTimeout(t);
      clearInterval(i);
    };
  }, [checkForUpdates]);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
        <Spinner label="Ozzu TV" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer theme={navTheme}>
        <RootNavigator initialRouteName={initialRoute} />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
