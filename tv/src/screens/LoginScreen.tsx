import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  radius,
  withAlpha,
} from "../lib/theme";
import { FocusableButton } from "../components/FocusableButton";
import {
  loginWithPassword,
  quickConnectAuthenticate,
  quickConnectEnabled,
  quickConnectInitiate,
  quickConnectPoll,
} from "../lib/jellyfin/auth";
import {
  getBaseUrl,
  isServerReachable,
  resolveServerUrl,
  DEFAULT_BASE_URL,
} from "../lib/jellyfin/client";
import { loadBaseUrl, saveBaseUrl } from "../lib/jellyfin/storage";

type Mode = "loading" | "quick" | "password";

export function LoginScreen() {
  const nav = useNavigation<any>();
  const [mode, setMode] = useState<Mode>("loading");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverLabel, setServerLabel] = useState(getBaseUrl());
  const secretRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const goHome = useCallback(() => nav.reset({ index: 0, routes: [{ name: "Home" }] }), [nav]);

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const startQuickConnect = useCallback(async () => {
    setError(null);
    setMode("loading");
    stopPoll();
    try {
      const enabled = await quickConnectEnabled();
      if (!enabled) {
        setMode("password");
        return;
      }
      const init = await quickConnectInitiate();
      secretRef.current = init.secret;
      setCode(init.code);
      setMode("quick");
      pollRef.current = setInterval(async () => {
        if (!secretRef.current) return;
        try {
          const ok = await quickConnectPoll(secretRef.current);
          if (ok) {
            stopPoll();
            await quickConnectAuthenticate(secretRef.current);
            goHome();
          }
        } catch {
          /* keep polling */
        }
      }, 4000);
    } catch {
      setMode("password");
    }
  }, [goHome]);

  useEffect(() => {
    startQuickConnect();
    return stopPoll;
  }, [startQuickConnect]);

  const doPassword = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await loginWithPassword(username.trim(), password);
      goHome();
    } catch (e: any) {
      // Tell the truth about WHY: a 401/403 = credentials; anything else
      // (no response, timeout, DNS) = the server is unreachable from this
      // network. The old catch-all blamed credentials for network failures.
      const status = e?.response?.status;
      if (status === 401 || status === 403) {
        setError("Sign-in failed — check your username and password.");
      } else if (!isServerReachable()) {
        setServerLabel("none reachable");
        setError(
          "Can't reach any Jellyfin server from this network — join home WiFi (192.168.1.x) or the Ozzu VPN, then press Retry."
        );
      } else {
        setError(`Can't reach ${getBaseUrl()} — check the network, then press Retry.`);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, username, password, goHome]);

  const retryServer = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const persisted = await loadBaseUrl();
      const resolved = await resolveServerUrl(persisted || DEFAULT_BASE_URL);
      if (resolved) {
        if (resolved !== persisted) void saveBaseUrl(resolved);
        setServerLabel(resolved);
        setMode("password");
      } else {
        setServerLabel("none reachable");
        setError(
          "Still no Jellyfin server on this network — join home WiFi (192.168.1.x) or the Ozzu VPN."
        );
      }
    } finally {
      setBusy(false);
    }
  }, [busy]);

  return (
    <View style={styles.root}>
      <Text style={styles.brand}>
        OZZU<Text style={styles.brandAccent}> TV</Text>
      </Text>

      {mode === "loading" ? (
        <View style={styles.card}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.hint}>Connecting…</Text>
        </View>
      ) : null}

      {mode === "quick" ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Sign in with Quick Connect</Text>
          <Text style={styles.code}>{code}</Text>
          <Text style={styles.hint}>
            On your phone, open Jellyfin → menu → Quick Connect and enter this code.
          </Text>
          <View style={styles.waitingRow}>
            <ActivityIndicator color={colors.text.tertiary} />
            <Text style={styles.waiting}>Waiting for approval…</Text>
          </View>
          <View style={styles.actions}>
            <FocusableButton label="New code" onPress={startQuickConnect} hasTVPreferredFocus />
            <FocusableButton
              label="Use password"
              onPress={() => {
                stopPoll();
                setMode("password");
              }}
            />
          </View>
        </View>
      ) : null}

      {mode === "password" ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Sign in</Text>
          <Text style={styles.server}>
            Server: {isServerReachable() ? serverLabel : "none reachable"}
          </Text>
          <TextInput
            style={styles.input}
            placeholder="Username"
            placeholderTextColor={colors.text.tertiary}
            autoCapitalize="none"
            autoCorrect={false}
            value={username}
            onChangeText={setUsername}
            autoFocus
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor={colors.text.tertiary}
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.actions}>
            <FocusableButton
              label={busy ? "Working…" : "Sign In"}
              primary
              onPress={doPassword}
            />
            <FocusableButton label="Retry connection" onPress={retryServer} />
            <FocusableButton label="Quick Connect" onPress={startQuickConnect} />
          </View>
        </View>
      ) : null}

      {mode !== "password" && error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg.base },
  brand: {
    color: colors.text.primary,
    fontSize: fontSize.brand,
    fontWeight: fontWeight.black,
    letterSpacing: 3,
    marginBottom: spacing.xl,
  },
  brandAccent: { color: colors.accent },
  card: {
    backgroundColor: colors.bg.elevated,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xxl,
    minWidth: 640,
    alignItems: "center",
    gap: spacing.md,
  },
  cardTitle: {
    color: colors.text.primary,
    fontSize: fontSize.h2,
    fontWeight: fontWeight.bold,
    marginBottom: spacing.sm,
  },
  code: {
    color: colors.accent,
    fontSize: 64,
    fontWeight: fontWeight.black,
    letterSpacing: 10,
    fontVariant: ["tabular-nums"],
  },
  hint: {
    color: colors.text.secondary,
    fontSize: fontSize.body,
    textAlign: "center",
    maxWidth: 560,
  },
  server: {
    color: colors.text.tertiary,
    fontSize: fontSize.caption,
    marginBottom: spacing.sm,
  },
  waitingRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.sm },
  waiting: { color: colors.text.tertiary, fontSize: fontSize.caption },
  actions: { flexDirection: "row", gap: spacing.md, marginTop: spacing.lg },
  input: {
    width: 520,
    backgroundColor: withAlpha(colors.text.primary, 0.06),
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text.primary,
    fontSize: fontSize.body,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  error: { color: colors.accentBright, fontSize: fontSize.caption, marginTop: spacing.sm, textAlign: "center" },
});
