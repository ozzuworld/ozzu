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

type Mode = "loading" | "quick" | "password";

export function LoginScreen() {
  const nav = useNavigation<any>();
  const [mode, setMode] = useState<Mode>("loading");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
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
    } catch {
      setError("Sign-in failed — check your username and password.");
    } finally {
      setBusy(false);
    }
  }, [busy, username, password, goHome]);

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
              label={busy ? "Signing in…" : "Sign In"}
              primary
              onPress={doPassword}
            />
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
