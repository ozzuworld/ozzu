// SocErrorBoundary — catches render crashes inside the SOC engagement screen
// and shows a useful fallback instead of a blank-locked screen. Keeps the
// operator able to back out and try again instead of being trapped.

import React from "react";
import { Pressable, Text, View } from "react-native";
import { colors, fontSize, fontWeight, radius, spacing } from "../../lib/design-tokens";

interface Props {
  children: React.ReactNode;
  onReset?: () => void;
  onBack?: () => void;
}

interface State {
  err: Error | null;
}

export class SocErrorBoundary extends React.Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error) {
    try { console.error("[SocErrorBoundary]", err && err.message, err && err.stack); } catch { /* ignore */ }
  }

  reset = () => {
    this.setState({ err: null });
    if (this.props.onReset) {
      try { this.props.onReset(); } catch { /* ignore */ }
    }
  };

  render() {
    const { err } = this.state;
    if (!err) return this.props.children;

    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.base, padding: spacing.lg, justifyContent: "center" }}>
        <Text
          style={{
            color: colors.error,
            fontSize: fontSize.xl,
            fontWeight: fontWeight.bold,
            marginBottom: spacing.md,
          }}
        >
          Engagement screen crashed
        </Text>
        <Text
          style={{
            color: colors.text.secondary,
            fontSize: fontSize.sm,
            marginBottom: spacing.lg,
          }}
        >
          A render error stopped the screen from loading. Bridge data is unchanged — back out and try again. If it keeps crashing, share this message with Cipher:
        </Text>
        <View
          style={{
            backgroundColor: colors.bg.elevated,
            borderRadius: radius.md,
            padding: spacing.md,
            marginBottom: spacing.xl,
          }}
        >
          <Text
            selectable
            style={{
              color: colors.text.primary,
              fontFamily: "monospace",
              fontSize: fontSize.xs,
              lineHeight: 16,
            }}
          >
            {err.message || String(err)}
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: spacing.md }}>
          <Pressable
            onPress={this.reset}
            style={({ pressed }) => ({
              flex: 1,
              backgroundColor: colors.accent,
              borderRadius: radius.md,
              padding: spacing.md,
              alignItems: "center",
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Text style={{ color: colors.bg.base, fontSize: fontSize.md, fontWeight: fontWeight.semibold }}>
              Retry
            </Text>
          </Pressable>
          {this.props.onBack ? (
            <Pressable
              onPress={this.props.onBack}
              style={({ pressed }) => ({
                flex: 1,
                backgroundColor: colors.bg.elevated,
                borderRadius: radius.md,
                padding: spacing.md,
                alignItems: "center",
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Text style={{ color: colors.text.primary, fontSize: fontSize.md, fontWeight: fontWeight.semibold }}>
                Back
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }
}
