import { useState } from "react";
import { View, Text, Pressable, LayoutAnimation, Platform, UIManager, Linking } from "react-native";
import { updateOsintFinding, type OsintFinding } from "../../lib/bridge-api";
import {
  SEVERITY_EMOJI,
  SEVERITY_COLORS,
  CATEGORY_EMOJI,
  CATEGORY_LABELS,
  FINDING_STATUS_EMOJI,
} from "../../lib/osint-constants";

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface Props {
  finding: OsintFinding;
  onStatusChange: () => void;
}

export function FindingCard({ finding, onStatusChange }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [updating, setUpdating] = useState(false);

  const severityColor = SEVERITY_COLORS[finding.severity] || "#6B7280";
  const severityEmoji = SEVERITY_EMOJI[finding.severity] || "⚪";
  const categoryEmoji = CATEGORY_EMOJI[finding.category] || "🔍";
  const categoryLabel = CATEGORY_LABELS[finding.category] || finding.category.toUpperCase();
  const statusEmoji = FINDING_STATUS_EMOJI[finding.status] || "";

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(!expanded);
  };

  const handleStatusUpdate = async (newStatus: string) => {
    setUpdating(true);
    try {
      await updateOsintFinding(finding.id, newStatus);
      onStatusChange();
    } catch (err) {
      console.error("Failed to update finding:", err);
    } finally {
      setUpdating(false);
    }
  };

  const timeAgo = () => {
    const diff = Date.now() - new Date(finding.created_at).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  };

  return (
    <Pressable onPress={toggle}>
      <View
        style={{
          backgroundColor: "#1A1A1A",
          borderRadius: 10,
          borderLeftWidth: 3,
          borderLeftColor: severityColor,
          marginBottom: 8,
          overflow: "hidden",
        }}
      >
        {/* Collapsed header */}
        <View style={{ flexDirection: "row", alignItems: "center", padding: 12, gap: 8 }}>
          <Text style={{ fontSize: 16 }}>{severityEmoji}</Text>
          <Text
            style={{
              flex: 1,
              color: "#E5E5E5",
              fontSize: 13,
              fontFamily: "monospace",
              fontWeight: "600",
            }}
            numberOfLines={expanded ? undefined : 1}
          >
            {finding.title}
          </Text>
          <View
            style={{
              backgroundColor: "#252525",
              paddingHorizontal: 6,
              paddingVertical: 2,
              borderRadius: 4,
            }}
          >
            <Text style={{ color: "#9CA3AF", fontSize: 10, fontFamily: "monospace" }}>
              {categoryEmoji} {categoryLabel}
            </Text>
          </View>
          {finding.raw_data?.gps || finding.raw_data?.latitude || finding.raw_data?.coordinates ? (
            <View style={{ backgroundColor: "#1A1A0A", paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 }}>
              <Text style={{ color: "#F59E0B", fontSize: 9, fontFamily: "monospace", fontWeight: "bold" }}>📍 LOC</Text>
            </View>
          ) : null}
          <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace" }}>
            {timeAgo()}
          </Text>
          {finding.status !== "new" && (
            <Text style={{ fontSize: 12 }}>{statusEmoji}</Text>
          )}
        </View>

        {/* Expanded details */}
        {expanded && (
          <View style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
            {finding.description && (
              <Text
                style={{
                  color: "#A3A3A3",
                  fontSize: 12,
                  fontFamily: "monospace",
                  lineHeight: 18,
                  marginBottom: 8,
                }}
              >
                {finding.description}
              </Text>
            )}

            {finding.source_url && (
              <Pressable onPress={() => Linking.openURL(finding.source_url!)}>
                <Text
                  style={{
                    color: "#06B6D4",
                    fontSize: 11,
                    fontFamily: "monospace",
                    marginBottom: 8,
                  }}
                >
                  🔗 {finding.source_url}
                </Text>
              </Pressable>
            )}

            {finding.remediation && (
              <View
                style={{
                  backgroundColor: "#0F2318",
                  borderRadius: 6,
                  padding: 8,
                  marginBottom: 8,
                }}
              >
                <Text
                  style={{
                    color: "#4ADE80",
                    fontSize: 11,
                    fontFamily: "monospace",
                    lineHeight: 16,
                  }}
                >
                  💡 {finding.remediation}
                </Text>
              </View>
            )}

            {/* Status action buttons */}
            <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
              {finding.status === "new" && (
                <>
                  <StatusButton
                    label="👁 ACK"
                    onPress={() => handleStatusUpdate("acknowledged")}
                    disabled={updating}
                  />
                  <StatusButton
                    label="✅ FIXED"
                    onPress={() => handleStatusUpdate("remediated")}
                    disabled={updating}
                  />
                  <StatusButton
                    label="🚫 FALSE"
                    onPress={() => handleStatusUpdate("false_positive")}
                    disabled={updating}
                  />
                </>
              )}
              {finding.status === "acknowledged" && (
                <>
                  <StatusButton
                    label="✅ FIXED"
                    onPress={() => handleStatusUpdate("remediated")}
                    disabled={updating}
                  />
                  <StatusButton
                    label="🚫 FALSE"
                    onPress={() => handleStatusUpdate("false_positive")}
                    disabled={updating}
                  />
                </>
              )}
              {(finding.status === "remediated" || finding.status === "false_positive") && (
                <StatusButton
                  label="🆕 REOPEN"
                  onPress={() => handleStatusUpdate("new")}
                  disabled={updating}
                />
              )}
            </View>
          </View>
        )}
      </View>
    </Pressable>
  );
}

function StatusButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        backgroundColor: pressed ? "#333" : "#222",
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: "#333",
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Text style={{ color: "#D4D4D4", fontSize: 11, fontFamily: "monospace", fontWeight: "600" }}>
        {label}
      </Text>
    </Pressable>
  );
}
