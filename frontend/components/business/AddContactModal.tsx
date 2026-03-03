import { useState } from "react";
import { View, Text, Modal, ScrollView, Pressable, TextInput } from "react-native";
import { createBusinessContact } from "../../lib/bridge-api";

const ACCENT = "#06B6D4";
const CONTACT_TYPES = ["buyer", "supplier", "logistics", "broker", "other"] as const;

interface Props {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function AddContactModal({ visible, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [type, setType] = useState<string>("buyer");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("Colombia");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await createBusinessContact({ name, company, type, email, phone, city, country, notes } as any);
      onCreated();
      onClose();
      setName(""); setCompany(""); setType("buyer"); setEmail(""); setPhone(""); setCity(""); setCountry("Colombia"); setNotes("");
    } catch {} finally { setSaving(false); }
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: "#111111", borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "85%" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" }}>
            <Text style={{ color: "#E5E5E5", fontFamily: "monospace", fontSize: 14, fontWeight: "bold" }}>New Contact</Text>
            <Pressable onPress={onClose}><Text style={{ color: "#525252", fontSize: 22 }}>×</Text></Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
            <FieldInput label="Name" value={name} onChangeText={setName} placeholder="Contact name" />
            <FieldInput label="Company" value={company} onChangeText={setCompany} placeholder="Company name" />

            <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>TYPE</Text>
            <View style={{ flexDirection: "row", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
              {CONTACT_TYPES.map(t => (
                <Pressable key={t} onPress={() => setType(t)} style={{
                  paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6,
                  backgroundColor: type === t ? ACCENT + "22" : "#1A1A1A",
                  borderWidth: 1, borderColor: type === t ? ACCENT + "44" : "rgba(255,255,255,0.06)",
                }}>
                  <Text style={{ color: type === t ? ACCENT : "#737373", fontFamily: "monospace", fontSize: 10, textTransform: "uppercase" }}>{t}</Text>
                </Pressable>
              ))}
            </View>

            <FieldInput label="Email" value={email} onChangeText={setEmail} placeholder="email@example.com" />
            <FieldInput label="Phone" value={phone} onChangeText={setPhone} placeholder="+57..." />
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1 }}><FieldInput label="City" value={city} onChangeText={setCity} /></View>
              <View style={{ flex: 1 }}><FieldInput label="Country" value={country} onChangeText={setCountry} /></View>
            </View>
            <FieldInput label="Notes" value={notes} onChangeText={setNotes} multiline placeholder="Additional notes..." />

            <Pressable
              onPress={handleCreate}
              disabled={saving || !name.trim()}
              style={{
                backgroundColor: name.trim() ? ACCENT : "#333",
                borderRadius: 10, padding: 14, alignItems: "center", marginTop: 8,
                opacity: name.trim() ? 1 : 0.5,
              }}
            >
              <Text style={{ color: "#111", fontFamily: "monospace", fontSize: 13, fontWeight: "bold" }}>{saving ? "Creating..." : "CREATE CONTACT"}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function FieldInput({ label, value, onChangeText, placeholder, multiline }: { label: string; value: string; onChangeText: (v: string) => void; placeholder?: string; multiline?: boolean }) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>{label.toUpperCase()}</Text>
      <TextInput
        value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor="#404040" multiline={multiline}
        style={{ backgroundColor: "#1A1A1A", borderRadius: 8, padding: 12, color: "#E5E5E5", fontFamily: "monospace", fontSize: 13, borderWidth: 1, borderColor: "rgba(255,255,255,0.06)", minHeight: multiline ? 60 : undefined }}
      />
    </View>
  );
}
