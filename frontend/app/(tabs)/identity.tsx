import { useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  Alert,
  Modal,
  Image,
  ActivityIndicator,
  Platform,
} from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { apiFetch, getBridgeUrl } from "../../lib/bridge-api";
import HamburgerMenu from "../../components/HamburgerMenu";
import { GroupNav } from "../../components/GroupNav";
import { formatLongDate } from "../../lib/format";

import { colors } from "../../lib/design-tokens";
// ── Types ──────────────────────────────────────────────────────────────────
interface Visa {
  type: string;
  country: string;
  number: string;
  issued: string;
  expires: string;
  entries: string;
  status: "active" | "cancelled" | "expired";
  issued_at: string;
}

interface IdentityProfile {
  full_name: string;
  date_of_birth: string;
  place_of_birth: string;
  nationality: string;
  cedula: string;
  passport_number: string;
  passport_issued: string;
  passport_expires: string;
  passport_issuing_authority: string;
  visas: Visa[];
}

interface TravelEntry {
  id: number;
  event_date: string;
  country: string;
  city: string;
  port: string;
  direction: "entry" | "exit" | "transit" | "stamp";
  notes: string;
}

interface Document {
  id: number;
  doc_type: string;
  label: string;
  filename: string;
}

interface VaultData {
  profile: IdentityProfile | null;
  travelHistory: TravelEntry[];
  documents: Document[];
}

// ── Country flag helper ────────────────────────────────────────────────────
const FLAG: Record<string, string> = {
  Colombia: "🇨🇴", "United States": "🇺🇸", Spain: "🇪🇸", Turkey: "🇹🇷",
  Netherlands: "🇳🇱", Bahamas: "🇧🇸", Curaçao: "🇨🇼", Italy: "🇮🇹",
};

function countryFlag(country: string) {
  return FLAG[country] ?? "🌍";
}

const DIRECTION_LABEL: Record<string, string> = {
  entry: "→ Entry",
  exit: "← Exit",
  transit: "↔ Transit",
  stamp: "Stamp",
};

const DIRECTION_COLOR: Record<string, string> = {
  entry: colors.success,
  exit: colors.brand.orange,
  transit: "#a78bfa",
  stamp: colors.gray[250],
};

function daysUntil(dateStr?: string | null): number {
  if (!dateStr) return 9999;
  const t = new Date(dateStr).getTime();
  if (isNaN(t)) return 9999;
  return Math.floor((t - Date.now()) / 86400000);
}


// ── Document Viewer ────────────────────────────────────────────────────────
function DocumentModal({ doc, onClose }: { doc: Document | null; onClose: () => void }) {
  if (!doc) return null;
  const uri = `${getBridgeUrl()}/api/vault/documents/${doc.id}/image`;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBg}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>{doc.label}</Text>
          <Pressable onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeTxt}>✕</Text>
          </Pressable>
        </View>
        <Image source={{ uri }} style={styles.docImage} resizeMode="contain" />
      </View>
    </Modal>
  );
}

// ── Expiry badge ───────────────────────────────────────────────────────────
function ExpiryBadge({ dateStr, label }: { dateStr: string; label: string }) {
  const days = daysUntil(dateStr);
  const urgent = days < 180;
  const expired = days < 0;
  return (
    <View style={[styles.expiryBadge, urgent && styles.expiryUrgent]}>
      <Text style={styles.expiryLabel}>{label}</Text>
      <Text style={styles.expiryDate}>{formatLongDate(dateStr)}</Text>
      <Text style={[styles.expiryDays, expired && { color: colors.error }, urgent && !expired && { color: colors.brand.orange }]}>
        {expired ? "EXPIRED" : `${days}d remaining`}
      </Text>
    </View>
  );
}

// ── Main Screen ────────────────────────────────────────────────────────────
export default function IdentityScreen() {
  const [authenticated, setAuthenticated] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);
  const [data, setData] = useState<VaultData | null>(null);
  // Start loading=true so we never render the authenticated view with null data
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState<"overview" | "travel" | "documents">("overview");
  const [viewingDoc, setViewingDoc] = useState<Document | null>(null);

  // ── Face ID gate ──────────────────────────────────────────────────────
  const authenticate = useCallback(async () => {
    setAuthChecking(true);
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Face ID required to access Identity Vault",
        disableDeviceFallback: false,
        fallbackLabel: "Use Passcode",
      });
      setAuthenticated(result.success);
      if (!result.success) Alert.alert("Access Denied", "Biometric authentication required.");
    } catch (e: any) {
      Alert.alert("Error", e?.message ?? "Authentication unavailable.");
    } finally {
      setAuthChecking(false);
    }
  }, []);

  useEffect(() => { authenticate(); }, [authenticate]);

  // ── Load vault data once authenticated ───────────────────────────────
  useEffect(() => {
    if (!authenticated) return;
    setLoading(true);
    apiFetch("/api/vault/profile")
      .then((d) => { if (d?.ok) setData(d); })
      .catch(() => Alert.alert("Error", "Could not load identity vault."))
      .finally(() => setLoading(false));
  }, [authenticated]);

  // ── Lock screen ──────────────────────────────────────────────────────
  if (!authenticated) {
    return (
      <View style={styles.root}>
        <HamburgerMenu />
        <View style={styles.lockScreen}>
          {authChecking ? (
            <ActivityIndicator color="#a78bfa" size="large" />
          ) : (
            <>
              <Text style={styles.lockIcon}>🔒</Text>
              <Text style={styles.lockTitle}>Identity Vault</Text>
              <Text style={styles.lockSub}>Face ID required to access personal documents</Text>
              <Pressable style={styles.unlockBtn} onPress={authenticate}>
                <Text style={styles.unlockTxt}>Authenticate</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    );
  }

  const profile = data?.profile ?? null;
  const travelHistory: TravelEntry[] = data?.travelHistory ?? [];
  const documents: Document[] = data?.documents ?? [];
  const visas: Visa[] = Array.isArray(profile?.visas) ? profile!.visas : [];

  // ── Countries visited ─────────────────────────────────────────────────
  const countriesVisited = [...new Set(travelHistory.map((t) => t.country))];

  return (
    <View style={styles.root}>
      <HamburgerMenu />
      <DocumentModal doc={viewingDoc} onClose={() => setViewingDoc(null)} />

      <GroupNav group="me" />

      {/* ── Header ── */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerName}>{profile?.full_name ?? "…"}</Text>
          <Text style={styles.headerSub}>🇨🇴 Colombian · CC {profile?.cedula ?? "…"}</Text>
        </View>
        <Pressable
          onPress={() => setAuthenticated(false)}
          style={({ pressed }) => [
            styles.lockBtn,
            pressed && { opacity: 0.7, transform: [{ scale: 0.95 }] },
          ]}
        >
          <Text style={styles.lockBtnTxt}>🔒</Text>
        </Pressable>
      </View>

      {/* ── Expiry alerts ── */}
      {profile?.passport_expires ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.expiryRow}>
          <ExpiryBadge dateStr={profile.passport_expires} label="Passport" />
          {visas.filter((v) => v.status === "active").map((v, i) => (
            <ExpiryBadge key={i} dateStr={v.expires} label={v.type} />
          ))}
        </ScrollView>
      ) : null}

      {/* ── Section tabs ── */}
      <View style={styles.tabs}>
        {(["overview", "travel", "documents"] as const).map((s) => (
          <Pressable
            key={s}
            style={({ pressed }) => [
              styles.tab,
              section === s && styles.tabActive,
              pressed && { opacity: 0.7, transform: [{ scale: 0.98 }] },
            ]}
            onPress={() => setSection(s)}
          >
            <Text style={[styles.tabTxt, section === s && styles.tabTxtActive]}>
              {s === "overview" ? "📋 Profile" : s === "travel" ? "✈️ Travel" : "📄 Docs"}
            </Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator color="#a78bfa" style={{ marginTop: 40 }} />
      ) : (
        <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: 40 }}>

          {/* ── OVERVIEW ── */}
          {section === "overview" && profile && (
            <>
              <InfoCard title="Personal">
                <InfoRow label="Full Name" value={profile.full_name} />
                <InfoRow label="Date of Birth" value={formatLongDate(profile.date_of_birth)} />
                <InfoRow label="Place of Birth" value={profile.place_of_birth} />
                <InfoRow label="Nationality" value={profile.nationality} />
                <InfoRow label="Cédula" value={`CC ${profile.cedula}`} mono />
              </InfoCard>

              <InfoCard title="Passport">
                <InfoRow label="Number" value={profile.passport_number} mono />
                <InfoRow label="Issued" value={`${formatLongDate(profile.passport_issued)} · ${profile.passport_issuing_authority}`} />
                <InfoRow label="Expires" value={formatLongDate(profile.passport_expires)} urgent={daysUntil(profile.passport_expires) < 180} />
              </InfoCard>

              {visas.map((v, i) => (
                <InfoCard key={i} title={v.status === "cancelled" ? `${v.type} (Cancelled)` : v.type}>
                  <InfoRow label="Country" value={v.country} />
                  <InfoRow label="Control No." value={v.number} mono />
                  <InfoRow label="Issued" value={`${formatLongDate(v.issued)} · ${v.issued_at}`} />
                  <InfoRow label="Expires" value={formatLongDate(v.expires)} urgent={v.status === "active" && daysUntil(v.expires) < 180} />
                  <InfoRow label="Entries" value={`${v.entries} · ${v.status.toUpperCase()}`} />
                </InfoCard>
              ))}

              <InfoCard title={`Countries Visited (${countriesVisited.length})`} >
                <View style={styles.flagGrid}>
                  {countriesVisited.map((c) => (
                    <View key={c} style={styles.flagItem}>
                      <Text style={styles.flagEmoji}>{countryFlag(c)}</Text>
                      <Text style={styles.flagLabel}>{c}</Text>
                    </View>
                  ))}
                </View>
              </InfoCard>
            </>
          )}

          {/* ── TRAVEL HISTORY ── */}
          {section === "travel" && (
            <>
              <Text style={styles.sectionNote}>{travelHistory.length} stamp events · {countriesVisited.length} countries</Text>
              {travelHistory.map((t) => (
                <View key={t.id} style={styles.travelEntry}>
                  <View style={[styles.travelDot, { backgroundColor: DIRECTION_COLOR[t.direction] ?? colors.gray[250] }]} />
                  <View style={styles.travelBody}>
                    <View style={styles.travelTop}>
                      <Text style={styles.travelFlag}>{countryFlag(t.country)}</Text>
                      <Text style={styles.travelCountry}>{t.country}</Text>
                      {t.city ? <Text style={styles.travelCity}>{t.city}</Text> : null}
                      <View style={styles.spacer} />
                      <Text style={[styles.travelDir, { color: DIRECTION_COLOR[t.direction] ?? colors.gray[250] }]}>
                        {DIRECTION_LABEL[t.direction]}
                      </Text>
                    </View>
                    <Text style={styles.travelDate}>{formatLongDate(t.event_date)}</Text>
                    {t.port ? <Text style={styles.travelPort}>{t.port}</Text> : null}
                    {t.notes ? <Text style={styles.travelNotes}>{t.notes}</Text> : null}
                  </View>
                </View>
              ))}
            </>
          )}

          {/* ── DOCUMENTS ── */}
          {section === "documents" && (
            <>
              <Text style={styles.sectionNote}>Tap any document to view · Face ID required once per session</Text>
              {documents.map((doc) => (
                <Pressable
                  key={doc.id}
                  style={({ pressed }) => [
                    styles.docCard,
                    pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
                  ]}
                  onPress={() => setViewingDoc(doc)}
                >
                  <Text style={styles.docIcon}>{doc.doc_type === "passport_bio" ? "🛂" : doc.doc_type === "us_visa" ? "🇺🇸" : "📷"}</Text>
                  <View style={styles.docInfo}>
                    <Text style={styles.docLabel}>{doc.label}</Text>
                    <Text style={styles.docFilename}>{doc.filename}</Text>
                  </View>
                  <Text style={styles.docChevron}>›</Text>
                </Pressable>
              ))}
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────
function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

function InfoRow({ label, value, mono, urgent }: { label: string; value: string; mono?: boolean; urgent?: boolean }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, mono && styles.infoMono, urgent && { color: colors.brand.orange }]}>{value}</Text>
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0a0a0f" },
  lockScreen: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40 },
  lockIcon: { fontSize: 64, marginBottom: 16 },
  lockTitle: { fontSize: 24, fontWeight: "700", color: "#f1f5f9", marginBottom: 8 },
  lockSub: { fontSize: 14, color: "#64748b", textAlign: "center", marginBottom: 32 },
  unlockBtn: { backgroundColor: "#7c3aed", paddingHorizontal: 32, paddingVertical: 14, borderRadius: 12 },
  unlockTxt: { color: "#fff", fontWeight: "700", fontSize: 16 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 60, paddingBottom: 12 },
  headerName: { fontSize: 20, fontWeight: "700", color: "#f1f5f9" },
  headerSub: { fontSize: 13, color: colors.gray[250], marginTop: 2 },
  lockBtn: { padding: 8 },
  lockBtnTxt: { fontSize: 20 },
  expiryRow: { paddingHorizontal: 16, marginBottom: 4 },
  expiryBadge: { backgroundColor: "#1e293b", borderRadius: 10, padding: 12, marginRight: 10, minWidth: 140 },
  expiryUrgent: { borderWidth: 1, borderColor: colors.brand.orange },
  expiryLabel: { fontSize: 11, color: "#64748b", fontWeight: "600", textTransform: "uppercase", marginBottom: 2 },
  expiryDate: { fontSize: 14, color: "#f1f5f9", fontWeight: "600" },
  expiryDays: { fontSize: 12, color: colors.success, marginTop: 2 },
  tabs: { flexDirection: "row", paddingHorizontal: 16, marginVertical: 8 },
  tab: { flex: 1, paddingVertical: 10, alignItems: "center", borderRadius: 8, marginHorizontal: 3, backgroundColor: "#1e293b" },
  tabActive: { backgroundColor: "#4c1d95" },
  tabTxt: { color: "#64748b", fontWeight: "600", fontSize: 13 },
  tabTxtActive: { color: "#c4b5fd" },
  body: { flex: 1, paddingHorizontal: 16 },
  sectionNote: { fontSize: 12, color: "#475569", marginBottom: 12, textAlign: "center" },
  card: { backgroundColor: "#1e293b", borderRadius: 14, padding: 16, marginBottom: 14 },
  cardTitle: { fontSize: 13, fontWeight: "700", color: "#7c3aed", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 },
  infoRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 },
  infoLabel: { fontSize: 13, color: "#64748b", flex: 1 },
  infoValue: { fontSize: 13, color: "#e2e8f0", fontWeight: "500", flex: 2, textAlign: "right" },
  infoMono: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12 },
  flagGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  flagItem: { alignItems: "center", width: 72, marginBottom: 8 },
  flagEmoji: { fontSize: 28 },
  flagLabel: { fontSize: 11, color: colors.gray[250], textAlign: "center", marginTop: 2 },
  travelEntry: { flexDirection: "row", marginBottom: 12 },
  travelDot: { width: 10, height: 10, borderRadius: 5, marginTop: 5, marginRight: 12 },
  travelBody: { flex: 1, backgroundColor: "#1e293b", borderRadius: 10, padding: 12 },
  travelTop: { flexDirection: "row", alignItems: "center", marginBottom: 4 },
  travelFlag: { fontSize: 16, marginRight: 6 },
  travelCountry: { fontSize: 15, fontWeight: "700", color: "#f1f5f9" },
  travelCity: { fontSize: 12, color: colors.gray[250], marginLeft: 6 },
  spacer: { flex: 1 },
  travelDir: { fontSize: 12, fontWeight: "600" },
  travelDate: { fontSize: 12, color: "#64748b" },
  travelPort: { fontSize: 11, color: "#475569", marginTop: 2 },
  travelNotes: { fontSize: 12, color: colors.gray[250], marginTop: 4 },
  docCard: { flexDirection: "row", alignItems: "center", backgroundColor: "#1e293b", borderRadius: 12, padding: 16, marginBottom: 10 },
  docIcon: { fontSize: 28, marginRight: 14 },
  docInfo: { flex: 1 },
  docLabel: { fontSize: 14, fontWeight: "600", color: "#e2e8f0" },
  docFilename: { fontSize: 12, color: "#475569", marginTop: 2 },
  docChevron: { fontSize: 22, color: "#475569", marginLeft: 8 },
  modalBg: { flex: 1, backgroundColor: "#000" },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16, paddingTop: 56, backgroundColor: "#0a0a0f" },
  modalTitle: { fontSize: 16, fontWeight: "700", color: "#f1f5f9", flex: 1 },
  closeBtn: { padding: 8 },
  closeTxt: { color: colors.gray[250], fontSize: 18 },
  docImage: { flex: 1, width: "100%" },
});
