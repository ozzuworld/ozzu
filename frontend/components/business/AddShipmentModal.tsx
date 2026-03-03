import { useState } from "react";
import { View, Text, Modal, ScrollView, Pressable, TextInput } from "react-native";
import { useContacts } from "../../lib/business-hooks";
import { createBusinessShipment } from "../../lib/bridge-api";

const ACCENT = "#06B6D4";
const COFFEE_TYPES = ["Supremo", "Excelso", "Specialty", "Other"];
const CURRENCIES = ["USD", "COP", "JPY"];

interface Props {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function AddShipmentModal({ visible, onClose, onCreated }: Props) {
  const { contacts } = useContacts("buyer");
  const [reference, setReference] = useState("");
  const [coffeeType, setCoffeeType] = useState("Supremo");
  const [quantityKg, setQuantityKg] = useState("");
  const [bagsCount, setBagsCount] = useState("");
  const [pricePerKg, setPricePerKg] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [buyerId, setBuyerId] = useState<number | null>(null);
  const [originPort, setOriginPort] = useState("Buenaventura");
  const [destPort, setDestPort] = useState("Yokohama");
  const [shipDate, setShipDate] = useState("");
  const [eta, setEta] = useState("");
  const [saving, setSaving] = useState(false);

  const totalValue = (parseFloat(quantityKg) || 0) * (parseFloat(pricePerKg) || 0);

  const handleCreate = async () => {
    setSaving(true);
    try {
      await createBusinessShipment({
        reference: reference || undefined,
        coffee_type: coffeeType,
        quantity_kg: parseFloat(quantityKg) || undefined,
        bags_count: parseInt(bagsCount) || undefined,
        price_per_kg: parseFloat(pricePerKg) || undefined,
        total_value: totalValue || undefined,
        currency,
        buyer_contact_id: buyerId || undefined,
        origin_port: originPort,
        destination_port: destPort,
        ship_date: shipDate || undefined,
        estimated_arrival: eta || undefined,
      } as any);
      onCreated();
      onClose();
      // Reset
      setReference(""); setQuantityKg(""); setBagsCount(""); setPricePerKg("");
      setBuyerId(null); setShipDate(""); setEta("");
    } catch {} finally { setSaving(false); }
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: "#111111", borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "85%" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" }}>
            <Text style={{ color: "#E5E5E5", fontFamily: "monospace", fontSize: 14, fontWeight: "bold" }}>New Shipment</Text>
            <Pressable onPress={onClose}><Text style={{ color: "#525252", fontSize: 22 }}>×</Text></Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
            <FieldInput label="Reference #" value={reference} onChangeText={setReference} placeholder="SH-001" />

            {/* Coffee type pills */}
            <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>COFFEE TYPE</Text>
            <View style={{ flexDirection: "row", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
              {COFFEE_TYPES.map(t => (
                <Pressable key={t} onPress={() => setCoffeeType(t)} style={{
                  paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6,
                  backgroundColor: coffeeType === t ? ACCENT + "22" : "#1A1A1A",
                  borderWidth: 1, borderColor: coffeeType === t ? ACCENT + "44" : "rgba(255,255,255,0.06)",
                }}>
                  <Text style={{ color: coffeeType === t ? ACCENT : "#737373", fontFamily: "monospace", fontSize: 11 }}>{t}</Text>
                </Pressable>
              ))}
            </View>

            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1 }}><FieldInput label="Quantity (kg)" value={quantityKg} onChangeText={setQuantityKg} keyboardType="numeric" /></View>
              <View style={{ flex: 1 }}><FieldInput label="Bags" value={bagsCount} onChangeText={setBagsCount} keyboardType="numeric" /></View>
            </View>

            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1 }}><FieldInput label="Price/kg" value={pricePerKg} onChangeText={setPricePerKg} keyboardType="numeric" /></View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>CURRENCY</Text>
                <View style={{ flexDirection: "row", gap: 6, marginBottom: 16 }}>
                  {CURRENCIES.map(c => (
                    <Pressable key={c} onPress={() => setCurrency(c)} style={{
                      paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6,
                      backgroundColor: currency === c ? ACCENT + "22" : "#1A1A1A",
                      borderWidth: 1, borderColor: currency === c ? ACCENT + "44" : "rgba(255,255,255,0.06)",
                    }}>
                      <Text style={{ color: currency === c ? ACCENT : "#737373", fontFamily: "monospace", fontSize: 10 }}>{c}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            </View>

            {totalValue > 0 && (
              <View style={{ backgroundColor: "#1A1A1A", borderRadius: 8, padding: 12, marginBottom: 16 }}>
                <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9 }}>TOTAL VALUE</Text>
                <Text style={{ color: "#22C55E", fontFamily: "monospace", fontSize: 18, fontWeight: "bold" }}>${totalValue.toLocaleString()}</Text>
              </View>
            )}

            {/* Buyer selector */}
            {contacts.length > 0 && (
              <>
                <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>BUYER</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Pressable onPress={() => setBuyerId(null)} style={{
                      paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6,
                      backgroundColor: !buyerId ? ACCENT + "22" : "#1A1A1A",
                      borderWidth: 1, borderColor: !buyerId ? ACCENT + "44" : "rgba(255,255,255,0.06)",
                    }}>
                      <Text style={{ color: !buyerId ? ACCENT : "#737373", fontFamily: "monospace", fontSize: 11 }}>None</Text>
                    </Pressable>
                    {contacts.map(c => (
                      <Pressable key={c.id} onPress={() => setBuyerId(c.id)} style={{
                        paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6,
                        backgroundColor: buyerId === c.id ? ACCENT + "22" : "#1A1A1A",
                        borderWidth: 1, borderColor: buyerId === c.id ? ACCENT + "44" : "rgba(255,255,255,0.06)",
                      }}>
                        <Text style={{ color: buyerId === c.id ? ACCENT : "#737373", fontFamily: "monospace", fontSize: 11 }}>{c.name}</Text>
                      </Pressable>
                    ))}
                  </View>
                </ScrollView>
              </>
            )}

            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1 }}><FieldInput label="Origin Port" value={originPort} onChangeText={setOriginPort} /></View>
              <View style={{ flex: 1 }}><FieldInput label="Dest. Port" value={destPort} onChangeText={setDestPort} /></View>
            </View>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1 }}><FieldInput label="Ship Date" value={shipDate} onChangeText={setShipDate} placeholder="YYYY-MM-DD" /></View>
              <View style={{ flex: 1 }}><FieldInput label="ETA" value={eta} onChangeText={setEta} placeholder="YYYY-MM-DD" /></View>
            </View>

            <Pressable
              onPress={handleCreate}
              disabled={saving}
              style={{
                backgroundColor: ACCENT, borderRadius: 10, padding: 14, alignItems: "center", marginTop: 8,
              }}
            >
              <Text style={{ color: "#111", fontFamily: "monospace", fontSize: 13, fontWeight: "bold" }}>{saving ? "Creating..." : "CREATE SHIPMENT"}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function FieldInput({ label, value, onChangeText, placeholder, keyboardType }: { label: string; value: string; onChangeText: (v: string) => void; placeholder?: string; keyboardType?: any }) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>{label.toUpperCase()}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#404040"
        keyboardType={keyboardType}
        style={{ backgroundColor: "#1A1A1A", borderRadius: 8, padding: 12, color: "#E5E5E5", fontFamily: "monospace", fontSize: 13, borderWidth: 1, borderColor: "rgba(255,255,255,0.06)" }}
      />
    </View>
  );
}
