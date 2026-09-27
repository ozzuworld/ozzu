// consoleKit — the SOC report console's shared visual language (dir_1790544238642).
// Built from scratch for the kill-chain redo: dense hairline rows, sharp mono
// chips, micro uppercase labels, segmented stage tracks. NO floating cards,
// NO emoji pills — this is a console, not a dashboard. Tokens only.

import React from "react";
import { Pressable, Text, View } from "react-native";
import {
  colors,
  spacing,
  radius,
  fontSize as fs,
  fontWeight as fw,
  withAlpha,
} from "../../lib/design-tokens";
import {
  CHAIN_STATUS_ORDER,
  chainStatusColor,
  chainStatusLabel,
} from "./chainConstants";

export const MONO = "monospace";

// ── Type primitives ──

export function microStyle(color: string = colors.text.tertiary, size: number = fs.xs) {
  return {
    color,
    fontSize: size,
    fontWeight: fw.bold,
    letterSpacing: 1.6,
    textTransform: "uppercase" as const,
  };
}

export function MicroLabel({ children, color, size, style }: {
  children: React.ReactNode; color?: string; size?: number; style?: object;
}) {
  return <Text style={[microStyle(color, size), style]}>{children}</Text>;
}

export function Mono({ children, color = colors.text.tertiary, size = fs.xs, weight = fw.medium, numberOfLines, style }: {
  children: React.ReactNode; color?: string; size?: number;
  weight?: "normal" | "medium" | "semibold" | "bold"; numberOfLines?: number; style?: object;
}) {
  return (
    <Text numberOfLines={numberOfLines} style={[{ color, fontSize: size, fontWeight: fw[weight], fontFamily: MONO }, style]}>
      {children}
    </Text>
  );
}

// ── Sharp chip: uppercase mono, 1px alpha border, xs radius ──

export function Chip({ label, color, filled, size = 9, dot, onPress }: {
  label: string; color: string; filled?: boolean; size?: number; dot?: boolean; onPress?: () => void;
}) {
  const inner = (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: 4,
      paddingHorizontal: spacing.sm, paddingVertical: 3,
      borderRadius: radius.xs,
      backgroundColor: filled ? withAlpha(color, 0.16) : withAlpha(color, 0.07),
      borderWidth: 1, borderColor: withAlpha(color, filled ? 0.45 : 0.25),
    }}>
      {dot ? <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: color }} /> : null}
      <Text style={{ color, fontSize: size, fontWeight: fw.bold, letterSpacing: 1, textTransform: "uppercase", fontFamily: MONO }}>
        {label}
      </Text>
    </View>
  );
  if (!onPress) return inner;
  return (
    <Pressable onPress={onPress} hitSlop={6} style={({ pressed }) => ({ opacity: pressed ? 0.65 : 1 })}>
      {inner}
    </Pressable>
  );
}

// ── Section head: micro label + mono count + hairline ──

export function SectionHead({ label, right, rightColor }: {
  label: string; right?: string; rightColor?: string;
}) {
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: spacing.sm,
      marginTop: spacing.xl, marginBottom: spacing.sm,
    }}>
      <MicroLabel color={colors.text.secondary}>{label}</MicroLabel>
      {right != null ? <Mono color={rightColor || colors.text.disabled} size={fs.xs} weight="semibold">{right}</Mono> : null}
      <View style={{ flex: 1, height: 1, backgroundColor: colors.border.subtle }} />
    </View>
  );
}

// ── StageTrack — the console's signature: 8-segment disclosure pipeline bar ──

export function StageTrack({ status, showLabel = true }: { status: string; showLabel?: boolean }) {
  const idx = CHAIN_STATUS_ORDER.indexOf(status as (typeof CHAIN_STATUS_ORDER)[number]);
  const current = idx >= 0 ? chainStatusColor(status) : colors.text.disabled;
  return (
    <View>
      <View style={{ flexDirection: "row", gap: 3 }}>
        {CHAIN_STATUS_ORDER.map((s, i) => {
          const reached = idx >= 0 && i <= idx;
          const isCurrent = i === idx;
          return (
            <View key={s} style={{
              flex: 1,
              height: isCurrent ? 6 : 3,
              marginTop: isCurrent ? 0 : 1.5,
              borderRadius: 1,
              backgroundColor: reached ? chainStatusColor(s) : colors.gray[700],
              ...(isCurrent ? { shadowColor: chainStatusColor(s), shadowOpacity: 0.7, shadowRadius: 5, shadowOffset: { width: 0, height: 0 } } : null),
            }} />
          );
        })}
      </View>
      {showLabel ? (
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}>
          <MicroLabel color={current}>{chainStatusLabel(status)}</MicroLabel>
          <Mono color={colors.text.disabled} size={fs.xs}>{idx >= 0 ? `${idx + 1}/${CHAIN_STATUS_ORDER.length}` : "--"}</Mono>
        </View>
      ) : null}
    </View>
  );
}

// ── PulseBar — stacked proportional bar of findings by lifecycle ──

export interface PulseSegment { key: string; label: string; n: number; color: string; }

export function PulseBar({ segments }: { segments: PulseSegment[] }) {
  const total = segments.reduce((s, x) => s + x.n, 0);
  if (total <= 0) return null;
  return (
    <View style={{ flexDirection: "row", gap: 2, height: 6, marginBottom: spacing.md }}>
      {segments.filter((s) => s.n > 0).map((s) => (
        <View key={s.key} style={{
          flex: s.n, backgroundColor: s.color, borderRadius: 1,
          minWidth: 3,
        }} />
      ))}
    </View>
  );
}

// ── RowGroup + PressRow — dense hairline rows, no floating cards ──

export function RowGroup({ children }: { children: React.ReactNode }) {
  return (
    <View style={{
      borderWidth: 1, borderColor: colors.border.subtle, borderRadius: radius.md,
      overflow: "hidden", backgroundColor: withAlpha(colors.gray[850], 0.5),
    }}>
      {children}
    </View>
  );
}

export function PressRow({ rail, onPress, last, children, style }: {
  rail?: string; onPress?: () => void; last?: boolean;
  children: React.ReactNode; style?: object;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => ([
        {
          flexDirection: "row", alignItems: "center", gap: spacing.md,
          paddingHorizontal: spacing.md, paddingVertical: spacing.md + 2,
          borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.border.subtle,
          backgroundColor: pressed && onPress ? withAlpha(colors.text.secondary, 0.07) : "transparent",
        },
        style,
      ] as object)}
    >
      {rail ? (
        <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, backgroundColor: rail }} />
      ) : null}
      {children}
    </Pressable>
  );
}

// ── StatCell — big mono numeral over a micro label ──

export function StatCell({ value, label, color = colors.text.primary, size = fs.xxl, onPress }: {
  value: string | number; label: string; color?: string; size?: number; onPress?: () => void;
}) {
  const inner = (
    <View style={{ alignItems: "flex-start" }}>
      <Text style={{ color, fontSize: size, fontWeight: fw.bold, fontFamily: MONO, lineHeight: size + 4 }}>
        {value}
      </Text>
      <MicroLabel color={colors.text.disabled} size={9} style={{ marginTop: 2 }}>{label}</MicroLabel>
    </View>
  );
  if (!onPress) return inner;
  return (
    <Pressable onPress={onPress} hitSlop={8} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
      {inner}
    </Pressable>
  );
}

// ── SegTabs — uppercase mono segment tabs with counts + underline ──

export function SegTabs<T extends string>({ tabs, active, onChange }: {
  tabs: Array<{ key: T; label: string; count?: number | null }>;
  active: T; onChange: (k: T) => void;
}) {
  return (
    <View style={{
      flexDirection: "row",
      borderBottomWidth: 1, borderBottomColor: colors.border.subtle,
    }}>
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <Pressable
            key={t.key}
            onPress={() => onChange(t.key)}
            style={({ pressed }) => ({
              flex: 1, alignItems: "center", justifyContent: "center",
              paddingVertical: spacing.sm + 4,
              borderBottomWidth: 2, borderBottomColor: on ? colors.accent : "transparent",
              marginBottom: -1,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
              <Text style={{
                color: on ? colors.accent : colors.text.tertiary,
                fontSize: fs.xs, fontWeight: on ? fw.bold : fw.semibold,
                letterSpacing: 1.2, textTransform: "uppercase", fontFamily: MONO,
              }} numberOfLines={1}>
                {t.label}
              </Text>
              {t.count != null && t.count > 0 ? (
                <Text style={{ color: on ? colors.accent : colors.text.disabled, fontSize: 9, fontFamily: MONO, fontWeight: fw.bold }}>
                  {t.count}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Console header for pushed screens (back + micro label + right slot) ──

export function ConsoleHeader({ onBack, label, title, right }: {
  onBack: () => void; label: string; title?: string; right?: React.ReactNode;
}) {
  return (
    <View style={{
      paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.md,
      borderBottomWidth: 1, borderBottomColor: colors.border.subtle,
      backgroundColor: colors.bg.elevated,
    }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Pressable onPress={onBack} hitSlop={12} style={({ pressed }) => ({
          opacity: pressed ? 0.6 : 1,
          paddingHorizontal: spacing.sm + 2, paddingVertical: 3,
          borderWidth: 1, borderColor: colors.border.default, borderRadius: radius.xs,
          backgroundColor: withAlpha(colors.text.secondary, 0.06),
        })}>
          <Text style={{ color: colors.text.secondary, fontSize: fs.md, fontFamily: MONO, fontWeight: fw.bold }}>‹</Text>
        </Pressable>
        <MicroLabel color={colors.text.secondary}>{label}</MicroLabel>
        <View style={{ flex: 1 }} />
        {right}
      </View>
      {title ? (
        <Text style={{ color: colors.gray[50], fontSize: fs.xxl, fontWeight: fw.bold, marginTop: spacing.sm }} numberOfLines={2}>
          {title}
        </Text>
      ) : null}
    </View>
  );
}

// ── Empty state — micro label, no emoji, no dev-comment prefix ──

export function EmptyState({ text, sub }: { text: string; sub?: string }) {
  return (
    <View style={{ alignItems: "center", paddingVertical: spacing.xxxl, gap: spacing.xs }}>
      <MicroLabel color={colors.text.disabled} size={fs.sm}>{text}</MicroLabel>
      {sub ? <Mono color={colors.text.disabled} size={fs.xs}>{sub}</Mono> : null}
    </View>
  );
}
