import { useEffect, useState, useRef, useCallback } from "react";
import { View, Text, StatusBar, Pressable, TextInput, BackHandler } from "react-native";
import { WebView } from "react-native-webview";
import * as Updates from "expo-updates";
import { isDeviceOwner, getVersionCode, downloadAndInstall } from "expo-device-owner";

// Bridge URL — use public URL so TV works standalone over internet
const DEFAULT_BRIDGE =
  process.env.EXPO_PUBLIC_BRIDGE_URL || "https://home.ozzu.world/bridge";
const DASHBOARD_PATH = "/dev/dashboard?port=5560";
const UPDATE_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

export default function App() {
  const [bridgeUrl, setBridgeUrl] = useState(DEFAULT_BRIDGE);
  const [editing, setEditing] = useState(false);
  const [inputUrl, setInputUrl] = useState(DEFAULT_BRIDGE);
  const [error, setError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const webViewRef = useRef<WebView>(null);

  // Hide system UI for full immersive mode
  useEffect(() => {
    StatusBar.setHidden(true);
  }, []);

  // Back button: if editing, close editor; otherwise let WebView handle it
  useEffect(() => {
    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (editing) {
        setEditing(false);
        return true;
      }
      return false;
    });
    return () => handler.remove();
  }, [editing]);

  // --- Update checker ---
  const checkForUpdates = useCallback(async () => {
    try {
      // 1. JS OTA update (expo-updates)
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        setUpdateStatus("Downloading JS update...");
        await Updates.fetchUpdateAsync();
        setUpdateStatus("Restarting...");
        await Updates.reloadAsync();
        return; // App restarts here
      }

      // 2. Native APK update (Device Owner silent install)
      const deviceOwner = isDeviceOwner();
      if (!deviceOwner) return; // Can't silently install without device owner

      const currentVersion = getVersionCode();
      const checkUrl = `${bridgeUrl}/tv/release/check?versionCode=${currentVersion}`;
      const res = await fetch(checkUrl);
      if (!res.ok) return;

      const data = await res.json();
      if (data.updateAvailable) {
        setUpdateStatus(`Installing v${data.versionName}...`);
        const downloadUrl = `${bridgeUrl}/tv/release/download`;
        await downloadAndInstall(downloadUrl);
        setUpdateStatus("Update installed — restarting...");
      }
    } catch (e) {
      // Silent fail — don't interrupt the dashboard
      console.log("Update check failed:", e);
      setUpdateStatus(null);
    }
  }, [bridgeUrl]);

  useEffect(() => {
    // Check on launch (after a short delay to let the app settle)
    const initialCheck = setTimeout(checkForUpdates, 10_000);
    // Check periodically
    const interval = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL);
    return () => {
      clearTimeout(initialCheck);
      clearInterval(interval);
    };
  }, [checkForUpdates]);

  const dashboardUrl = `${bridgeUrl}${DASHBOARD_PATH}`;

  if (editing) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: "#020208",
          alignItems: "center",
          justifyContent: "center",
          padding: 40,
        }}
      >
        <Text
          style={{
            color: "#0ff5ee",
            fontFamily: "monospace",
            fontSize: 18,
            letterSpacing: 4,
            marginBottom: 30,
          }}
        >
          OZZU TV // CONFIGURE
        </Text>
        <Text
          style={{
            color: "#0aa8a3",
            fontFamily: "monospace",
            fontSize: 13,
            letterSpacing: 2,
            marginBottom: 12,
          }}
        >
          BRIDGE URL
        </Text>
        <TextInput
          value={inputUrl}
          onChangeText={setInputUrl}
          style={{
            width: 500,
            height: 50,
            backgroundColor: "#0d0d14",
            borderWidth: 1,
            borderColor: "#0aa8a340",
            color: "#0ff5ee",
            fontFamily: "monospace",
            fontSize: 16,
            paddingHorizontal: 16,
            letterSpacing: 1,
          }}
          autoFocus
          selectTextOnFocus
          placeholderTextColor="#064d4a"
          placeholder="http://10.8.0.1:3333"
        />
        <View style={{ flexDirection: "row", gap: 20, marginTop: 24 }}>
          <Pressable
            onPress={() => {
              setBridgeUrl(inputUrl.replace(/\/+$/, ""));
              setError(null);
              setEditing(false);
            }}
            style={{
              backgroundColor: "#0aa8a320",
              borderWidth: 1,
              borderColor: "#0aa8a3",
              paddingHorizontal: 32,
              paddingVertical: 12,
            }}
          >
            <Text
              style={{
                color: "#0ff5ee",
                fontFamily: "monospace",
                fontSize: 14,
                letterSpacing: 2,
              }}
            >
              CONNECT
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setEditing(false)}
            style={{
              backgroundColor: "transparent",
              borderWidth: 1,
              borderColor: "#333",
              paddingHorizontal: 32,
              paddingVertical: 12,
            }}
          >
            <Text
              style={{
                color: "#666",
                fontFamily: "monospace",
                fontSize: 14,
                letterSpacing: 2,
              }}
            >
              CANCEL
            </Text>
          </Pressable>
        </View>
        {error && (
          <Text
            style={{
              color: "#ff3c3c",
              fontFamily: "monospace",
              fontSize: 12,
              marginTop: 20,
              letterSpacing: 1,
            }}
          >
            {error}
          </Text>
        )}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#020208" }}>
      <WebView
        ref={webViewRef}
        source={{ uri: dashboardUrl }}
        style={{ flex: 1, backgroundColor: "#020208" }}
        javaScriptEnabled
        domStorageEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        mixedContentMode="always"
        originWhitelist={["*"]}
        onError={(e) => {
          setError(`Connection failed: ${e.nativeEvent.description}`);
          setEditing(true);
        }}
        onHttpError={(e) => {
          if (e.nativeEvent.statusCode >= 500) {
            setError(`Server error: ${e.nativeEvent.statusCode}`);
          }
        }}
        // Long-press anywhere opens settings
        onLongPress={() => setEditing(true)}
        renderError={(errorName) => (
          <View
            style={{
              flex: 1,
              backgroundColor: "#020208",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              style={{
                color: "#ff3c3c",
                fontFamily: "monospace",
                fontSize: 14,
                letterSpacing: 2,
              }}
            >
              CONNECTION LOST
            </Text>
            <Text
              style={{
                color: "#0aa8a3",
                fontFamily: "monospace",
                fontSize: 11,
                marginTop: 8,
                letterSpacing: 1,
              }}
            >
              {errorName} — {bridgeUrl}
            </Text>
            <Pressable
              onPress={() => webViewRef.current?.reload()}
              style={{
                marginTop: 20,
                borderWidth: 1,
                borderColor: "#0aa8a3",
                paddingHorizontal: 24,
                paddingVertical: 10,
              }}
            >
              <Text
                style={{
                  color: "#0ff5ee",
                  fontFamily: "monospace",
                  letterSpacing: 2,
                }}
              >
                RETRY
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setInputUrl(bridgeUrl);
                setEditing(true);
              }}
              style={{ marginTop: 12 }}
            >
              <Text
                style={{
                  color: "#064d4a",
                  fontFamily: "monospace",
                  fontSize: 11,
                  letterSpacing: 2,
                }}
              >
                CONFIGURE
              </Text>
            </Pressable>
          </View>
        )}
      />
      {/* Update status indicator */}
      {updateStatus && (
        <View
          style={{
            position: "absolute",
            bottom: 12,
            left: 0,
            right: 0,
            alignItems: "center",
          }}
        >
          <Text
            style={{
              color: "#0ff5ee",
              fontFamily: "monospace",
              fontSize: 11,
              letterSpacing: 2,
              backgroundColor: "#020208cc",
              paddingHorizontal: 16,
              paddingVertical: 6,
            }}
          >
            {updateStatus}
          </Text>
        </View>
      )}
      {/* Floating settings button — top-right corner, very subtle */}
      <Pressable
        onPress={() => {
          setInputUrl(bridgeUrl);
          setEditing(true);
        }}
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          width: 32,
          height: 32,
          alignItems: "center",
          justifyContent: "center",
          opacity: 0.15,
        }}
      >
        <Text style={{ color: "#0ff5ee", fontFamily: "monospace", fontSize: 16 }}>
          {"\u2699"}
        </Text>
      </Pressable>
    </View>
  );
}
