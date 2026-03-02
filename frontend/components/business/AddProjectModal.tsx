import { useState } from "react";
import { View, Text, Modal, TextInput, Pressable, ScrollView } from "react-native";
import { createBusinessProject } from "../../lib/bridge-api";

const EMOJI_OPTIONS = ["📁", "🚀", "💼", "🎯", "📊", "🛠", "🔬", "🎨", "📱", "🌐", "🤖", "💰"];
const COLOR_OPTIONS = ["#06B6D4", "#22C55E", "#EAB308", "#F97316", "#EF4444", "#A855F7", "#3B82F6", "#EC4899"];

interface AddProjectModalProps {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function AddProjectModal({ visible, onClose, onCreated }: AddProjectModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [emoji, setEmoji] = useState("📁");
  const [color, setColor] = useState("#06B6D4");
  const [saving, setSaving] = useState(false);

  const reset = () => { setName(""); setDescription(""); setEmoji("📁"); setColor("#06B6D4"); };

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
        <Pressable onPress={() => {}} style={{ backgroundColor: "#1A1A1A", borderRadius: 12, padding: 20 }}>
          <Text style={{ color: "#06B6D4", fontFamily: "monospace", fontSize: 14, fontWeight: "bold", letterSpacing: 2, marginBottom: 16 }}>
            NEW PROJECT
          </Text>

          <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 4 }}>NAME</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Project name..."
            placeholderTextColor="#525252"
            style={{ backgroundColor: "#111", color: "#E5E5E5", borderRadius: 8, padding: 12, fontSize: 14, marginBottom: 12, borderWidth: 1, borderColor: "#2A2A2A" }}
            autoFocus
          />

          <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 4 }}>DESCRIPTION</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="Optional description..."
            placeholderTextColor="#525252"
            multiline
            style={{ backgroundColor: "#111", color: "#E5E5E5", borderRadius: 8, padding: 12, fontSize: 13, marginBottom: 12, minHeight: 60, borderWidth: 1, borderColor: "#2A2A2A", textAlignVertical: "top" }}
          />

          <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>ICON</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
            <View style={{ flexDirection: "row", gap: 6 }}>
              {EMOJI_OPTIONS.map((e) => (
                <Pressable key={e} onPress={() => setEmoji(e)}
                  style={{ width: 36, height: 36, borderRadius: 8, backgroundColor: emoji === e ? "#2A2A2A" : "transparent", alignItems: "center", justifyContent: "center", borderWidth: emoji === e ? 1 : 0, borderColor: "#06B6D4" }}>
                  <Text style={{ fontSize: 18 }}>{e}</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>

          <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>COLOR</Text>
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 20 }}>
            {COLOR_OPTIONS.map((c) => (
              <Pressable key={c} onPress={() => setColor(c)}
                style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c, borderWidth: color === c ? 2 : 0, borderColor: "#FFF" }} />
            ))}
          </View>

          <View style={{ flexDirection: "row", gap: 10, justifyContent: "flex-end" }}>
            <Pressable onPress={onClose} style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
              <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 12 }}>CANCEL</Text>
            </Pressable>
            <Pressable
              onPress={handleCreate}
              disabled={!name.trim() || saving}
              style={{ backgroundColor: name.trim() ? "#06B6D4" : "#2A2A2A", paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 }}
            >
              <Text style={{ color: name.trim() ? "#111" : "#525252", fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
                {saving ? "CREATING..." : "CREATE"}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
