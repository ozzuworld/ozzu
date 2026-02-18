import { useState, useCallback } from "react";
import { View, Text, Pressable, LayoutAnimation } from "react-native";
import { ACTOR_COLORS, AUDIT_TYPE_EMOJIS, relativeTime } from "../../lib/directive-constants";

interface ActivityEntry {
  timestamp: number;
  type: string;
  actor?: string;
  message: string;
}

function ActorBadge({ actor }: { actor?: string }) {
  if (!actor) return null;
  const color = ACTOR_COLORS[actor] || "#9CA3AF";
  return (
    <Text
      style={{
        color,
        fontSize: 9,
        fontFamily: "monospace",
        fontWeight: "bold",
        backgroundColor: `${color}18`,
        borderWidth: 1,
        borderColor: `${color}33`,
        paddingHorizontal: 5,
        paddingVertical: 1,
        borderRadius: 3,
        overflow: "hidden",
      }}
    >
      {actor}
    </Text>
  );
}

interface AuditTrailProps {
  entries: ActivityEntry[];
  collapsed?: boolean;
  maxCollapsed?: number;
}

export function AuditTrail({ entries, collapsed = true, maxCollapsed = 3 }: AuditTrailProps) {
  const [expanded, setExpanded] = useState(!collapsed);

  const toggle = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((p) => !p);
  }, []);

  if (entries.length === 0) return null;

  const shown = expanded ? entries : entries.slice(-maxCollapsed).reverse();

  return (
    <View style={{ marginTop: 8 }}>
      <Pressable
        onPress={toggle}
        style={{ flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 4 }}
      >
        <Text style={{ fontSize: 11 }}>📜</Text>
        <Text
          style={{
            color: "#525252",
            fontSize: 10,
            fontFamily: "monospace",
            fontWeight: "bold",
            letterSpacing: 1,
          }}
        >
          AUDIT TRAIL ({entries.length})
        </Text>
        <Text style={{ color: "#3B82F6", fontSize: 10, fontFamily: "monospace" }}>
          {expanded ? "▲" : "▼"}
        </Text>
      </Pressable>
      {shown.map((entry, i) => {
        const emoji = AUDIT_TYPE_EMOJIS[entry.type] || "•";
        return (
          <View
            key={expanded ? i : `c-${i}`}
            style={{
              flexDirection: "row",
              gap: 5,
              marginLeft: 4,
              marginBottom: 3,
              alignItems: "baseline",
            }}
          >
            <Text style={{ fontSize: 9 }}>{emoji}</Text>
            <Text
              style={{
                color: "#3A3A3A",
                fontSize: 9,
                fontFamily: "monospace",
                minWidth: 48,
              }}
            >
              {relativeTime(entry.timestamp)}
            </Text>
            {entry.actor ? <ActorBadge actor={entry.actor} /> : null}
            <Text
              style={{
                color: "#666",
                fontSize: 9,
                fontFamily: "monospace",
                flex: 1,
              }}
              numberOfLines={expanded ? undefined : 1}
            >
              {entry.message}
            </Text>
          </View>
        );
      })}
      {!expanded && entries.length > maxCollapsed ? (
        <Pressable onPress={toggle}>
          <Text
            style={{
              color: "#3B82F6",
              fontSize: 9,
              fontFamily: "monospace",
              marginTop: 2,
              marginLeft: 4,
            }}
          >
            +{entries.length - maxCollapsed} more entries ▼
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
