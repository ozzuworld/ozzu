import { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  RefreshControl,
  Alert,
  ActivityIndicator,
  TextInput,
  KeyboardAvoidingView,
  Platform,
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
  commentDirective,
  type Directive,
  type HistoryEntry,
} from "../../lib/bridge-api";
import {
  HUMAN_STATUS,
  relativeTime,
  formatTimestamp,
  humanDuration,
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
  const scrollRef = useRef<ScrollView>(null);

  const [directive, setDirective] = useState<Directive | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);

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

  const handleSendComment = useCallback(async () => {
    if (!directive || !comment.trim() || sending) return;
    setSending(true);
    try {
      await commentDirective(directive.id, comment.trim());
      setComment("");
      setTab("activity");
      await load();
      setTimeout(() => scrollRef.current?.scrollTo({ y: 0, animated: true }), 100);
    } catch (err: any) {
      Alert.alert("Error", err.message);
    } finally {
      setSending(false);
    }
  }, [directive, comment, sending, load]);

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
  const typeColor = directive.type === "feature" ? colors.brand.blue : directive.type === "epic" ? colors.brand.purple : directive.type === "explore" ? colors.accent : colors.success;

  // Context action buttons
  const actions: Array<{ label: string; action: string; color: string; filled?: boolean }> = [];
  if (directive.status === "planned") {
    actions.push({ label: "Approve", action: "approve", color: colors.success, filled: true });
  }
  if (directive.status === "deploy_failed") {
    actions.push({ label: "Retry Merge", action: "retry_merge", color: colors.warning });
    actions.push({ label: "Retry", action: "retry", color: colors.info });
  }
  if (directive.status === "blocked") {
    actions.push({ label: "Unblock", action: "unblock", color: colors.brand.purple });
  }
  if (["failed", "stale", "cancelled"].includes(directive.status)) {
    actions.push({ label: "Retry", action: "retry", color: colors.info });
  }

  // Timeline entries
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
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg.base }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Header */}
      <View style={{ paddingTop: insets.top + spacing.xs, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
        {/* Back + ID + action dots */}
        <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 6 }}>
          <Pressable onPress={() => router.back()} hitSlop={16} style={{ paddingRight: 8 }}>
            <Text style={{ color: colors.text.tertiary, fontSize: 18 }}>{"\u2039"}</Text>
          </Pressable>
          <Text style={{ color: colors.text.disabled, fontSize: fontSize.xs, fontFamily: "monospace", flex: 1 }}>{directive.id}</Text>
          {/* Inline actions */}
          {actions.length > 0 ? (
            <View style={{ flexDirection: "row", gap: 6 }}>
              {actions.map((a) => (
                <Pressable
                  key={a.action}
                  onPress={() => handleAction(a.action)}
                  style={{
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                    borderRadius: 4,
                    backgroundColor: a.filled ? a.color : withAlpha(a.color, 0.12),
                  }}
                >
                  <Text style={{ color: a.filled ? "#fff" : a.color, fontSize: 10, fontWeight: fontWeight.semibold }}>
                    {a.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>

        {/* Title */}
        <Text style={{ color: colors.text.primary, fontSize: 16, fontWeight: fontWeight.semibold, lineHeight: 21, marginBottom: 6 }} numberOfLines={2}>
          {directive.emoji ? `${directive.emoji}  ` : ""}{directive.title}
        </Text>

        {/* Tags */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: pill.bg, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4 }}>
            <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: pill.dot }} />
            <Text style={{ color: pill.text, fontSize: fontSize.xs, fontWeight: fontWeight.medium }}>
              {HUMAN_STATUS[directive.status] || directive.status}
            </Text>
          </View>
          <View style={{ backgroundColor: withAlpha(typeColor, 0.1), paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
            <Text style={{ color: typeColor, fontSize: fontSize.xs, fontWeight: fontWeight.medium }}>{typeLabel}</Text>
          </View>
          {(directive.priority ?? 3) <= 2 ? (
            <View style={{ backgroundColor: withAlpha(directive.priority! <= 1 ? colors.error : colors.warning, 0.1), paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
              <Text style={{ color: directive.priority! <= 1 ? "#FCA5A5" : "#FCD34D", fontSize: fontSize.xs, fontWeight: fontWeight.bold }}>
                P{directive.priority}
              </Text>
            </View>
          ) : null}
          {directive.createdBy ? (
            <Text style={{ color: colors.text.disabled, fontSize: fontSize.xs }}>{directive.createdBy}</Text>
          ) : null}
          {directive.duration ? (
            <Text style={{ color: colors.text.disabled, fontSize: fontSize.xs }}>{humanDuration(directive.duration)}</Text>
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
              paddingVertical: 7,
              paddingHorizontal: spacing.md,
              borderBottomWidth: 2,
              borderBottomColor: tab === t ? colors.accent : "transparent",
            }}
          >
            <Text style={{
              color: tab === t ? colors.text.primary : colors.text.disabled,
              fontSize: fontSize.base,
              fontWeight: tab === t ? fontWeight.semibold : fontWeight.normal,
            }}>
              {t === "overview" ? "Overview" : `Activity ${timelineEntries.length}`}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Content */}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 80 + insets.bottom }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} />}
        keyboardShouldPersistTaps="handled"
      >
        {tab === "overview" ? (
          <>
            {/* Description */}
            {directive.description ? (
              <Text style={{ color: colors.text.secondary, fontSize: fontSize.base, lineHeight: 19, marginBottom: spacing.lg }}>
                {directive.description}
              </Text>
            ) : null}

            {/* Plan */}
            {directive.plan ? (
              <Pressable
                onPress={() => setPlanReviewDirective(directive)}
                style={{
                  backgroundColor: colors.bg.elevated,
                  borderRadius: radius.sm,
                  padding: spacing.md,
                  marginBottom: spacing.lg,
                  borderLeftWidth: 2,
                  borderLeftColor: colors.accent,
                  maxHeight: 100,
                  overflow: "hidden",
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <Text style={{ color: colors.accent, fontSize: fontSize.xs, fontWeight: fontWeight.semibold }}>PLAN</Text>
                  <Text style={{ color: colors.text.disabled, fontSize: fontSize.xs }}>tap to expand</Text>
                </View>
                <Text style={{ color: colors.text.tertiary, fontSize: fontSize.md, lineHeight: 16 }} numberOfLines={3}>
                  {directive.plan}
                </Text>
              </Pressable>
            ) : null}

            {/* Work Summary */}
            {directive.work_summary ? (
              <View style={{
                backgroundColor: colors.bg.elevated,
                borderRadius: radius.sm,
                padding: spacing.md,
                marginBottom: spacing.lg,
                borderLeftWidth: 2,
                borderLeftColor: colors.info,
              }}>
                <Text style={{ color: colors.text.disabled, fontSize: 9, fontWeight: fontWeight.bold, letterSpacing: 0.5, marginBottom: 4 }}>
                  WORK SUMMARY
                </Text>
                <Text style={{ color: colors.text.secondary, fontSize: fontSize.md, lineHeight: 17 }} numberOfLines={10}>
                  {directive.work_summary}
                </Text>
              </View>
            ) : null}

            {/* Handoff */}
            {directive.handoff_context ? (
              <View style={{
                backgroundColor: colors.bg.elevated,
                borderRadius: radius.sm,
                padding: spacing.md,
                marginBottom: spacing.lg,
                borderLeftWidth: 2,
                borderLeftColor: colors.brand.purple,
              }}>
                <Text style={{ color: colors.text.disabled, fontSize: 9, fontWeight: fontWeight.bold, letterSpacing: 0.5, marginBottom: 4 }}>
                  HANDOFF
                </Text>
                <Text style={{ color: colors.text.secondary, fontSize: fontSize.md, lineHeight: 17 }} numberOfLines={6}>
                  {directive.handoff_context}
                </Text>
              </View>
            ) : null}

            {/* Failure */}
            {directive.failureReason ? (
              <View style={{ backgroundColor: withAlpha(colors.error, 0.06), borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.lg }}>
                <Text style={{ color: "#FCA5A5", fontSize: fontSize.md, lineHeight: 17 }}>{directive.failureReason}</Text>
              </View>
            ) : null}

            {/* Build runs */}
            {directive.buildRuns && directive.buildRuns.length > 0 ? (
              <View style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.lg, flexWrap: "wrap" }}>
                {directive.buildRuns.map((run, i) => (
                  <BuildRunBadge key={`${run.platform}-${run.runId}-${i}`} run={run} directiveId={directive.id} />
                ))}
              </View>
            ) : null}

            {/* Epic progress */}
            {directive.type === "epic" && directive.phases && directive.phases.length > 0 ? (() => {
              const total = directive.phases.length;
              const done = directive.phases.filter((p) => p.status === "completed").length;
              const pct = total > 0 ? Math.round((done / total) * 100) : 0;
              return (
                <View style={{ marginBottom: spacing.lg }}>
                  <Text style={{ color: colors.text.disabled, fontSize: 9, fontWeight: fontWeight.bold, letterSpacing: 0.5, marginBottom: 6 }}>EPIC PROGRESS</Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    <View style={{ flex: 1, height: 4, backgroundColor: colors.bg.surface, borderRadius: 2, overflow: "hidden" }}>
                      <View style={{ width: `${pct}%` as any, height: "100%", backgroundColor: colors.success, borderRadius: 2 }} />
                    </View>
                    <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs }}>{done}/{total}</Text>
                  </View>
                </View>
              );
            })() : null}

            {/* Metadata */}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 2, marginBottom: spacing.lg }}>
              <MetaItem label="Created" value={formatTimestamp(directive.createdAt)} />
              <MetaItem label="Updated" value={formatTimestamp(directive.updatedAt)} />
              {directive.startedAt ? <MetaItem label="Started" value={formatTimestamp(directive.startedAt)} /> : null}
              {directive.completedAt ? <MetaItem label="Completed" value={formatTimestamp(directive.completedAt)} /> : null}
              {(directive.retryCount ?? 0) > 0 ? <MetaItem label="Retries" value={String(directive.retryCount)} /> : null}
              {directive.mergeBranch ? <MetaItem label="Branch" value={directive.mergeBranch} /> : null}
            </View>

            {/* Dependencies */}
            {directive.dependsOn && directive.dependsOn.length > 0 ? (
              <View style={{ marginBottom: spacing.lg }}>
                <Text style={{ color: colors.text.disabled, fontSize: 9, fontWeight: fontWeight.bold, letterSpacing: 0.5, marginBottom: 4 }}>DEPENDENCIES</Text>
                {directive.dependsOn.map((depId) => (
                  <Text key={depId} style={{ color: colors.text.tertiary, fontSize: fontSize.md, marginLeft: spacing.sm, lineHeight: 20 }}>{depId}</Text>
                ))}
              </View>
            ) : null}

            {/* Recent activity preview */}
            {timelineEntries.length > 0 ? (
              <View style={{ marginTop: spacing.sm }}>
                <Pressable onPress={() => setTab("activity")} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.sm }}>
                  <Text style={{ color: colors.text.disabled, fontSize: 9, fontWeight: fontWeight.bold, letterSpacing: 0.5 }}>RECENT ACTIVITY</Text>
                  <Text style={{ color: colors.accent, fontSize: fontSize.xs }}>View all</Text>
                </Pressable>
                {timelineEntries.slice(0, 3).map((entry, i) => (
                  <ActivityEntry key={`${entry.timestamp}-${i}`} entry={entry} isLast={i === Math.min(2, timelineEntries.length - 1)} />
                ))}
              </View>
            ) : null}
          </>
        ) : (
          /* Activity timeline */
          <View>
            {timelineEntries.length === 0 ? (
              <Text style={{ color: colors.text.disabled, fontSize: fontSize.base, textAlign: "center", paddingVertical: 40 }}>
                No activity yet
              </Text>
            ) : (
              timelineEntries.map((entry, i) => (
                <ActivityEntry key={`${entry.timestamp}-${i}`} entry={entry} isLast={i === timelineEntries.length - 1} />
              ))
            )}
          </View>
        )}
      </ScrollView>

      {/* Bottom bar — comment input + action shortcuts */}
      <View style={{
        backgroundColor: colors.bg.elevated,
        borderTopWidth: 1,
        borderTopColor: colors.border.subtle,
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.sm,
        paddingBottom: Math.max(spacing.sm, insets.bottom),
      }}>
        {/* Comment input row */}
        <View style={{
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: colors.bg.surface,
          borderRadius: radius.md,
          paddingHorizontal: spacing.md,
          minHeight: 36,
          gap: spacing.sm,
        }}>
          <TextInput
            value={comment}
            onChangeText={setComment}
            placeholder="Leave a comment..."
            placeholderTextColor={colors.text.disabled}
            style={{
              flex: 1,
              color: colors.text.primary,
              fontSize: fontSize.base,
              paddingVertical: 8,
            }}
            multiline
            maxLength={2000}
            returnKeyType="send"
            blurOnSubmit
            onSubmitEditing={handleSendComment}
          />
          {comment.trim() ? (
            <Pressable onPress={handleSendComment} disabled={sending} style={{ paddingLeft: 4 }}>
              <Text style={{ color: sending ? colors.text.disabled : colors.accent, fontSize: fontSize.base, fontWeight: fontWeight.bold }}>
                {sending ? "..." : "Send"}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {/* Quick action row below input */}
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 6, gap: spacing.sm }}>
          {directive.plan ? (
            <Pressable onPress={() => setPlanReviewDirective(directive)} style={{ paddingVertical: 2 }}>
              <Text style={{ color: colors.text.disabled, fontSize: fontSize.xs }}>Plan</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => handleAction("status")} style={{ paddingVertical: 2 }}>
            <Text style={{ color: colors.text.disabled, fontSize: fontSize.xs }}>Status</Text>
          </Pressable>
          {!["completed", "failed", "cancelled", "stale", "planned", "blocked", "deploy_failed"].includes(directive.status) ? (
            <Pressable onPress={() => handleAction("cancel")} style={{ paddingVertical: 2 }}>
              <Text style={{ color: withAlpha(colors.error, 0.5), fontSize: fontSize.xs }}>Cancel</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

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
    </KeyboardAvoidingView>
  );
}

function ActivityEntry({ entry, isLast }: { entry: HistoryEntry; isLast: boolean }) {
  const dotColor = auditTypeColors[entry.type] || colors.text.disabled;
  const actor = entry.actor;
  const aColor = actorColors[actor || ""] || colors.text.tertiary;
  const isComment = entry.type === "comment";

  return (
    <View style={{ flexDirection: "row", minHeight: 36 }}>
      {/* Timeline rail */}
      <View style={{ width: 20, alignItems: "center" }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: dotColor, marginTop: 5 }} />
        {!isLast ? <View style={{ width: 1, flex: 1, backgroundColor: colors.border.subtle, marginVertical: 2 }} /> : null}
      </View>

      {/* Content */}
      <View style={{ flex: 1, paddingBottom: spacing.md, paddingLeft: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 1 }}>
          {actor ? (
            <Text style={{
              color: aColor,
              fontSize: 10,
              fontWeight: fontWeight.bold,
              backgroundColor: withAlpha(aColor, 0.1),
              paddingHorizontal: 4,
              paddingVertical: 1,
              borderRadius: 3,
              overflow: "hidden",
            }}>
              {actor}
            </Text>
          ) : null}
          <Text style={{ color: colors.text.disabled, fontSize: 10 }}>
            {relativeTime(entry.timestamp)}
          </Text>
        </View>
        {isComment ? (
          <View style={{
            backgroundColor: colors.bg.elevated,
            borderRadius: radius.sm,
            padding: spacing.sm,
            marginTop: 3,
          }}>
            <Text style={{ color: colors.text.secondary, fontSize: fontSize.md, lineHeight: 17 }}>
              {entry.message}
            </Text>
          </View>
        ) : (
          <Text style={{ color: colors.text.tertiary, fontSize: fontSize.md, lineHeight: 17 }}>
            {entry.message}
          </Text>
        )}
      </View>
    </View>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ width: "48%", marginBottom: 6 }}>
      <Text style={{ color: colors.text.disabled, fontSize: 9, fontWeight: fontWeight.semibold, letterSpacing: 0.3 }}>{label}</Text>
      <Text style={{ color: colors.text.secondary, fontSize: fontSize.sm }}>{value}</Text>
    </View>
  );
}
