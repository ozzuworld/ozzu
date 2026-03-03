import { useState } from "react";
import { View, Text, Modal, ScrollView, Pressable, TextInput } from "react-native";
import { createBusinessInvoice } from "../../lib/bridge-api";
import { useContacts } from "../../lib/business-hooks";

const ACCENT = "#06B6D4";
const CURRENCIES = ["USD", "COP", "JPY"];

interface Props {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
  shipmentId?: number;
  prefillAmount?: number;
  prefillCurrency?: string;
  prefillContactId?: number;
}

export function AddInvoiceModal({ visible, onClose, onCreated, shipmentId, prefillAmount, prefillCurrency, prefillContactId }: Props) {
  const { contacts } = useContacts();
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [amount, setAmount] = useState(prefillAmount ? String(prefillAmount) : "");
  const [currency, setCurrency] = useState(prefillCurrency || "USD");
  const [contactId, setContactId] = useState<number | null>(prefillContactId || null);
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    const amt = parseFloat(amount);
    if (!amt) return;
    setSaving(true);
    try {
      await createBusinessInvoice({
        shipment_id: shipmentId || undefined,
        contact_id: contactId || undefined,
        invoice_number: invoiceNumber || undefined,
        amount: amt,
        currency,
        issue_date: new Date().toISOString().split("T")[0],
        due_date: dueDate || undefined,
        notes: notes || undefined,
      } as any);
      onCreated();
      onClose();
      setInvoiceNumber(""); setAmount(""); setContactId(null); setDueDate(""); setNotes("");
    } catch {} finally { setSaving(false); }
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: "#111111", borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "85%" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" }}>
            <Text style={{ color: "#E5E5E5", fontFamily: "monospace", fontSize: 14, fontWeight: "bold" }}>New Invoice</Text>
            <Pressable onPress={onClose}><Text style={{ color: "#525252", fontSize: 22 }}>×</Text></Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
            <FieldInput label="Invoice #" value={invoiceNumber} onChangeText={setInvoiceNumber} placeholder="INV-001" />
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

            {contacts.length > 0 && (
              <>
                <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>CONTACT</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
                  <View style={{ flexDirection: "row", gap: 6 }}>
                    {contacts.map(c => (
                      <Pressable key={c.id} onPress={() => setContactId(c.id)} style={{
                        paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6,
                        backgroundColor: contactId === c.id ? ACCENT + "22" : "#1A1A1A",
                        borderWidth: 1, borderColor: contactId === c.id ? ACCENT + "44" : "rgba(255,255,255,0.06)",
                      }}>
                        <Text style={{ color: contactId === c.id ? ACCENT : "#737373", fontFamily: "monospace", fontSize: 10 }}>{c.name}</Text>
                      </Pressable>
                    ))}
                  </View>
                </ScrollView>
              </>
            )}

            <FieldInput label="Due Date" value={dueDate} onChangeText={setDueDate} placeholder="YYYY-MM-DD" />
            <FieldInput label="Notes" value={notes} onChangeText={setNotes} multiline placeholder="Invoice notes..." />

            <Pressable
              onPress={handleCreate} disabled={saving || !amount}
              style={{
                backgroundColor: amount ? ACCENT : "#333", borderRadius: 10, padding: 14, alignItems: "center", marginTop: 8,
                opacity: amount ? 1 : 0.5,
              }}
            >
              <Text style={{ color: "#111", fontFamily: "monospace", fontSize: 13, fontWeight: "bold" }}>{saving ? "Creating..." : "CREATE INVOICE"}</Text>
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
