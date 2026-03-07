import { useState, useMemo } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator } from "react-native";

// Entity type colors and emojis
const ENTITY_TYPE_CONFIG: Record<string, { color: string; emoji: string }> = {
  person: { color: "#06B6D4", emoji: "👤" },
  email: { color: "#3B82F6", emoji: "📧" },
  username: { color: "#22C55E", emoji: "🏷" },
  phone: { color: "#A855F7", emoji: "📱" },
  domain: { color: "#8B5CF6", emoji: "🌐" },
  ip: { color: "#F97316", emoji: "🖥" },
  social_account: { color: "#F59E0B", emoji: "🔗" },
  organization: { color: "#EF4444", emoji: "🏢" },
  location: { color: "#10B981", emoji: "📍" },
  image: { color: "#EC4899", emoji: "🖼" },
};

const RELATIONSHIP_LABELS: Record<string, string> = {
  uses: "USES",
  owns: "OWNS",
  linked_to: "LINKED",
  associated_with: "ASSOC",
  hosted_on: "HOSTED",
  registered_to: "REG TO",
  member_of: "MEMBER",
  found_on: "FOUND ON",
  resolves_to: "RESOLVES",
  face_match: "FACE",
};

interface Entity {
  id: number;
  entity_type: string;
  value: string;
  label: string | null;
  metadata: Record<string, any>;
  source_module: string | null;
  profile_id: number | null;
  created_at: string;
}

interface Relationship {
  id: number;
  source_entity_id: number;
  target_entity_id: number;
  relationship: string;
  confidence: number;
  source_module: string | null;
  evidence: string | null;
  source_type?: string;
  source_value?: string;
  source_label?: string;
  target_type?: string;
  target_value?: string;
  target_label?: string;
}

interface Props {
  entities: Entity[];
  relationships: Relationship[];
  summary: {
    totalEntities: number;
    totalRelationships: number;
    entityTypes: Record<string, number>;
    relationshipTypes: Record<string, number>;
  } | null;
  loading: boolean;
  onEntityPress?: (entity: Entity) => void;
}

function confidenceColor(conf: number): string {
  if (conf >= 90) return "#22C55E";
  if (conf >= 70) return "#EAB308";
  if (conf >= 50) return "#F97316";
  return "#6B7280";
}

export function EntityGraph({ entities, relationships, summary, loading, onEntityPress }: Props) {
  const [expandedType, setExpandedType] = useState<string | null>(null);
  const [expandedEntity, setExpandedEntity] = useState<number | null>(null);

  // Group entities by type
  const grouped = useMemo(() => {
    const groups: Record<string, Entity[]> = {};
    for (const e of entities) {
      if (!groups[e.entity_type]) groups[e.entity_type] = [];
      groups[e.entity_type].push(e);
    }
    return groups;
  }, [entities]);

  // Build adjacency map for quick neighbor lookup
  const adjacency = useMemo(() => {
    const map: Record<number, Relationship[]> = {};
    for (const r of relationships) {
      if (!map[r.source_entity_id]) map[r.source_entity_id] = [];
      if (!map[r.target_entity_id]) map[r.target_entity_id] = [];
      map[r.source_entity_id].push(r);
      map[r.target_entity_id].push(r);
    }
    return map;
  }, [relationships]);

  if (loading) {
    return (
      <View style={{ padding: 40, alignItems: "center" }}>
        <ActivityIndicator color="#06B6D4" />
        <Text style={{ color: "#737373", fontSize: 11, fontFamily: "monospace", marginTop: 8 }}>Loading graph...</Text>
      </View>
    );
  }

  if (entities.length === 0) {
    return (
      <View style={{ padding: 40, alignItems: "center" }}>
        <Text style={{ fontSize: 32, marginBottom: 8 }}>🕸</Text>
        <Text style={{ color: "#737373", fontSize: 12, fontFamily: "monospace", textAlign: "center" }}>
          No entities yet. Run a scan to build the intelligence graph.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ gap: 12 }}>
      {/* Summary bar */}
      {summary && (
        <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 4 }}>
          <View style={{ flex: 1, backgroundColor: "#1A1A1A", borderRadius: 8, padding: 10, alignItems: "center" }}>
            <Text style={{ color: "#06B6D4", fontSize: 18, fontFamily: "monospace", fontWeight: "bold" }}>{summary.totalEntities}</Text>
            <Text style={{ color: "#525252", fontSize: 9, fontFamily: "monospace" }}>ENTITIES</Text>
          </View>
          <View style={{ flex: 1, backgroundColor: "#1A1A1A", borderRadius: 8, padding: 10, alignItems: "center" }}>
            <Text style={{ color: "#A855F7", fontSize: 18, fontFamily: "monospace", fontWeight: "bold" }}>{summary.totalRelationships}</Text>
            <Text style={{ color: "#525252", fontSize: 9, fontFamily: "monospace" }}>LINKS</Text>
          </View>
          <View style={{ flex: 1, backgroundColor: "#1A1A1A", borderRadius: 8, padding: 10, alignItems: "center" }}>
            <Text style={{ color: "#F59E0B", fontSize: 18, fontFamily: "monospace", fontWeight: "bold" }}>{Object.keys(summary.entityTypes).length}</Text>
            <Text style={{ color: "#525252", fontSize: 9, fontFamily: "monospace" }}>TYPES</Text>
          </View>
        </View>
      )}

      {/* Entity groups */}
      {Object.entries(grouped)
        .sort(([, a], [, b]) => b.length - a.length)
        .map(([type, typeEntities]) => {
          const config = ENTITY_TYPE_CONFIG[type] || { color: "#6B7280", emoji: "?" };
          const isExpanded = expandedType === type;

          return (
            <View key={type} style={{ backgroundColor: "#111111", borderRadius: 10, borderWidth: 1, borderColor: "#222" }}>
              {/* Type header */}
              <Pressable
                onPress={() => setExpandedType(isExpanded ? null : type)}
                style={{ flexDirection: "row", alignItems: "center", padding: 12, gap: 8 }}
              >
                <Text style={{ fontSize: 16 }}>{config.emoji}</Text>
                <Text style={{ color: config.color, fontSize: 12, fontFamily: "monospace", fontWeight: "bold", flex: 1 }}>
                  {type.toUpperCase().replace("_", " ")}
                </Text>
                <View style={{ backgroundColor: `${config.color}20`, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 }}>
                  <Text style={{ color: config.color, fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>{typeEntities.length}</Text>
                </View>
                <Text style={{ color: "#525252", fontSize: 10 }}>{isExpanded ? "▲" : "▼"}</Text>
              </Pressable>

              {/* Expanded entity list */}
              {isExpanded && (
                <View style={{ borderTopWidth: 1, borderTopColor: "#222" }}>
                  {typeEntities.map((entity) => {
                    const entityRels = adjacency[entity.id] || [];
                    const isEntityExpanded = expandedEntity === entity.id;

                    return (
                      <View key={entity.id}>
                        <Pressable
                          onPress={() => setExpandedEntity(isEntityExpanded ? null : entity.id)}
                          onLongPress={() => onEntityPress?.(entity)}
                          style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 10, gap: 8, borderBottomWidth: 1, borderBottomColor: "#1A1A1A" }}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={{ color: "#E5E5E5", fontSize: 12, fontFamily: "monospace" }} numberOfLines={1}>
                              {entity.label || entity.value}
                            </Text>
                            {entity.label && entity.label !== entity.value && (
                              <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace" }} numberOfLines={1}>{entity.value}</Text>
                            )}
                          </View>
                          {entityRels.length > 0 && (
                            <View style={{ backgroundColor: "#1A1A1A", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 }}>
                              <Text style={{ color: "#737373", fontSize: 9, fontFamily: "monospace" }}>{entityRels.length} links</Text>
                            </View>
                          )}
                        </Pressable>

                        {/* Expanded: show relationships */}
                        {isEntityExpanded && entityRels.length > 0 && (
                          <View style={{ backgroundColor: "#0A0A0A", paddingHorizontal: 16, paddingVertical: 8 }}>
                            {entityRels.map((rel) => {
                              const isSource = rel.source_entity_id === entity.id;
                              const otherType = isSource ? rel.target_type : rel.source_type;
                              const otherValue = isSource ? (rel.target_label || rel.target_value) : (rel.source_label || rel.source_value);
                              const otherConfig = ENTITY_TYPE_CONFIG[otherType || ""] || { color: "#6B7280", emoji: "?" };

                              return (
                                <View key={rel.id} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 }}>
                                  <View style={{ backgroundColor: `${confidenceColor(rel.confidence)}30`, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4 }}>
                                    <Text style={{ color: confidenceColor(rel.confidence), fontSize: 8, fontFamily: "monospace", fontWeight: "bold" }}>
                                      {RELATIONSHIP_LABELS[rel.relationship] || rel.relationship.toUpperCase()}
                                    </Text>
                                  </View>
                                  <Text style={{ color: "#525252", fontSize: 9 }}>{isSource ? "→" : "←"}</Text>
                                  <Text style={{ fontSize: 10 }}>{otherConfig.emoji}</Text>
                                  <Text style={{ color: otherConfig.color, fontSize: 10, fontFamily: "monospace", flex: 1 }} numberOfLines={1}>
                                    {otherValue || "?"}
                                  </Text>
                                  <Text style={{ color: confidenceColor(rel.confidence), fontSize: 9, fontFamily: "monospace" }}>{rel.confidence}%</Text>
                                </View>
                              );
                            })}
                            {entityRels[0]?.evidence && (
                              <Text style={{ color: "#404040", fontSize: 9, fontFamily: "monospace", marginTop: 4, fontStyle: "italic" }}>
                                {entityRels[0].evidence}
                              </Text>
                            )}
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          );
        })}
    </View>
  );
}
