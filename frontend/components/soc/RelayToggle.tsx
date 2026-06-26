import { useState, useEffect, useRef } from "react";
import { View, Text, Pressable, StyleSheet, Animated } from "react-native";
import {
  colors,
  spacing,
  radius,
  fontSize as fs,
  fontWeight as fw,
  withAlpha,
} from "../../lib/design-tokens";

let SocksRelay: any = null;
try {
  SocksRelay = require("../../modules/socks-relay");
} catch (_) {}

const RELAY_PORT = 1080;

export function RelayToggle() {
  const [running, setRunning] = useState(false);
  const [clients, setClients] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!SocksRelay) return;
    setRunning(SocksRelay.isRunning());

    const stateSub = SocksRelay.addListener(
      "onStateChange",
      (e: { running: boolean; clientCount: number }) => {
        setRunning(e.running);
        setClients(e.clientCount);
      }
    );
    const errSub = SocksRelay.addListener(
      "onError",
      (e: { message: string }) => setError(e.message)
    );
    return () => {
      stateSub?.remove();
      errSub?.remove();
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.4, duration: 1200, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 1200, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [running]);

  if (!SocksRelay) return null;

  const toggle = async () => {
    setError(null);
    if (running) {
      SocksRelay.stopRelay();
    } else {
      try {
        await SocksRelay.startRelay(RELAY_PORT);
      } catch (e: any) {
        setError(e.message);
      }
    }
  };

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={toggle}
        style={({ pressed }) => [
          styles.pill,
          running ? styles.pillActive : styles.pillInactive,
          pressed && { opacity: 0.7 },
        ]}
      >
        <Animated.View
          style={[
            styles.dot,
            { backgroundColor: running ? colors.green : colors.disabled },
            running && { opacity: pulse },
          ]}
        />
        <Text style={[styles.label, running && styles.labelActive]}>
          {running ? `Relay :${RELAY_PORT}` : "Relay Off"}
        </Text>
        {running && clients > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{clients}</Text>
          </View>
        )}
      </Pressable>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  pillInactive: {
    backgroundColor: withAlpha(colors.surface, 0.6),
    borderColor: withAlpha(colors.border, 0.4),
  },
  pillActive: {
    backgroundColor: withAlpha(colors.green, 0.15),
    borderColor: withAlpha(colors.green, 0.4),
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  label: { fontSize: fs.xs, fontWeight: fw.medium, color: colors.disabled },
  labelActive: { color: colors.green },
  badge: {
    backgroundColor: colors.green,
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  badgeText: { fontSize: 9, fontWeight: fw.bold, color: colors.bg },
  error: { fontSize: fs.xs, color: colors.red, maxWidth: 120 },
});
