import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { colors, fontSize, fontWeight, spacing } from "../lib/theme";
import { FocusableButton } from "./FocusableButton";

export function Centered({ children }: { children: React.ReactNode }) {
  return <View style={styles.center}>{children}</View>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <Centered>
      <ActivityIndicator size="large" color={colors.accent} />
      {label ? <Text style={styles.label}>{label}</Text> : null}
    </Centered>
  );
}

export function ErrorView({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Centered>
      <Text style={styles.errorTitle}>Something went wrong</Text>
      <Text style={styles.label}>{message}</Text>
      {onRetry ? (
        <FocusableButton
          label="Retry"
          onPress={onRetry}
          hasTVPreferredFocus
          style={{ marginTop: spacing.lg }}
        />
      ) : null}
    </Centered>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg.base,
    padding: spacing.xxl,
  },
  label: {
    color: colors.text.secondary,
    fontSize: fontSize.body,
    marginTop: spacing.md,
    textAlign: "center",
  },
  errorTitle: {
    color: colors.text.primary,
    fontSize: fontSize.h2,
    fontWeight: fontWeight.bold,
    marginBottom: spacing.sm,
  },
});
