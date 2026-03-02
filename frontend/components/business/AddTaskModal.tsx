import { useState } from "react";
import { View, Text, Modal, TextInput, Pressable, ScrollView } from "react-native";
import { createBusinessTask } from "../../lib/bridge-api";

const PRIORITIES = [
  { value: "low", label: "LOW", color: "#3B82F6" },
  { value: "medium", label: "MED", color: "#F97316" },
  { value: "high", label: "HIGH", color: "#EF4444" },
] as const;

interface AddTaskModalProps {
  visible: boolean;
  projectId: number;
  existingPhases?: string[];
  onClose: () => void;
  onCreated: () => void;
}

export function AddTaskModal({ visible, projectId, existingPhases = [], onClose, onCreated }: AddTaskModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<string>("medium");
  const [phase, setPhase] = useState("");
  const [customPhase, setCustomPhase] = useState("");
  const [showCustomPhase, setShowCustomPhase] = useState(false);
  const [saving, setSaving] = useState(false);

  const reset = () => { setTitle(""); setDescription(""); setPriority("medium"); setPhase(""); setCustomPhase(""); setShowCustomPhase(false); };

  const handleCreate = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const finalPhase = showCustomPhase ? customPhase.trim() : phase;
      await createBusinessTask(projectId, {
        title: title.trim(),
        description: description.trim(),
        priority,
        phase: finalPhase,
      } as any);
      reset();
      onCreated();
      onClose();
    } catch (e) {
      // silently fail
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "center", padding: 24 }} onPress={onClose}>
        <Pressable onPress={() => {}} style={{ backgroundColor: "#1A1A1A", borderRadius: 12, padding: 20 }}>
          <Text style={{ color: "#06B6D4", fontFamily: "monospace", fontSize: 14, fontWeight: "bold", letterSpacing: 2, marginBottom: 16 }}>
            NEW TASK
          </Text>

          <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 4 }}>TITLE</Text>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Task title..."
            placeholderTextColor="#525252"
            style={{ backgroundColor: "#111", color: "#E5E5E5", borderRadius: 8, padding: 12, fontSize: 14, marginBottom: 12, borderWidth: 1, borderColor: "#2A2A2A" }}
            autoFocus
          />

          <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 4 }}>DESCRIPTION</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="Optional details..."
            placeholderTextColor="#525252"
            multiline
            style={{ backgroundColor: "#111", color: "#E5E5E5", borderRadius: 8, padding: 12, fontSize: 13, marginBottom: 12, minHeight: 50, borderWidth: 1, borderColor: "#2A2A2A", textAlignVertical: "top" }}
          />

          {/* Phase picker */}
          <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>PHASE</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
            <View style={{ flexDirection: "row", gap: 6 }}>
              {existingPhases.map((p) => (
                <Pressable
                  key={p}
                  onPress={() => { setPhase(p); setShowCustomPhase(false); }}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 5,
                    borderRadius: 6,
                    backgroundColor: phase === p && !showCustomPhase ? "#06B6D422" : "#111",
                    borderWidth: 1,
                    borderColor: phase === p && !showCustomPhase ? "#06B6D4" : "#2A2A2A",
                  }}
                >
                  <Text style={{
                    color: phase === p && !showCustomPhase ? "#06B6D4" : "#525252",
                    fontFamily: "monospace",
                    fontSize: 10,
                  }}>
                    {p}
                  </Text>
                </Pressable>
              ))}
              <Pressable
                onPress={() => { setShowCustomPhase(true); setPhase(""); }}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                  borderRadius: 6,
                  backgroundColor: showCustomPhase ? "#06B6D422" : "#111",
                  borderWidth: 1,
                  borderColor: showCustomPhase ? "#06B6D4" : "#2A2A2A",
                }}
              >
                <Text style={{ color: showCustomPhase ? "#06B6D4" : "#525252", fontFamily: "monospace", fontSize: 10 }}>
                  + New...
                </Text>
              </Pressable>
            </View>
          </ScrollView>
          {showCustomPhase ? (
            <TextInput
              value={customPhase}
              onChangeText={setCustomPhase}
              placeholder="Phase name..."
              placeholderTextColor="#525252"
              style={{ backgroundColor: "#111", color: "#E5E5E5", borderRadius: 8, padding: 10, fontSize: 12, marginBottom: 12, borderWidth: 1, borderColor: "#2A2A2A" }}
            />
          ) : null}

          <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>PRIORITY</Text>
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 20 }}>
            {PRIORITIES.map((p) => (
              <Pressable
                key={p.value}
                onPress={() => setPriority(p.value)}
                style={{
                  flex: 1,
                  paddingVertical: 8,
                  borderRadius: 6,
                  alignItems: "center",
                  backgroundColor: priority === p.value ? p.color + "22" : "#111",
                  borderWidth: 1,
                  borderColor: priority === p.value ? p.color : "#2A2A2A",
                }}
              >
                <Text style={{ color: priority === p.value ? p.color : "#525252", fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>
                  {p.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={{ flexDirection: "row", gap: 10, justifyContent: "flex-end" }}>
            <Pressable onPress={onClose} style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
              <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 12 }}>CANCEL</Text>
            </Pressable>
            <Pressable
              onPress={handleCreate}
              disabled={!title.trim() || saving}
              style={{ backgroundColor: title.trim() ? "#06B6D4" : "#2A2A2A", paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 }}
            >
              <Text style={{ color: title.trim() ? "#111" : "#525252", fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
                {saving ? "ADDING..." : "ADD TASK"}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
