import { useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  RefreshControl,
  Alert,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import {
  fetchDirective,
  fetchDirectiveHistory,
  cancelDirective,
  retryDirective,
  retryMergeDirective,
  unblockDirective,
  type Directive,
  type HistoryEntry,
} from "../../lib/bridge-api";
import {
  HUMAN_STATUS,
  TYPE_EMOJI,
  relativeTime,
  formatTimestamp,
  humanDuration,
  priorityLabel,
} from "../../lib/directive-constants";
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  withAlpha,
  statusPillStyle,
  actorColors,
  auditTypeColors,
} from "../../lib/design-tokens";
import { PlanReviewModal } from "../../components/directives/PlanReviewModal";
import { StatusChangeSheet } from "../../components/directives/StatusChangeSheet";
import { BuildRunBadge } from "../../components/directives/BuildRunBadge";

type Tab = "overview" | "activity";

export default function DirectiveDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { insets } = usePhoneLayout();

  const [directive, setDirective] = useState<Directive | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [planReviewDirective, setPlanReviewDirective] = useState<Directive | null>(null);
  const [statusChangeDirective, setStatusChangeDirective] = useState<Directive | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [d, h] = await Promise.all([
        fetchDirective(id),
        fetchDirectiveHistory(id).catch(() => []),
      ]);
      setDirective(d);
      setHistory(h);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const handleAction = useCallback(async (action: string) => {
    if (!directive) return;
    try {
      if (action === "cancel") {
        Alert.alert("Cancel Directive", "Are you sure?", [
          { text: "No", style: "cancel" },
          { text: "Cancel It", style: "destructive", onPress: async () => { await cancelDirective(directive.id); load(); } },
        ]);
        return;
      }
      if (action === "retry") { await retryDirective(directive.id); load(); return; }
      if (action === "retry_merge") {
        const r = await retryMergeDirective(directive.id);
        if (r.ok) Alert.alert("Success", "Merge succeeded! Deploying now.");
        else Alert.alert("Merge Failed", r.error || "Merge failed again");
        load();
        return;
      }
      if (action === "unblock") { await unblockDirective(directive.id); load(); return; }
      if (action === "approve") { setPlanReviewDirective(directive); return; }
      if (action === "status") { setStatusChangeDirective(directive); return; }
    } catch (err: any) {
      Alert.alert("Error", err.message);
    }
  }, [directive, load]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.base, justifyContent: "center", alignItems: "center", paddingTop: insets.top }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (error || !directive) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.base, justifyContent: "center", alignItems: "center", paddingTop: insets.top }}>
        <Text style={{ color: colors.error, fontSize: fontSize.base }}>{error || "Not found"}</Text>
        <Pressable onPress={() => router.back()} style={{ marginTop: spacing.lg }}>
          <Text style={{ color: colors.accent, fontSize: fontSize.base, fontWeight: fontWeight.semibold }}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  const pill = statusPillStyle(directive.status);
  const typeLabel = directive.type === "feature" ? "Feature" : directive.type === "epic" ? "Epic" : directive.type === "explore" ? "Explore" : "Quick";
  const typeColor = directive.type === "feature" ? "#3B82F6" : directive.type === "epic" ? "#A855F7" : directive.type === "explore" ? "#06B6D4" : "#22C55E";

  // Determine which action buttons to show
  const actionButtons: Array<{ label: string; action: string; color: string; filled?: boolean }> = [];
  if (directive.status === "planned") {
    actionButtons.push({ label: "Approve", action: "approve", color: colors.success, filled: true });
  }
  if (directive.status === "deploy_failed") {
    actionButtons.push({ label: "Retry Merge", action: "retry_merge", color: colors.warning });
    actionButtons.push({ label: "Retry Full", action: "retry", color: colors.info });
  }
  if (directive.status === "blocked") {
    actionButtons.push({ label: "Unblock", action: "unblock", color: "#A855F7" });
  }
  if (["failed", "stale", "cancelled"].includes(directive.status)) {
    actionButtons.push({ label: "Retry", action: "retry", color: colors.info });
  }
  if (!["completed", "failed", "cancelled", "stale", "planned", "blocked", "deploy_failed"].includes(directive.status)) {
    actionButtons.push({ label: "Cancel", action: "cancel", color: colors.error });
  }
  if (directive.plan) {
    actionButtons.push({ label: "View Plan", action: "plan", color: colors.accent });
  }
  actionButtons.push({ label: "Status", action: "status", color: colors.text.tertiary });

  // Timeline entries — merge activity_log and history, dedupe by timestamp+message
  const actLog = Array.isArray(directive.activity_log) ? directive.activity_log : [];
  const histList = Array.isArray(history) ? history : [];
  const timelineEntries = (() => {
    const all: HistoryEntry[] = [];
    const seen = new Set<string>();
    for (const h of histList) {
      const key = `${h.timestamp}-${h.message}`;
      if (!seen.has(key)) { seen.add(key); all.push(h); }
    }
    for (const e of actLog) {
      const key = `${e.timestamp}-${e.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push({ ...e, source: "activity_log" });
      }
    }
    return all.sort((a, b) => b.timestamp - a.timestamp);
  })();

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      {/* Header */}
      <View style={{ paddingTop: insets.top + spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.md }}>
        {/* Back + ID */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.sm }}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Text style={{ color: colors.text.secondary, fontSize: 20 }}>{"\u2039"}</Text>
          </Pressable>
          <Text style={{ color: colors.text.disabled, fontSize: fontSize.md }}>{directive.id}</Text>
        </View>

        {/* Title */}
        <Text style={{ color: colors.text.primary, fontSize: fontSize.xxl, fontWeight: fontWeight.semibold, marginBottom: spacing.sm }}>
          {directive.emoji ? `${directive.emoji} ` : ""}{directive.title}
        </Text>

        {/* Pills row */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
          {/* Status pill */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: pill.bg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: pill.dot }} />
            <Text style={{ color: pill.text, fontSize: fontSize.sm, fontWeight: fontWeight.medium }}>
              {HUMAN_STATUS[directive.status] || directive.status}
            </Text>
          </View>

          {/* Type pill */}
          <View style={{ backgroundColor: withAlpha(typeColor, 0.12), paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full }}>
            <Text style={{ color: typeColor, fontSize: fontSize.sm, fontWeight: fontWeight.medium }}>{typeLabel}</Text>
          </View>

          {/* Priority pill */}
          {(directive.priority ?? 3) <= 2 ? (
            <View style={{ backgroundColor: withAlpha(directive.priority <= 1 ? colors.error : colors.warning, 0.12), paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full }}>
              <Text style={{ color: directive.priority <= 1 ? "#FCA5A5" : "#FCD34D", fontSize: fontSize.sm, fontWeight: fontWeight.medium }}>
                {priorityLabel(directive.priority)}
              </Text>
            </View>
          ) : null}

          {/* Creator */}
          {directive.createdBy ? (
            <Text style={{ color: colors.text.tertiary, fontSize: fontSize.sm }}>{directive.createdBy}</Text>
          ) : null}
        </View>
      </View>

      {/* Tab bar */}
      <View style={{ flexDirection: "row", paddingHorizontal: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border.subtle }}>
        {(["overview", "activity"] as Tab[]).map((t) => (
          <Pressable
            key={t}
            onPress={() => setTab(t)}
            style={{
              paddingVertical: spacing.md,
              paddingHorizontal: spacing.lg,
              borderBottomWidth: 2,
              borderBottomColor: tab === t ? colors.accent : "transparent",
            }}
          >
            <Text style={{
              color: tab === t ? colors.text.primary : colors.text.tertiary,
              fontSize: fontSize.lg,
              fontWeight: tab === t ? fontWeight.semibold : fontWeight.normal,
            }}>
              {t === "overview" ? "Overview" : `Activity (${timelineEntries.length})`}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Content */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 100 + insets.bottom }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} />}
      >
        {tab === "overview" ? (
          <>
            {/* Description */}
            {directive.description ? (
              <View style={{ marginBottom: spacing.xl }}>
                <Text style={{ color: colors.text.secondary, fontSize: fontSize.base, lineHeight: 20 }}>
                  {directive.description}
                </Text>
              </View>
            ) : null}

            {/* Plan preview */}
            {directive.plan ? (
              <Pressable
                onPress={() => setPlanReviewDirective(directive)}
                style={{
                  backgroundColor: colors.bg.elevated,
                  borderRadius: radius.md,
                  padding: spacing.md,
                  marginBottom: spacing.xl,
                  borderWidth: 1,
                  borderColor: colors.border.subtle,
                  maxHeight: 120,
                  overflow: "hidden",
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.xs }}>
                  <Text style={{ color: colors.accent, fontSize: fontSize.md, fontWeight: fontWeight.semibold }}>Plan</Text>
                  <Text style={{ color: colors.text.disabled, fontSize: fontSize.sm }}>Tap to expand</Text>
                </View>
                <Text style={{ color: colors.text.tertiary, fontSize: fontSize.md, lineHeight: 18 }} numberOfLines={4}>
                  {directive.plan}
                </Text>
              </Pressable>
            ) : null}

            {/* Work Summary */}
            {directive.work_summary ? (
              <View style={{
                backgroundColor: colors.bg.elevated,
                borderRadius: radius.md,
                padding: spacing.md,
                marginBottom: spacing.xl,
                borderLeftWidth: 2,
                borderLeftColor: colors.info,
              }}>
                <Text style={{ color: colors.text.disabled, fontSize: fontSize.xs, fontWeight: fontWeight.bold, letterSpacing: 0.5, marginBottom: spacing.xs }}>
                  WORK SUMMARY
                </Text>
                <Text style={{ color: colors.text.secondary, fontSize: fontSize.md, lineHeight: 18 }} numberOfLines={12}>
                  {directive.work_summary}
                </Text>
              </View>
            ) : null}

            {/* Handoff Context */}
            {directive.handoff_context ? (
              <View style={{
                backgroundColor: colors.bg.elevated,
                borderRadius: radius.md,
                padding: spacing.md,
                marginBottom: spacing.xl,
                borderLeftWidth: 2,
                borderLeftColor: "#A855F7",
              }}>
                <Text style={{ color: colors.text.disabled, fontSize: fontSize.xs, fontWeight: fontWeight.bold, letterSpacing: 0.5, marginBottom: spacing.xs }}>
                  LAST SESSION HANDOFF
                </Text>
                <Text style={{ color: colors.text.secondary, fontSize: fontSize.md, lineHeight: 18 }} numberOfLines={8}>
                  {directive.handoff_context}
                </Text>
              </View>
            ) : null}

            {/* Failure reason */}
            {directive.failureReason ? (
              <View style={{
                backgroundColor: withAlpha(colors.error, 0.08),
                borderRadius: radius.md,
                padding: spacing.md,
                marginBottom: spacing.xl,
              }}>
                <Text style={{ color: "#FCA5A5", fontSize: fontSize.md, lineHeight: 18 }}>
                  {directive.failureReason}
                </Text>
              </View>
            ) : null}

            {/* Build runs */}
            {directive.buildRuns && directive.buildRuns.length > 0 ? (
              <View style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.xl, flexWrap: "wrap" }}>
                {directive.buildRuns.map((run, i) => (
                  <BuildRunBadge key={`${run.platform}-${run.runId}-${i}`} run={run} directiveId={directive.id} />
                ))}
              </View>
            ) : null}

            {/* Epic progress */}
            {directive.type === "epic" && directive.phases && directive.phases.length > 0 ? (() => {
              const total = directive.phases.length;
              const completed = directive.phases.filter((p) => p.status === "completed").length;
              const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
              return (
                <View style={{ marginBottom: spacing.xl }}>
                  <Text style={{ color: colors.text.disabled, fontSize: fontSize.xs, fontWeight: fontWeight.bold, letterSpacing: 0.5, marginBottom: spacing.sm }}>
                    EPIC PROGRESS
                  </Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    <View style={{ flex: 1, height: 6, backgroundColor: colors.bg.surface, borderRadius: 3, overflow: "hidden" }}>
                      <View style={{ width: `${pct}%` as any, height: "100%", backgroundColor: colors.success, borderRadius: 3 }} />
                    </View>
                    <Text style={{ color: colors.text.tertiary, fontSize: fontSize.sm }}>{completed}/{total}</Text>
                  </View>
                </View>
              );
            })() : null}

            {/* Metadata grid */}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginBottom: spacing.xl }}>
              <MetaItem label="Created" value={formatTimestamp(directive.createdAt)} />
              <MetaItem label="Updated" value={formatTimestamp(directive.updatedAt)} />
              {directive.startedAt ? <MetaItem label="Started" value={formatTimestamp(directive.startedAt)} /> : null}
              {directive.completedAt ? <MetaItem label="Completed" value={formatTimestamp(directive.completedAt)} /> : null}
              {directive.duration ? <MetaItem label="Duration" value={humanDuration(directive.duration)} /> : null}
              {(directive.retryCount ?? 0) > 0 ? <MetaItem label="Retries" value={String(directive.retryCount)} /> : null}
              {directive.mergeBranch ? <MetaItem label="Branch" value={directive.mergeBranch} /> : null}
            </View>

            {/* Dependencies */}
            {directive.dependsOn && directive.dependsOn.length > 0 ? (
              <View style={{ marginBottom: spacing.xl }}>
                <Text style={{ color: colors.text.disabled, fontSize: fontSize.xs, fontWeight: fontWeight.bold, letterSpacing: 0.5, marginBottom: spacing.sm }}>
                  DEPENDENCIES
                </Text>
                {directive.dependsOn.map((depId) => (
                  <Text key={depId} style={{ color: colors.text.tertiary, fontSize: fontSize.md, marginLeft: spacing.sm, lineHeight: 22 }}>
                    {depId}
                  </Text>
                ))}
              </View>
            ) : null}
          </>
        ) : (
          /* Activity timeline */
          <View style={{ gap: 0 }}>
            {timelineEntries.length === 0 ? (
              <Text style={{ color: colors.text.disabled, fontSize: fontSize.base, textAlign: "center", paddingVertical: 40 }}>
                No activity yet
              </Text>
            ) : (
              timelineEntries.map((entry, i) => {
                const dotColor = auditTypeColors[entry.type] || colors.text.disabled;
                const actor = entry.actor;
                const aColor = actorColors[actor || ""] || colors.text.tertiary;
                const isLast = i === timelineEntries.length - 1;

                return (
                  <View key={`${entry.timestamp}-${i}`} style={{ flexDirection: "row", minHeight: 40 }}>
                    {/* Timeline rail */}
                    <View style={{ width: 24, alignItems: "center" }}>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor, marginTop: 6 }} />
                      {!isLast ? (
                        <View style={{ width: 1, flex: 1, backgroundColor: colors.border.subtle, marginVertical: 2 }} />
                      ) : null}
                    </View>

                    {/* Content */}
                    <View style={{ flex: 1, paddingBottom: spacing.lg, paddingLeft: spacing.sm }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: 2 }}>
                        {actor ? (
                          <Text style={{
                            color: aColor,
                            fontSize: fontSize.xs,
                            fontWeight: fontWeight.bold,
                            backgroundColor: withAlpha(aColor, 0.1),
                            paddingHorizontal: 5,
                            paddingVertical: 1,
                            borderRadius: radius.xs,
                            overflow: "hidden",
                          }}>
                            {actor}
                          </Text>
                        ) : null}
                        <Text style={{ color: colors.text.disabled, fontSize: fontSize.xs }}>
                          {relativeTime(entry.timestamp)}
                        </Text>
                      </View>
                      <Text style={{ color: colors.text.secondary, fontSize: fontSize.md, lineHeight: 18 }}>
                        {entry.message}
                      </Text>
                    </View>
                  </View>
                );
              })
            )}
          </View>
        )}
      </ScrollView>

      {/* Bottom action bar */}
      {actionButtons.length > 0 ? (
        <View style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          backgroundColor: colors.bg.elevated,
          borderTopWidth: 1,
          borderTopColor: colors.border.subtle,
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.md,
          paddingBottom: Math.max(spacing.lg, insets.bottom),
        }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
            {actionButtons.map((btn) => (
              <Pressable
                key={btn.action}
                onPress={() => {
                  if (btn.action === "plan") setPlanReviewDirective(directive);
                  else handleAction(btn.action);
                }}
                style={{
                  paddingHorizontal: spacing.lg,
                  paddingVertical: spacing.sm,
                  borderRadius: radius.md,
                  backgroundColor: btn.filled ? btn.color : withAlpha(btn.color, 0.12),
                }}
              >
                <Text style={{
                  color: btn.filled ? "#fff" : btn.color,
                  fontSize: fontSize.md,
                  fontWeight: fontWeight.semibold,
                }}>
                  {btn.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      <PlanReviewModal
        visible={planReviewDirective !== null}
        directive={planReviewDirective}
        onDismiss={() => setPlanReviewDirective(null)}
        onResolved={load}
      />
      <StatusChangeSheet
        visible={statusChangeDirective !== null}
        directive={statusChangeDirective}
        onDismiss={() => setStatusChangeDirective(null)}
        onStatusChanged={load}
      />
    </View>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ width: "48%", marginBottom: spacing.sm }}>
      <Text style={{ color: colors.text.disabled, fontSize: fontSize.xs, fontWeight: fontWeight.semibold, letterSpacing: 0.3, marginBottom: 1 }}>
        {label}
      </Text>
      <Text style={{ color: colors.text.secondary, fontSize: fontSize.md }}>{value}</Text>
    </View>
  );
}
