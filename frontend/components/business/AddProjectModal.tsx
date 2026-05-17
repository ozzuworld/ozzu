import { useState } from "react";
import { View, Text, Modal, TextInput, Pressable, ScrollView } from "react-native";
import { createBusinessProject } from "../../lib/bridge-api";

import { colors } from "../../lib/design-tokens";
const EMOJI_OPTIONS = ["📁", "🚀", "💼", "🎯", "📊", "🛠", "🔬", "🎨", "📱", "🌐", "🤖", "💰"];
const COLOR_OPTIONS = [colors.accent, colors.success, colors.brand.amberDeep, colors.brand.orange, colors.error, colors.brand.purple, colors.brand.blue, "#EC4899"];

interface AddProjectModalProps {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function AddProjectModal({ visible, onClose, onCreated }: AddProjectModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [emoji, setEmoji] = useState("📁");
  const [color, setColor] = useState(colors.accent);
  const [saving, setSaving] = useState(false);

  const reset = () => { setName(""); setDescription(""); setEmoji("📁"); setColor(colors.accent); };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await createBusinessProject({ name: name.trim(), description: description.trim(), emoji, color });
      reset();
      onCreated();
      onClose();
    } catch (e) {
      // silently fail — toast would go here
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "center", padding: 24 }} onPress={onClose}>
        <Pressable onPress={() => {}} style={{ backgroundColor: colors.gray[800], borderRadius: 12, padding: 20 }}>
          <Text style={{ color: colors.accent, fontFamily: "monospace", fontSize: 14, fontWeight: "bold", letterSpacing: 2, marginBottom: 16 }}>
            NEW PROJECT
          </Text>

          <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 10, marginBottom: 4 }}>NAME</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Project name..."
            placeholderTextColor={colors.gray[400]}
            style={{ backgroundColor: colors.gray[850], color: colors.gray[50], borderRadius: 8, padding: 12, fontSize: 14, marginBottom: 12, borderWidth: 1, borderColor: colors.gray[700] }}
            autoFocus
          />

          <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 10, marginBottom: 4 }}>DESCRIPTION</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="Optional description..."
            placeholderTextColor={colors.gray[400]}
            multiline
            style={{ backgroundColor: colors.gray[850], color: colors.gray[50], borderRadius: 8, padding: 12, fontSize: 13, marginBottom: 12, minHeight: 60, borderWidth: 1, borderColor: colors.gray[700], textAlignVertical: "top" }}
          />

          <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>ICON</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
            <View style={{ flexDirection: "row", gap: 6 }}>
              {EMOJI_OPTIONS.map((e) => (
                <Pressable key={e} onPress={() => setEmoji(e)}
                  style={{ width: 36, height: 36, borderRadius: 8, backgroundColor: emoji === e ? colors.gray[700] : "transparent", alignItems: "center", justifyContent: "center", borderWidth: emoji === e ? 1 : 0, borderColor: colors.accent }}>
                  <Text style={{ fontSize: 18 }}>{e}</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>

          <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>COLOR</Text>
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 20 }}>
            {COLOR_OPTIONS.map((c) => (
              <Pressable key={c} onPress={() => setColor(c)}
                style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c, borderWidth: color === c ? 2 : 0, borderColor: "#FFF" }} />
            ))}
          </View>

          <View style={{ flexDirection: "row", gap: 10, justifyContent: "flex-end" }}>
            <Pressable onPress={onClose} style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
              <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 12 }}>CANCEL</Text>
            </Pressable>
            <Pressable
              onPress={handleCreate}
              disabled={!name.trim() || saving}
              style={{ backgroundColor: name.trim() ? colors.accent : colors.gray[700], paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 }}
            >
              <Text style={{ color: name.trim() ? colors.gray[850] : colors.gray[400], fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
                {saving ? "CREATING..." : "CREATE"}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
