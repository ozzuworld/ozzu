import { useState } from "react";
import { View, Text, Modal, ScrollView, Pressable, TextInput } from "react-native";
import { createBusinessInvestment } from "../../lib/bridge-api";

const ACCENT = "#06B6D4";
const CATEGORIES = ["equipment", "infrastructure", "inventory", "marketing", "certification", "logistics", "other"] as const;
const STATUSES = ["planned", "committed", "paid", "recovered"] as const;
const CURRENCIES = ["COP", "USD", "JPY"];

interface Props {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function AddInvestmentModal({ visible, onClose, onCreated }: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string>("other");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("COP");
  const [status, setStatus] = useState<string>("planned");
  const [investmentDate, setInvestmentDate] = useState("");
  const [roiNotes, setRoiNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (!title.trim() || !amount) return;
    setSaving(true);
    try {
      await createBusinessInvestment({
        title, description, category, amount: parseFloat(amount), currency, status,
        investment_date: investmentDate || undefined, roi_notes: roiNotes || undefined,
      } as any);
      onCreated();
      onClose();
      setTitle(""); setDescription(""); setCategory("other"); setAmount(""); setStatus("planned"); setInvestmentDate(""); setRoiNotes("");
    } catch {} finally { setSaving(false); }
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: "#111111", borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "85%" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" }}>
            <Text style={{ color: "#E5E5E5", fontFamily: "monospace", fontSize: 14, fontWeight: "bold" }}>New Investment</Text>
            <Pressable onPress={onClose}><Text style={{ color: "#525252", fontSize: 22 }}>×</Text></Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
            <FieldInput label="Title" value={title} onChangeText={setTitle} placeholder="Investment title" />
            <FieldInput label="Description" value={description} onChangeText={setDescription} multiline placeholder="What is this investment for?" />

            <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>CATEGORY</Text>
            <View style={{ flexDirection: "row", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
              {CATEGORIES.map(c => (
                <Pressable key={c} onPress={() => setCategory(c)} style={{
                  paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6,
                  backgroundColor: category === c ? ACCENT + "22" : "#1A1A1A",
                  borderWidth: 1, borderColor: category === c ? ACCENT + "44" : "rgba(255,255,255,0.06)",
                }}>
                  <Text style={{ color: category === c ? ACCENT : "#737373", fontFamily: "monospace", fontSize: 9, textTransform: "uppercase" }}>{c}</Text>
                </Pressable>
              ))}
            </View>

            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 2 }}><FieldInput label="Amount" value={amount} onChangeText={setAmount} keyboardType="numeric" /></View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>CURRENCY</Text>
                <View style={{ flexDirection: "row", gap: 4, marginBottom: 16 }}>
                  {CURRENCIES.map(c => (
                    <Pressable key={c} onPress={() => setCurrency(c)} style={{
                      paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6,
                      backgroundColor: currency === c ? ACCENT + "22" : "#1A1A1A",
                      borderWidth: 1, borderColor: currency === c ? ACCENT + "44" : "rgba(255,255,255,0.06)",
                    }}>
                      <Text style={{ color: currency === c ? ACCENT : "#737373", fontFamily: "monospace", fontSize: 9 }}>{c}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            </View>

            <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>STATUS</Text>
            <View style={{ flexDirection: "row", gap: 6, marginBottom: 16 }}>
              {STATUSES.map(s => (
                <Pressable key={s} onPress={() => setStatus(s)} style={{
                  paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6,
                  backgroundColor: status === s ? ACCENT + "22" : "#1A1A1A",
                  borderWidth: 1, borderColor: status === s ? ACCENT + "44" : "rgba(255,255,255,0.06)",
                }}>
                  <Text style={{ color: status === s ? ACCENT : "#737373", fontFamily: "monospace", fontSize: 10, textTransform: "uppercase" }}>{s}</Text>
                </Pressable>
              ))}
            </View>

            <FieldInput label="Investment Date" value={investmentDate} onChangeText={setInvestmentDate} placeholder="YYYY-MM-DD" />
            <FieldInput label="ROI Notes" value={roiNotes} onChangeText={setRoiNotes} multiline placeholder="Expected return, payback period..." />

            <Pressable
              onPress={handleCreate} disabled={saving || !title.trim() || !amount}
              style={{
                backgroundColor: (title.trim() && amount) ? ACCENT : "#333",
                borderRadius: 10, padding: 14, alignItems: "center", marginTop: 8,
                opacity: (title.trim() && amount) ? 1 : 0.5,
              }}
            >
              <Text style={{ color: "#111", fontFamily: "monospace", fontSize: 13, fontWeight: "bold" }}>{saving ? "Creating..." : "CREATE INVESTMENT"}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function FieldInput({ label, value, onChangeText, placeholder, keyboardType, multiline }: { label: string; value: string; onChangeText: (v: string) => void; placeholder?: string; keyboardType?: any; multiline?: boolean }) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>{label.toUpperCase()}</Text>
      <TextInput
        value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor="#404040" keyboardType={keyboardType} multiline={multiline}
        style={{ backgroundColor: "#1A1A1A", borderRadius: 8, padding: 12, color: "#E5E5E5", fontFamily: "monospace", fontSize: 13, borderWidth: 1, borderColor: "rgba(255,255,255,0.06)", minHeight: multiline ? 60 : undefined }}
      />
    </View>
  );
}
