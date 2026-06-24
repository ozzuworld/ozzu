import { Modal, Pressable, ScrollView, Share, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  colors, fontSize, fontWeight, radius, spacing, withAlpha,
} from "../../lib/design-tokens";

export interface StepDetail {
  id: number;
  seq: number;
  title: string;
  description?: string | null;
  command?: string | null;
  output?: string | null;
  status: string;
  intent_class?: string | null;
  auto_executed?: boolean;
  started_at?: string | null;
  completed_at?: string | null;
  expected_artifact?: string | null;
}

interface Props {
  visible: boolean;
  step: StepDetail | null;
  onClose: () => void;
}

function statusVis(s: string) {
  switch (s) {
    case "running": return { color: colors.success, label: "Running" };
    case "done": return { color: colors.accent, label: "Done" };
    case "failed": return { color: colors.error, label: "Failed" };
    case "skipped": return { color: colors.text.tertiary, label: "Skipped" };
    default: return { color: colors.warning, label: "Pending" };
  }
}

function formatDuration(start: string | null | undefined, end: string | null | undefined): string | null {
  if (!start) return null;
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const sec = Math.round((e - s) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

function intentLabel(cls: string): string {
  const labels: Record<string, string> = {
    recon: "Reconnaissance — mapping the target network",
    enum: "Enumeration — discovering services, directories, and endpoints",
    banner_grab: "Banner grab — reading service banners for version info",
    service_version: "Version detection — fingerprinting software versions",
    tool_setup: "Tool setup — installing/configuring tools",
    cred_test: "Credential testing — trying credentials against services",
    exploit_probe: "Exploit probing — testing known vulnerabilities",
    exploit_test: "Exploit testing — running exploit code",
    exploit_rce: "Remote code execution — attempting command execution",
    lateral: "Lateral movement — pivoting to another system",
    post_exploit: "Post-exploitation — extracting data after access",
  };
  return labels[cls] || cls;
}

export function StepDetailModal({ visible, step, onClose }: Props) {
  const insets = useSafeAreaInsets();
  if (!step) return null;

  const vis = statusVis(step.status);
  const dur = formatDuration(step.started_at, step.completed_at);

  const shareOutput = async () => {
    try {
      const text = [
        `#${step.seq} ${step.title}`,
        step.description ? `\n${step.description}` : "",
        step.command ? `\n--- Command ---\n${step.command}` : "",
        step.output ? `\n--- Output ---\n${step.output.slice(0, 4000)}` : "",
      ].join("");
      await Share.share({ message: text });
    } catch {}
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent={false}>
      <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: insets.top }}>
        {/* Header */}
        <View style={{
          flexDirection: "row", alignItems: "center",
          paddingHorizontal: spacing.md, paddingVertical: spacing.md + 2,
          backgroundColor: colors.bg.elevated,
          borderBottomWidth: 1, borderBottomColor: colors.border.subtle,
        }}>
          <Pressable onPress={onClose} hitSlop={16} style={({ pressed }) => ({
            opacity: pressed ? 0.6 : 1,
            paddingVertical: spacing.sm, paddingRight: spacing.md,
          })}>
            <Text style={{ color: colors.accent, fontSize: fontSize.lg, fontWeight: fontWeight.semibold }}>← Back</Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          <Pressable onPress={shareOutput} hitSlop={12} style={({ pressed }) => ({
            opacity: pressed ? 0.6 : 1,
            paddingVertical: spacing.sm, paddingLeft: spacing.md,
          })}>
            <Text style={{ color: colors.accent, fontSize: fontSize.base, fontWeight: fontWeight.semibold }}>Share</Text>
          </Pressable>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxxl, gap: spacing.md }}>
          {/* Title + status */}
          <View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.sm }}>
              <Text style={{ color: colors.text.tertiary, fontFamily: "monospace", fontSize: fontSize.base, fontWeight: fontWeight.semibold }}>#{step.seq}</Text>
              <View style={{
                flexDirection: "row", alignItems: "center",
                backgroundColor: withAlpha(vis.color, 0.14), borderRadius: radius.sm,
                paddingHorizontal: spacing.sm + 2, paddingVertical: 3,
              }}>
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: vis.color, marginRight: spacing.xs }} />
                <Text style={{ color: vis.color, fontSize: fontSize.sm, fontWeight: fontWeight.bold }}>{vis.label}</Text>
              </View>
            </View>
            <Text style={{ color: colors.text.primary, fontSize: fontSize.xxl, fontWeight: fontWeight.bold, lineHeight: 30 }}>{step.title}</Text>
          </View>

          {/* Description */}
          {step.description ? (
            <Text style={{ color: colors.text.secondary, fontSize: fontSize.md, lineHeight: 22 }}>{step.description}</Text>
          ) : null}

          {/* Meta row */}
          <View style={{
            flexDirection: "row", flexWrap: "wrap", gap: spacing.sm,
            backgroundColor: colors.bg.elevated, borderRadius: radius.md, padding: spacing.md,
          }}>
            {dur ? <MetaChip label="Duration" value={dur} /> : null}
            {step.auto_executed != null ? <MetaChip label="Execution" value={step.auto_executed ? "Auto" : "Manual"} /> : null}
            {step.intent_class ? <MetaChip label="Intent" value={step.intent_class} /> : null}
            {step.started_at ? <MetaChip label="Started" value={new Date(step.started_at).toLocaleTimeString()} /> : null}
          </View>

          {/* Intent explanation */}
          {step.intent_class ? (
            <Section title="What this step does">
              <Text style={{ color: colors.text.secondary, fontSize: fontSize.sm, lineHeight: 20 }}>
                {intentLabel(step.intent_class)}
              </Text>
            </Section>
          ) : null}

          {/* Command */}
          {step.command ? (
            <Section title="Command">
              <View style={{
                backgroundColor: colors.bg.elevated, borderRadius: radius.md,
                padding: spacing.md, borderWidth: 1, borderColor: colors.border.subtle,
              }}>
                <Text selectable style={{
                  color: colors.accent, fontFamily: "monospace",
                  fontSize: fontSize.xs, lineHeight: 18,
                }}>{step.command}</Text>
              </View>
            </Section>
          ) : null}

          {/* Expected artifact */}
          {step.expected_artifact ? (
            <Section title="Expected artifact">
              <Text style={{ color: colors.text.secondary, fontSize: fontSize.sm }}>{step.expected_artifact}</Text>
            </Section>
          ) : null}

          {/* Output */}
          {step.output ? (
            <Section title="Output">
              <View style={{
                backgroundColor: colors.bg.elevated, borderRadius: radius.md,
                padding: spacing.md, borderWidth: 1, borderColor: colors.border.subtle,
                maxHeight: 400,
              }}>
                <ScrollView nestedScrollEnabled>
                  <Text selectable style={{
                    color: colors.text.secondary, fontFamily: "monospace",
                    fontSize: fontSize.xs, lineHeight: 16,
                  }}>{step.output}</Text>
                </ScrollView>
              </View>
            </Section>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={{
        color: colors.text.tertiary, fontSize: fontSize.xs,
        fontWeight: fontWeight.semibold, textTransform: "uppercase", letterSpacing: 0.5,
      }}>{title}</Text>
      {children}
    </View>
  );
}

function MetaChip({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 2, minWidth: 70 }}>
      <Text style={{ color: colors.text.disabled, fontSize: fontSize.xs }}>{label}</Text>
      <Text style={{ color: colors.text.primary, fontSize: fontSize.sm, fontWeight: fontWeight.medium }}>{value}</Text>
    </View>
  );
}
