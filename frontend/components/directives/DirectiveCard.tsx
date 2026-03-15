import { useState, useCallback } from "react";
import { View, Text, Pressable, LayoutAnimation } from "react-native";
import { BuildRunBadge } from "./BuildRunBadge";
import { AuditTrail } from "./AuditTrail";
import {
  STATUS_EMOJI,
  STATUS_COLORS,
  TYPE_EMOJI,
  relativeTime,
  formatTimestamp,
  humanDuration,
  priorityLabel,
} from "../../lib/directive-constants";
import type { Directive, BuildStatus } from "../../lib/bridge-api";

// ── Subcomponents ──

function ActionChip({
  label,
  icon,
  color,
  filled,
  onPress,
}: {
  label: string;
  icon?: string;
  color: string;
  filled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 10,
        backgroundColor: filled ? color : `${color}15`,
      }}
    >
      {icon ? <Text style={{ fontSize: 13 }}>{icon}</Text> : null}
      <Text
        style={{
          color: filled ? "#fff" : color,
          fontSize: 12,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ width: "48%", marginBottom: 6 }}>
      <Text
        style={{
          color: "#525252",
          fontSize: 10,
          fontWeight: "600",
          letterSpacing: 0.3,
          marginBottom: 1,
        }}
      >
        {label}
      </Text>
      <Text style={{ color: "#A3A3A3", fontSize: 12 }}>
        {value}
      </Text>
    </View>
  );
}

// ── Main Card ──

interface DirectiveCardProps {
  directive: Directive;
  isTabletLandscape: boolean;
  onAction: (action: string, id: string) => void;
  buildStatus?: BuildStatus | null;
  onPlanReview?: (directive: Directive) => void;
  onStatusChange?: (directive: Directive) => void;
}

export function DirectiveCard({
  directive,
  isTabletLandscape,
  onAction,
  buildStatus,
  onPlanReview,
  onStatusChange,
}: DirectiveCardProps) {
  const [expanded, setExpanded] = useState(false);
  const statusColor = STATUS_COLORS[directive.status] || "#737373";
  const statusEmoji = STATUS_EMOJI[directive.status] || "";
  const actLog = directive.activity_log || [];

  const toggle = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((prev) => !prev);
  }, []);

  const typeLabel = directive.type === "feature" ? "Feature" : directive.type === "epic" ? "Epic" : "Quick";

  return (
    <Pressable
      onPress={toggle}
      style={{
        backgroundColor: "#141414",
        borderRadius: 14,
        borderLeftWidth: 3,
        borderLeftColor: statusColor,
        padding: 14,
        flex: isTabletLandscape ? 1 : undefined,
      }}
    >
      {/* Header row */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ fontSize: 18 }}>{directive.emoji || statusEmoji}</Text>
        <View style={{ flex: 1 }}>
          <Text
            style={{
              color: "#F5F5F5",
              fontSize: 15,
              fontWeight: "600",
              lineHeight: 20,
            }}
            numberOfLines={expanded ? undefined : 1}
          >
            {directive.title}
          </Text>
        </View>
        <Text style={{ color: "#3A3A3A", fontSize: 12 }}>
          {expanded ? "\u25B2" : "\u25B6"}
        </Text>
      </View>

      {/* Tags row */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6, marginLeft: 26 }}>
        {/* Type badge */}
        <View style={{
          paddingHorizontal: 8,
          paddingVertical: 2,
          borderRadius: 10,
          backgroundColor: directive.type === "feature" ? "#3B82F615" : directive.type === "epic" ? "#A855F715" : "#22C55E15",
        }}>
          <Text style={{
            color: directive.type === "feature" ? "#60A5FA" : directive.type === "epic" ? "#C084FC" : "#4ADE80",
            fontSize: 11,
            fontWeight: "600",
          }}>
            {typeLabel}
          </Text>
        </View>

        {/* Priority — only if high/critical */}
        {(directive.priority ?? 3) <= 2 ? (
          <View style={{
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: 10,
            backgroundColor: directive.priority <= 1 ? "#EF444415" : "#F59E0B15",
          }}>
            <Text style={{
              color: directive.priority <= 1 ? "#FCA5A5" : "#FCD34D",
              fontSize: 11,
              fontWeight: "600",
            }}>
              {priorityLabel(directive.priority ?? 3)}
            </Text>
          </View>
        ) : null}

        {/* Created by */}
        {directive.createdBy ? (
          <Text style={{ color: "#525252", fontSize: 11 }}>
            {directive.createdBy}
          </Text>
        ) : null}

        {/* Relative time */}
        <Text style={{ color: "#3A3A3A", fontSize: 11 }}>
          {relativeTime(directive.updatedAt)}
        </Text>

        {/* Duration */}
        {directive.duration ? (
          <Text style={{ color: "#3A3A3A", fontSize: 11 }}>
            {humanDuration(directive.duration)}
          </Text>
        ) : null}
      </View>

      {/* Epic progress bar */}
      {directive.type === "epic" && directive.phases && directive.phases.length > 0 ? (() => {
        const total = directive.phases.length;
        const completed = directive.phases.filter((p: Directive) => p.status === "completed").length;
        const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
        return (
          <View style={{ marginTop: 8, marginLeft: 26 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ flex: 1, height: 4, backgroundColor: "#1A1A1A", borderRadius: 2, overflow: "hidden" }}>
                <View style={{ width: `${pct}%` as any, height: "100%", backgroundColor: "#22C55E", borderRadius: 2 }} />
              </View>
              <Text style={{ color: "#525252", fontSize: 11 }}>
                {completed}/{total}
              </Text>
            </View>
          </View>
        );
      })() : null}

      {/* Phase badge */}
      {directive.epicId && directive.phaseOrder ? (
        <View style={{ marginTop: 4, marginLeft: 26 }}>
          <View style={{
            alignSelf: "flex-start",
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: 10,
            backgroundColor: "#A855F715",
          }}>
            <Text style={{ color: "#C084FC", fontSize: 11, fontWeight: "600" }}>
              Phase {directive.phaseOrder}
            </Text>
          </View>
        </View>
      ) : null}

      {/* Failure reason */}
      {directive.failureReason ? (
        <View
          style={{
            backgroundColor: "#EF444410",
            borderRadius: 10,
            padding: 10,
            marginTop: 8,
          }}
        >
          <Text
            style={{
              color: "#FCA5A5",
              fontSize: 12,
              lineHeight: 18,
            }}
          >
            {directive.failureReason}
          </Text>
        </View>
      ) : null}

      {/* Build run badges */}
      {directive.buildRuns && directive.buildRuns.length > 0 ? (
        <View style={{ flexDirection: "row", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          {directive.buildRuns.map((run, i) => (
            <BuildRunBadge
              key={`${run.platform}-${run.runId}-${i}`}
              run={run}
              directiveId={directive.id}
            />
          ))}
        </View>
      ) : null}

      {/* Latest activity one-liner */}
      {actLog.length > 0 && !expanded ? (
        <Text
          style={{
            color: "#525252",
            fontSize: 12,
            marginTop: 6,
            marginLeft: 26,
          }}
          numberOfLines={1}
        >
          {actLog[actLog.length - 1].message}
        </Text>
      ) : null}

      {/* Action buttons — shown when expanded */}
      {expanded ? (
        <View style={{ flexDirection: "row", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          {directive.status === "planned" ? (
            <>
              <ActionChip label="Approve" icon="" color="#22C55E" filled onPress={() => onAction("approve", directive.id)} />
              <ActionChip label="Deny" color="#EF4444" onPress={() => onAction("deny", directive.id)} />
            </>
          ) : null}
          {directive.status === "deploy_failed" ? (
            <>
              <ActionChip label="Retry Merge" icon="" color="#F59E0B" onPress={() => onAction("retry_merge", directive.id)} />
              <ActionChip label="Retry Full" icon="" color="#3B82F6" onPress={() => onAction("retry", directive.id)} />
            </>
          ) : null}
          {directive.status === "blocked" ? (
            <>
              <ActionChip label="Unblock" color="#A855F7" onPress={() => onAction("unblock", directive.id)} />
              <ActionChip label="Cancel" color="#EF4444" onPress={() => onAction("cancel", directive.id)} />
            </>
          ) : null}
          {["failed", "stale", "cancelled"].includes(directive.status) ? (
            <ActionChip label="Retry" icon="" color="#3B82F6" onPress={() => onAction("retry", directive.id)} />
          ) : null}
          {!["completed", "failed", "cancelled", "stale", "planned", "blocked", "deploy_failed"].includes(directive.status) ? (
            <ActionChip label="Cancel" color="#EF4444" onPress={() => onAction("cancel", directive.id)} />
          ) : null}

          {directive.plan && onPlanReview ? (
            <ActionChip label="View Plan" icon="" color="#06B6D4" onPress={() => onPlanReview(directive)} />
          ) : null}

          {onStatusChange ? (
            <ActionChip label="Status" color="#737373" onPress={() => onStatusChange(directive)} />
          ) : null}
        </View>
      ) : null}

      {/* Expanded content */}
      {expanded ? (
        <View style={{ marginTop: 14, borderTopWidth: 1, borderTopColor: "#1E1E1E", paddingTop: 12 }}>
          {/* Description */}
          {directive.description ? (
            <Text
              style={{
                color: "#A3A3A3",
                fontSize: 13,
                lineHeight: 20,
                marginBottom: 12,
              }}
            >
              {directive.description}
            </Text>
          ) : null}

          {/* Plan section — tap to open full review */}
          {directive.plan ? (
            <Pressable
              onPress={() => onPlanReview?.(directive)}
              style={{
                borderWidth: 1,
                borderColor: "#1E1E1E",
                borderRadius: 12,
                padding: 12,
                marginBottom: 12,
                backgroundColor: "#111111",
                maxHeight: 120,
                overflow: "hidden",
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <Text style={{ color: "#06B6D4", fontSize: 12, fontWeight: "600" }}>
                  Plan
                </Text>
                <Text style={{ color: "#3B82F6", fontSize: 11 }}>
                  Tap to review
                </Text>
              </View>
              <Text
                style={{
                  color: "#737373",
                  fontSize: 12,
                  lineHeight: 18,
                }}
                numberOfLines={4}
              >
                {directive.plan}
              </Text>
            </Pressable>
          ) : null}

          {/* Work Summary — Jira-style context section */}
          {directive.work_summary ? (
            <View style={{
              backgroundColor: "#111111",
              borderRadius: 10,
              padding: 12,
              marginBottom: 12,
              borderLeftWidth: 2,
              borderLeftColor: "#3B82F6",
            }}>
              <Text style={{ color: "#525252", fontSize: 10, fontWeight: "700", letterSpacing: 0.5, marginBottom: 4 }}>
                WORK SUMMARY
              </Text>
              <Text style={{ color: "#A3A3A3", fontSize: 12, lineHeight: 18 }} numberOfLines={8}>
                {directive.work_summary}
              </Text>
            </View>
          ) : null}

          {/* Handoff Context — what the last session left for the next */}
          {directive.handoff_context ? (
            <View style={{
              backgroundColor: "#111111",
              borderRadius: 10,
              padding: 12,
              marginBottom: 12,
              borderLeftWidth: 2,
              borderLeftColor: "#A855F7",
            }}>
              <Text style={{ color: "#525252", fontSize: 10, fontWeight: "700", letterSpacing: 0.5, marginBottom: 4 }}>
                LAST SESSION HANDOFF
              </Text>
              <Text style={{ color: "#A3A3A3", fontSize: 12, lineHeight: 18 }} numberOfLines={6}>
                {directive.handoff_context}
              </Text>
            </View>
          ) : null}

          {/* Metadata grid */}
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 4,
              marginBottom: 12,
            }}
          >
            <MetaItem label="Created" value={formatTimestamp(directive.createdAt)} />
            <MetaItem label="Updated" value={formatTimestamp(directive.updatedAt)} />
            {directive.startedAt ? (
              <MetaItem label="Started" value={formatTimestamp(directive.startedAt)} />
            ) : null}
            {directive.completedAt ? (
              <MetaItem label="Completed" value={formatTimestamp(directive.completedAt)} />
            ) : null}
            {directive.duration ? (
              <MetaItem label="Duration" value={humanDuration(directive.duration)} />
            ) : null}
            {(directive.retryCount ?? 0) > 0 ? (
              <MetaItem label="Retries" value={String(directive.retryCount)} />
            ) : null}
            {directive.createdBy ? (
              <MetaItem label="Created By" value={directive.createdBy} />
            ) : null}
          </View>

          {/* Dependencies */}
          {directive.dependsOn && directive.dependsOn.length > 0 ? (
            <View style={{ marginBottom: 12 }}>
              <Text
                style={{
                  color: "#525252",
                  fontSize: 11,
                  fontWeight: "600",
                  letterSpacing: 0.3,
                  marginBottom: 4,
                }}
              >
                Dependencies
              </Text>
              {directive.dependsOn.map((depId) => (
                <Text
                  key={depId}
                  style={{
                    color: "#737373",
                    fontSize: 12,
                    marginLeft: 8,
                    lineHeight: 20,
                  }}
                >
                  {depId}
                </Text>
              ))}
            </View>
          ) : null}

          {/* Full audit trail */}
          <AuditTrail entries={actLog} collapsed={false} />
        </View>
      ) : null}
    </Pressable>
  );
}
