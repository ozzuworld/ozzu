import { useState, useEffect, useCallback } from "react";
import { View, Text, Modal, ScrollView, Pressable, TextInput } from "react-native";
import { fetchBusinessContacts, updateBusinessContact, deleteBusinessContact, type BusinessContact } from "../../lib/bridge-api";

const ACCENT = "#06B6D4";
const CONTACT_TYPES = ["buyer", "supplier", "logistics", "broker", "other"] as const;

interface Props {
  contactId: number | null;
  visible: boolean;
  onClose: () => void;
  onRefresh: () => void;
}

export function ContactDetailSheet({ contactId, visible, onClose, onRefresh }: Props) {
  const [contact, setContact] = useState<BusinessContact | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [type, setType] = useState<string>("other");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("Colombia");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!contactId) return;
    try {
      const all = await fetchBusinessContacts();
      const c = all.find(x => x.id === contactId);
      if (c) {
        setContact(c);
        setName(c.name); setCompany(c.company || ""); setType(c.type);
        setEmail(c.email || ""); setPhone(c.phone || "");
        setCity(c.city || ""); setCountry(c.country || "Colombia");
        setNotes(c.notes || "");
      }
    } catch {}
  }, [contactId]);

  useEffect(() => { if (visible) { load(); setEditing(false); } }, [visible, load]);

  const save = async () => {
    if (!contactId) return;
    setSaving(true);
    try {
      await updateBusinessContact(contactId, { name, company, type, email, phone, city, country, notes } as any);
      setEditing(false);
      await load();
      onRefresh();
    } catch {} finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!contactId) return;
    try {
      await deleteBusinessContact(contactId);
      onRefresh();
      onClose();
    } catch {}
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: "#111111", borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "85%" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" }}>
            <Text style={{ color: "#E5E5E5", fontFamily: "monospace", fontSize: 15, fontWeight: "bold" }}>
              {contact?.name || "Contact"}
            </Text>
            <View style={{ flexDirection: "row", gap: 12 }}>
              {!editing && (
                <Pressable onPress={() => setEditing(true)}>
                  <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 12 }}>Edit</Text>
                </Pressable>
              )}
              <Pressable onPress={onClose}>
                <Text style={{ color: "#525252", fontSize: 22 }}>×</Text>
              </Pressable>
            </View>
          </View>

          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
            {editing ? (
              <>
                <FieldInput label="Name" value={name} onChangeText={setName} />
                <FieldInput label="Company" value={company} onChangeText={setCompany} />
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
                <FieldInput label="Email" value={email} onChangeText={setEmail} />
                <FieldInput label="Phone" value={phone} onChangeText={setPhone} />
                <FieldInput label="City" value={city} onChangeText={setCity} />
                <FieldInput label="Country" value={country} onChangeText={setCountry} />
                <FieldInput label="Notes" value={notes} onChangeText={setNotes} multiline />

                <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
                  <Pressable onPress={save} disabled={saving} style={{ flex: 1, backgroundColor: ACCENT, borderRadius: 10, padding: 14, alignItems: "center" }}>
                    <Text style={{ color: "#111", fontFamily: "monospace", fontSize: 13, fontWeight: "bold" }}>{saving ? "Saving..." : "SAVE"}</Text>
                  </Pressable>
                  <Pressable onPress={() => setEditing(false)} style={{ flex: 1, backgroundColor: "#1A1A1A", borderRadius: 10, padding: 14, alignItems: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.06)" }}>
                    <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 13 }}>CANCEL</Text>
                  </Pressable>
                </View>
              </>
            ) : contact ? (
              <>
                <View style={{ backgroundColor: "#1A1A1A", borderRadius: 10, padding: 14, marginBottom: 12 }}>
                  <DetailRow label="Company" value={contact.company} />
                  <DetailRow label="Type" value={contact.type} />
                  <DetailRow label="Email" value={contact.email} />
                  <DetailRow label="Phone" value={contact.phone} />
                  <DetailRow label="City" value={contact.city} />
                  <DetailRow label="Country" value={contact.country} />
                  <DetailRow label="Currency" value={contact.currency} />
                </View>
                {contact.notes && (
                  <View style={{ backgroundColor: "#1A1A1A", borderRadius: 10, padding: 14, marginBottom: 12 }}>
                    <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9, letterSpacing: 2, marginBottom: 6 }}>NOTES</Text>
                    <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 12 }}>{contact.notes}</Text>
                  </View>
                )}
                <Pressable onPress={handleDelete} style={{ backgroundColor: "#EF444422", borderRadius: 10, padding: 12, alignItems: "center", marginTop: 8 }}>
                  <Text style={{ color: "#EF4444", fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>DELETE CONTACT</Text>
                </Pressable>
              </>
            ) : (
              <Text style={{ color: "#525252", fontFamily: "monospace" }}>Loading...</Text>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 }}>
      <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 11 }}>{label}</Text>
      <Text style={{ color: "#E5E5E5", fontFamily: "monospace", fontSize: 11, textTransform: label === "Type" ? "uppercase" : "none" }}>{value}</Text>
    </View>
  );
}

function FieldInput({ label, value, onChangeText, multiline, placeholder }: { label: string; value: string; onChangeText: (v: string) => void; multiline?: boolean; placeholder?: string }) {
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
