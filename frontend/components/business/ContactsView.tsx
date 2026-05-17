import { useState, useCallback } from "react";
import { View, Text, ScrollView, Pressable, RefreshControl } from "react-native";
import { useContacts } from "../../lib/business-hooks";
import { type BusinessContact } from "../../lib/bridge-api";
import { ContactDetailSheet } from "./ContactDetailSheet";
import { AddContactModal } from "./AddContactModal";

import { colors } from "../../lib/design-tokens";
const ACCENT = colors.accent;
const TYPES = [
  { key: undefined, label: "ALL" },
  { key: "buyer", label: "BUYERS" },
  { key: "supplier", label: "SUPPLIERS" },
  { key: "logistics", label: "LOGISTICS" },
  { key: "broker", label: "BROKERS" },
] as const;

const TYPE_COLORS: Record<string, string> = {
  buyer: colors.success,
  supplier: colors.brand.amber,
  logistics: colors.brand.blue,
  broker: "#8B5CF6",
  other: colors.gray[300],
};

const COUNTRY_FLAGS: Record<string, string> = {
  Colombia: "🇨🇴",
  Japan: "🇯🇵",
  "United States": "🇺🇸",
  Brazil: "🇧🇷",
  China: "🇨🇳",
  "South Korea": "🇰🇷",
};

export function ContactsView() {
  const [filterType, setFilterType] = useState<string | undefined>(undefined);
  const { contacts, loading, reload } = useContacts(filterType);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [addVisible, setAddVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);

  const openContact = (id: number) => { setSelectedId(id); setDetailVisible(true); };

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.gray[400]} />}
      >
        {/* Filter pills */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {TYPES.map((t) => (
              <Pressable
                key={t.label}
                onPress={() => setFilterType(t.key as string | undefined)}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 6,
                  borderRadius: 6,
                  backgroundColor: filterType === t.key ? ACCENT + "22" : colors.gray[800],
                  borderWidth: 1,
                  borderColor: filterType === t.key ? ACCENT + "44" : "rgba(255,255,255,0.06)",
                }}
              >
                <Text style={{ color: filterType === t.key ? ACCENT : colors.gray[300], fontFamily: "monospace", fontSize: 10, fontWeight: "bold" }}>
                  {t.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        {/* Add button */}
        <Pressable
          onPress={() => setAddVisible(true)}
          style={{
            backgroundColor: ACCENT + "15",
            borderRadius: 10,
            padding: 12,
            marginBottom: 16,
            borderWidth: 1,
            borderColor: ACCENT + "33",
            alignItems: "center",
          }}
        >
          <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>+ NEW CONTACT</Text>
        </Pressable>

        {/* Contact cards */}
        {contacts.map((c) => (
          <ContactCard key={c.id} contact={c} onPress={() => openContact(c.id)} />
        ))}

        {contacts.length === 0 && !loading && (
          <View style={{ alignItems: "center", paddingVertical: 40 }}>
            <Text style={{ fontSize: 40, marginBottom: 12 }}>👥</Text>
            <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 13 }}>No contacts yet</Text>
            <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 11, marginTop: 4 }}>Add buyers, suppliers & partners</Text>
          </View>
        )}
      </ScrollView>

      <ContactDetailSheet
        contactId={selectedId}
        visible={detailVisible}
        onClose={() => setDetailVisible(false)}
        onRefresh={reload}
      />
      <AddContactModal visible={addVisible} onClose={() => setAddVisible(false)} onCreated={reload} />
    </View>
  );
}

function ContactCard({ contact, onPress }: { contact: BusinessContact; onPress: () => void }) {
  const typeColor = TYPE_COLORS[contact.type] || colors.gray[300];
  const flag = COUNTRY_FLAGS[contact.country] || "🌍";

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? "#222" : colors.gray[800],
        borderRadius: 10,
        padding: 14,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.06)",
      })}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
          <Text style={{ fontSize: 16 }}>{flag}</Text>
          <Text style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 13, fontWeight: "bold", flex: 1 }} numberOfLines={1}>
            {contact.name}
          </Text>
        </View>
        <View style={{ backgroundColor: typeColor + "22", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 }}>
          <Text style={{ color: typeColor, fontFamily: "monospace", fontSize: 9, fontWeight: "bold", textTransform: "uppercase" }}>
            {contact.type}
          </Text>
        </View>
      </View>
      {contact.company && (
        <Text style={{ color: colors.gray[200], fontFamily: "monospace", fontSize: 11, marginLeft: 28 }}>{contact.company}</Text>
      )}
      <View style={{ flexDirection: "row", gap: 16, marginTop: 6, marginLeft: 28 }}>
        {contact.email && <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 10 }}>{contact.email}</Text>}
        {contact.phone && <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 10 }}>{contact.phone}</Text>}
      </View>
    </Pressable>
  );
}
