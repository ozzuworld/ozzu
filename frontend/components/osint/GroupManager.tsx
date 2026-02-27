import { useState } from "react";
import { View, Text, Pressable, TextInput, ScrollView } from "react-native";
import {
  createOsintGroup,
  deleteOsintGroup,
  assignProfileToGroup,
  type OsintGroup,
  type OsintProfile,
} from "../../lib/bridge-api";
import { PROFILE_TYPE_EMOJI } from "../../lib/osint-constants";

interface Props {
  groups: OsintGroup[];
  profiles: OsintProfile[];
  selectedGroupId: number | null;
  onSelectGroup: (id: number | null) => void;
  onRefresh: () => void;
}

const EMOJIS = ["👪", "🏠", "💼", "🎓", "🛡", "👤", "💑", "👨‍👩‍👧‍👦"];

export function GroupManager({ groups, profiles, selectedGroupId, onSelectGroup, onRefresh }: Props) {
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmoji, setNewEmoji] = useState("👪");
  const [creating, setCreating] = useState(false);
  const [showAssign, setShowAssign] = useState(false);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await createOsintGroup({ name: newName.trim(), emoji: newEmoji });
      setNewName("");
      setShowCreate(false);
      onRefresh();
    } catch (_) {}
    setCreating(false);
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteOsintGroup(id);
      if (selectedGroupId === id) onSelectGroup(null);
      onRefresh();
    } catch (_) {}
  };

  const handleAssign = async (profileId: number, groupId: number | null) => {
    try {
      await assignProfileToGroup(profileId, groupId);
      onRefresh();
    } catch (_) {}
  };

  return (
    <View>
      {/* Group pills */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
        <Pressable onPress={() => onSelectGroup(null)}>
          <View style={{
            backgroundColor: selectedGroupId === null ? "#06B6D4" : "#222",
            borderRadius: 16,
            paddingHorizontal: 12,
            paddingVertical: 6,
            marginRight: 6,
          }}>
            <Text style={{
              color: selectedGroupId === null ? "#000" : "#AAA",
              fontFamily: "monospace",
              fontSize: 11,
              fontWeight: selectedGroupId === null ? "700" : "400",
            }}>
              ALL
            </Text>
          </View>
        </Pressable>

        {groups.map((g) => (
          <Pressable key={g.id} onPress={() => onSelectGroup(g.id)} onLongPress={() => handleDelete(g.id)}>
            <View style={{
              backgroundColor: selectedGroupId === g.id ? "#06B6D4" : "#222",
              borderRadius: 16,
              paddingHorizontal: 12,
              paddingVertical: 6,
              marginRight: 6,
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
            }}>
              <Text style={{ fontSize: 12 }}>{g.emoji}</Text>
              <Text style={{
                color: selectedGroupId === g.id ? "#000" : "#AAA",
                fontFamily: "monospace",
                fontSize: 11,
                fontWeight: selectedGroupId === g.id ? "700" : "400",
              }}>
                {g.name.toUpperCase()} ({g.member_count})
              </Text>
            </View>
          </Pressable>
        ))}

        <Pressable onPress={() => setShowCreate(!showCreate)}>
          <View style={{
            backgroundColor: "#222",
            borderRadius: 16,
            paddingHorizontal: 12,
            paddingVertical: 6,
            marginRight: 6,
          }}>
            <Text style={{ color: "#06B6D4", fontFamily: "monospace", fontSize: 11 }}>+ GROUP</Text>
          </View>
        </Pressable>

        {selectedGroupId && (
          <Pressable onPress={() => setShowAssign(!showAssign)}>
            <View style={{
              backgroundColor: "#222",
              borderRadius: 16,
              paddingHorizontal: 12,
              paddingVertical: 6,
            }}>
              <Text style={{ color: "#A855F7", fontFamily: "monospace", fontSize: 11 }}>ASSIGN</Text>
            </View>
          </Pressable>
        )}
      </ScrollView>

      {/* Create form */}
      {showCreate && (
        <View style={{
          backgroundColor: "#1A1A1A",
          borderWidth: 1,
          borderColor: "#333",
          borderRadius: 8,
          padding: 10,
          marginBottom: 8,
        }}>
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
            {EMOJIS.map((e) => (
              <Pressable key={e} onPress={() => setNewEmoji(e)}>
                <Text style={{
                  fontSize: 18,
                  opacity: newEmoji === e ? 1 : 0.3,
                }}>{e}</Text>
              </Pressable>
            ))}
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder="Group name..."
              placeholderTextColor="#555"
              style={{
                flex: 1,
                backgroundColor: "#111",
                borderWidth: 1,
                borderColor: "#333",
                borderRadius: 6,
                color: "#FFF",
                fontFamily: "monospace",
                fontSize: 12,
                paddingHorizontal: 10,
                paddingVertical: 6,
              }}
            />
            <Pressable onPress={handleCreate} disabled={creating || !newName.trim()}>
              <View style={{
                backgroundColor: newName.trim() ? "#06B6D4" : "#333",
                borderRadius: 6,
                paddingHorizontal: 14,
                paddingVertical: 8,
              }}>
                <Text style={{ color: "#000", fontFamily: "monospace", fontSize: 11, fontWeight: "700" }}>
                  {creating ? "..." : "CREATE"}
                </Text>
              </View>
            </Pressable>
          </View>
        </View>
      )}

      {/* Assign profiles to group */}
      {showAssign && selectedGroupId && (
        <View style={{
          backgroundColor: "#1A1A1A",
          borderWidth: 1,
          borderColor: "#333",
          borderRadius: 8,
          padding: 10,
          marginBottom: 8,
        }}>
          <Text style={{ color: "#888", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>
            TAP TO ADD/REMOVE FROM GROUP
          </Text>
          {profiles.map((p) => {
            const inGroup = (p as any).group_id === selectedGroupId;
            return (
              <Pressable
                key={p.id}
                onPress={() => handleAssign(p.id, inGroup ? null : selectedGroupId)}
              >
                <View style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  paddingVertical: 4,
                }}>
                  <Text style={{ fontSize: 12 }}>{inGroup ? "✅" : "⬜"}</Text>
                  <Text style={{ fontSize: 12 }}>{PROFILE_TYPE_EMOJI[p.profile_type] || "📋"}</Text>
                  <Text style={{
                    color: inGroup ? "#FFF" : "#666",
                    fontFamily: "monospace",
                    fontSize: 11,
                  }}>
                    {p.label}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}
