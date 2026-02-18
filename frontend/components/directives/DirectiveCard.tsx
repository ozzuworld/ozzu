import { useState, useCallback } from "react";
import { View, Text, Pressable, LayoutAnimation } from "react-native";
import { BuildRunBadge } from "./BuildRunBadge";
import { AuditTrail } from "./AuditTrail";
import {
  STATUS_EMOJI,
  STATUS_COLORS,
  relativeTime,
  formatTimestamp,
  humanDuration,
  priorityLabel,
} from "../../lib/directive-constants";
import type { Directive, BuildStatus } from "../../lib/bridge-api";

// ── Subcomponents ──

function ActionButton({
  label,
  color,
  onPress,
}: {
  label: string;
  color: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: color,
        backgroundColor: `${color}15`,
      }}
    >
      <Text
        style={{
          color,
          fontSize: 11,
          fontFamily: "monospace",
          fontWeight: "bold",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ width: "48%", marginBottom: 2 }}>
      <Text
        style={{
          color: "#525252",
          fontSize: 9,
          fontFamily: "monospace",
          fontWeight: "bold",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </Text>
      <Text style={{ color: "#A3A3A3", fontSize: 11, fontFamily: "monospace" }}>
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
  const statusEmoji = STATUS_EMOJI[directive.status] || "•";
  const actLog = directive.activity_log || [];

  const toggle = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((prev) => !prev);
  }, []);

  return (
    <Pressable
      onPress={toggle}
      style={{
        backgroundColor: "#1A1A1A",
        borderRadius: 10,
        borderLeftWidth: 3,
        borderLeftColor: statusColor,
        borderWidth: 1,
        borderColor: "#2A2A2A",
        padding: 12,
        flex: isTabletLandscape ? 1 : undefined,
      }}
    >
      {/* Header row */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ fontSize: 14 }}>{directive.emoji || statusEmoji}</Text>
        <Text
          style={{
            flex: 1,
            color: "#E5E5E5",
            fontSize: 14,
            fontWeight: "600",
            fontFamily: "monospace",
          }}
          numberOfLines={expanded ? undefined : 1}
        >
          {directive.title}
        </Text>
        <Text style={{ color: "#3A3A3A", fontSize: 10, fontFamily: "monospace" }}>
          {expanded ? "▲" : "▶"}
        </Text>
      </View>

      {/* Meta row — clean single line */}
      <Text
        style={{
          color: "#737373",
          fontSize: 10,
          fontFamily: "monospace",
          marginTop: 4,
          marginLeft: 24,
        }}
        numberOfLines={1}
      >
        <Text style={{ color: "#06B6D4", fontWeight: "bold" }}>
          {directive.type?.toUpperCase() || "QUICK"}
        </Text>
        <Text style={{ color: "#525252" }}> · </Text>
        <Text
          style={{
            color:
              directive.priority <= 1
                ? "#EF4444"
                : directive.priority <= 2
                  ? "#F59E0B"
                  : "#737373",
            fontWeight: "bold",
          }}
        >
          {priorityLabel(directive.priority ?? 3)}
        </Text>
        {directive.createdBy ? (
          <>
            <Text style={{ color: "#525252" }}> · </Text>
            <Text style={{ color: "#9CA3AF" }}>{directive.createdBy}</Text>
          </>
        ) : null}
        <Text style={{ color: "#525252" }}> · </Text>
        <Text style={{ color: "#525252" }}>{relativeTime(directive.updatedAt)}</Text>
        {directive.duration ? (
          <>
            <Text style={{ color: "#525252" }}> · </Text>
            <Text style={{ color: "#525252" }}>{humanDuration(directive.duration)}</Text>
          </>
        ) : null}
      </Text>

      {/* Failure reason */}
      {directive.failureReason ? (
        <View
          style={{
            backgroundColor: "rgba(239,68,68,0.1)",
            borderWidth: 1,
            borderColor: "rgba(239,68,68,0.3)",
            borderRadius: 6,
            padding: 8,
            marginTop: 8,
          }}
        >
          <Text
            style={{
              color: "#FCA5A5",
              fontSize: 11,
              fontFamily: "monospace",
              lineHeight: 16,
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
            color: "#737373",
            fontSize: 11,
            fontFamily: "monospace",
            marginTop: 6,
            marginLeft: 24,
          }}
          numberOfLines={1}
        >
          {actLog[actLog.length - 1].message}
        </Text>
      ) : null}

      {/* Action buttons — shown when expanded */}
      {expanded ? (
        <View style={{ flexDirection: "row", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          {directive.status === "planned" ? (
            <>
              <ActionButton label="✅ Approve" color="#22C55E" onPress={() => onAction("approve", directive.id)} />
              <ActionButton label="❌ Deny" color="#EF4444" onPress={() => onAction("deny", directive.id)} />
            </>
          ) : null}
          {directive.status === "deploy_failed" ? (
            <>
              <ActionButton label="🔄 Retry Merge" color="#F59E0B" onPress={() => onAction("retry_merge", directive.id)} />
              <ActionButton label="🔄 Retry Full" color="#3B82F6" onPress={() => onAction("retry", directive.id)} />
            </>
          ) : null}
          {directive.status === "blocked" ? (
            <>
              <ActionButton label="🔓 Unblock" color="#A855F7" onPress={() => onAction("unblock", directive.id)} />
              <ActionButton label="🚫 Cancel" color="#EF4444" onPress={() => onAction("cancel", directive.id)} />
            </>
          ) : null}
          {["failed", "stale", "cancelled"].includes(directive.status) ? (
            <ActionButton label="🔄 Retry" color="#3B82F6" onPress={() => onAction("retry", directive.id)} />
          ) : null}
          {!["completed", "failed", "cancelled", "stale", "planned", "blocked", "deploy_failed"].includes(directive.status) ? (
            <ActionButton label="🚫 Cancel" color="#EF4444" onPress={() => onAction("cancel", directive.id)} />
          ) : null}

          {/* Plan review button for planned directives */}
          {directive.plan && onPlanReview ? (
            <ActionButton label="📄 Plan" color="#06B6D4" onPress={() => onPlanReview(directive)} />
          ) : null}

          {/* Status change button */}
          {onStatusChange ? (
            <ActionButton label="📝 Status" color="#A3A3A3" onPress={() => onStatusChange(directive)} />
          ) : null}
        </View>
      ) : null}


      {/* Expanded content */}
      {expanded ? (
        <View style={{ marginTop: 12, borderTopWidth: 1, borderTopColor: "#252525", paddingTop: 10 }}>
          {/* Description */}
          {directive.description ? (
            <Text
              style={{
                color: "#A3A3A3",
                fontSize: 12,
                fontFamily: "monospace",
                lineHeight: 18,
                marginBottom: 10,
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
                borderColor: "#333",
                borderRadius: 6,
                padding: 10,
                marginBottom: 10,
                backgroundColor: "#141414",
                maxHeight: 120,
                overflow: "hidden",
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 6 }}>
                <Text style={{ fontSize: 10 }}>📄</Text>
                <Text
                  style={{
                    color: "#06B6D4",
                    fontSize: 10,
                    fontFamily: "monospace",
                    fontWeight: "bold",
                    letterSpacing: 1,
                  }}
                >
                  PLAN
                </Text>
                <Text style={{ color: "#3B82F6", fontSize: 9, fontFamily: "monospace" }}>
                  Tap to review ▶
                </Text>
              </View>
              <Text
                style={{
                  color: "#A3A3A3",
                  fontSize: 11,
                  fontFamily: "monospace",
                  lineHeight: 16,
                }}
                numberOfLines={4}
              >
                {directive.plan}
              </Text>
            </Pressable>
          ) : null}

          {/* Metadata grid */}
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 4,
              marginBottom: 10,
            }}
          >
            <MetaItem label="🕒 Created" value={formatTimestamp(directive.createdAt)} />
            <MetaItem label="🕒 Updated" value={formatTimestamp(directive.updatedAt)} />
            {directive.startedAt ? (
              <MetaItem label="🚀 Started" value={formatTimestamp(directive.startedAt)} />
            ) : null}
            {directive.completedAt ? (
              <MetaItem label="🎉 Completed" value={formatTimestamp(directive.completedAt)} />
            ) : null}
            {directive.duration ? (
              <MetaItem label="⏱️ Duration" value={humanDuration(directive.duration)} />
            ) : null}
            {(directive.retryCount ?? 0) > 0 ? (
              <MetaItem label="🔄 Retries" value={String(directive.retryCount)} />
            ) : null}
            {directive.createdBy ? (
              <MetaItem label="👤 Created By" value={directive.createdBy} />
            ) : null}
          </View>

          {/* Dependencies */}
          {directive.dependsOn && directive.dependsOn.length > 0 ? (
            <View style={{ marginBottom: 10 }}>
              <Text
                style={{
                  color: "#525252",
                  fontSize: 10,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                  letterSpacing: 1,
                  marginBottom: 4,
                }}
              >
                🔗 DEPENDS ON
              </Text>
              {directive.dependsOn.map((depId) => (
                <Text
                  key={depId}
                  style={{
                    color: "#A3A3A3",
                    fontSize: 11,
                    fontFamily: "monospace",
                    marginLeft: 8,
                  }}
                >
                  • {depId}
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
