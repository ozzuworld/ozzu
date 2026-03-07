import { useState, useEffect } from "react";
import { View, Text, Pressable, ScrollView, Modal, ActivityIndicator, Alert } from "react-native";
import { fetchOsintEntityNeighbors, createOsintProfile, triggerOsintScan, type OsintEntity, type OsintRelationship } from "../../lib/bridge-api";

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

const SCANNABLE_TYPES = new Set(["email", "username", "phone", "domain", "ip"]);

function confidenceColor(conf: number): string {
  if (conf >= 90) return "#22C55E";
  if (conf >= 70) return "#EAB308";
  if (conf >= 50) return "#F97316";
  return "#6B7280";
}

interface Props {
  entity: OsintEntity | null;
  visible: boolean;
  onClose: () => void;
  onRefresh?: () => void;
}

export function EntityDetailSheet({ entity, visible, onClose, onRefresh }: Props) {
  const [relationships, setRelationships] = useState<OsintRelationship[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (entity && visible) {
      setLoading(true);
      fetchOsintEntityNeighbors(entity.id)
        .then((data) => setRelationships(data.relationships || []))
        .catch(() => setRelationships([]))
        .finally(() => setLoading(false));
    }
  }, [entity, visible]);

  if (!entity) return null;

  const config = ENTITY_TYPE_CONFIG[entity.entity_type] || { color: "#6B7280", emoji: "?" };
  const canScan = SCANNABLE_TYPES.has(entity.entity_type);

  const handlePivotScan = async () => {
    if (!canScan) return;
    setScanning(true);
    try {
      const profile = await createOsintProfile({
        label: entity.label || entity.value,
        profileType: entity.entity_type,
        value: entity.value,
        tags: ["pivot"],
      });
      if (profile?.id) {
        await triggerOsintScan(profile.id);
        Alert.alert("Scan Started", `Scanning ${entity.value} as a new ${entity.entity_type} profile.`);
        onRefresh?.();
      }
    } catch (err: any) {
      if (err.message?.includes("duplicate") || err.message?.includes("409")) {
        Alert.alert("Already Exists", "A profile for this entity already exists.");
      } else {
        Alert.alert("Error", err.message);
      }
    } finally {
      setScanning(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" }}>
        <Pressable onPress={() => {}} style={{ backgroundColor: "#111111", borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: "70%", borderWidth: 1, borderColor: "#222" }}>
          {/* Header */}
          <View style={{ flexDirection: "row", alignItems: "center", padding: 16, borderBottomWidth: 1, borderBottomColor: "#222", gap: 10 }}>
            <Text style={{ fontSize: 24 }}>{config.emoji}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: config.color, fontSize: 13, fontFamily: "monospace", fontWeight: "bold" }}>
                {entity.entity_type.toUpperCase().replace("_", " ")}
              </Text>
              <Text style={{ color: "#E5E5E5", fontSize: 12, fontFamily: "monospace" }} numberOfLines={2}>
                {entity.label || entity.value}
              </Text>
              {entity.label && entity.label !== entity.value && (
                <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace" }} numberOfLines={1}>{entity.value}</Text>
              )}
            </View>
            <Pressable onPress={onClose} style={{ padding: 4 }}>
              <Text style={{ color: "#525252", fontSize: 16 }}>✕</Text>
            </Pressable>
          </View>

          <ScrollView style={{ paddingHorizontal: 16, paddingBottom: 20, maxHeight: 400 }}>
            {/* Pivot scan button */}
            {canScan && (
              <Pressable
                onPress={handlePivotScan}
                disabled={scanning}
                style={{
                  backgroundColor: "#0A2540",
                  borderWidth: 1,
                  borderColor: "#06B6D4",
                  borderRadius: 8,
                  padding: 12,
                  marginVertical: 12,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  opacity: scanning ? 0.5 : 1,
                }}
              >
                {scanning ? (
                  <ActivityIndicator size="small" color="#06B6D4" />
                ) : (
                  <Text style={{ fontSize: 16 }}>🔍</Text>
                )}
                <Text style={{ color: "#06B6D4", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>
                  {scanning ? "SCANNING..." : `SCAN THIS ${entity.entity_type.toUpperCase()}`}
                </Text>
              </Pressable>
            )}

            {/* Metadata */}
            {entity.source_module && (
              <View style={{ flexDirection: "row", gap: 6, marginBottom: 8 }}>
                <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace" }}>SOURCE:</Text>
                <Text style={{ color: "#737373", fontSize: 10, fontFamily: "monospace" }}>{entity.source_module}</Text>
              </View>
            )}

            {/* Relationships */}
            <Text style={{ color: "#06B6D4", fontSize: 11, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 2, marginTop: 12, marginBottom: 8 }}>
              RELATIONSHIPS ({relationships.length})
            </Text>

            {loading ? (
              <ActivityIndicator color="#06B6D4" style={{ paddingVertical: 20 }} />
            ) : relationships.length === 0 ? (
              <Text style={{ color: "#404040", fontSize: 11, fontFamily: "monospace", paddingVertical: 10 }}>
                No relationships found for this entity.
              </Text>
            ) : (
              relationships.map((rel) => {
                const isSource = rel.source_entity_id === entity.id;
                const otherType = isSource ? (rel as any).target_type : (rel as any).source_type;
                const otherValue = isSource ? ((rel as any).target_label || (rel as any).target_value) : ((rel as any).source_label || (rel as any).source_value);
                const otherConfig = ENTITY_TYPE_CONFIG[otherType || ""] || { color: "#6B7280", emoji: "?" };

                return (
                  <View key={rel.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: "#1A1A1A" }}>
                    <View style={{ backgroundColor: `${confidenceColor(rel.confidence)}20`, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                      <Text style={{ color: confidenceColor(rel.confidence), fontSize: 9, fontFamily: "monospace", fontWeight: "bold" }}>
                        {rel.relationship.toUpperCase()}
                      </Text>
                    </View>
                    <Text style={{ color: "#525252", fontSize: 10 }}>{isSource ? "→" : "←"}</Text>
                    <Text style={{ fontSize: 12 }}>{otherConfig.emoji}</Text>
                    <Text style={{ color: otherConfig.color, fontSize: 11, fontFamily: "monospace", flex: 1 }} numberOfLines={1}>
                      {otherValue || "?"}
                    </Text>
                    <Text style={{ color: confidenceColor(rel.confidence), fontSize: 10, fontFamily: "monospace" }}>{rel.confidence}%</Text>
                  </View>
                );
              })
            )}

            {/* Evidence */}
            {relationships.length > 0 && relationships[0].evidence && (
              <Text style={{ color: "#404040", fontSize: 9, fontFamily: "monospace", marginTop: 8, fontStyle: "italic" }}>
                {relationships[0].evidence}
              </Text>
            )}

            <View style={{ height: 30 }} />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
