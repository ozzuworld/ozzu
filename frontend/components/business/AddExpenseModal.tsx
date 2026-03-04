import { useState } from "react";
import { View, Text, Modal, TextInput, Pressable, ScrollView, Switch, Alert, ActivityIndicator } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { CostField } from "./CostField";
import { uploadTaskAttachment, extractReceipt } from "../../lib/bridge-api";

const CATEGORIES = [
  { value: "materials", label: "Materials", icon: "M" },
  { value: "labor", label: "Labor", icon: "L" },
  { value: "services", label: "Services", icon: "S" },
  { value: "equipment", label: "Equipment", icon: "E" },
  { value: "transport", label: "Transport", icon: "T" },
  { value: "permits", label: "Permits", icon: "P" },
  { value: "fees", label: "Fees", icon: "F" },
  { value: "other", label: "Other", icon: "O" },
] as const;

const PAYMENT_STATUSES = [
  { value: "pending", label: "PENDING", color: "#EAB308" },
  { value: "paid", label: "PAID", color: "#22C55E" },
  { value: "partial", label: "PARTIAL", color: "#F97316" },
  { value: "overdue", label: "OVERDUE", color: "#EF4444" },
] as const;

const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "transfer", label: "Transfer" },
  { value: "card", label: "Card" },
  { value: "credit", label: "Credit" },
  { value: "other", label: "Other" },
] as const;

interface AddExpenseModalProps {
  visible: boolean;
  taskId: number;
  onClose: () => void;
  onCreated: () => void;
  onAddExpense: (taskId: number, data: any) => Promise<any>;
  prefill?: { amount?: number; vendor?: string; date?: string; iva?: number; paymentMethod?: string };
}

export function AddExpenseModal({ visible, taskId, onClose, onCreated, onAddExpense, prefill }: AddExpenseModalProps) {
  const [amount, setAmount] = useState<number | null>(prefill?.amount || null);
  const [ivaAuto, setIvaAuto] = useState(true);
  const [ivaManual, setIvaManual] = useState<number | null>(prefill?.iva || null);
  const [category, setCategory] = useState("other");
  const [vendor, setVendor] = useState(prefill?.vendor || "");
  const [description, setDescription] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("pending");
  const [paymentMethod, setPaymentMethod] = useState<string | null>(prefill?.paymentMethod || null);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);

  const ivaAmount = ivaAuto && amount ? Math.round(amount * 19 / 119) : (ivaManual || 0);

  const reset = () => {
    setAmount(null); setIvaAuto(true); setIvaManual(null); setCategory("other");
    setVendor(""); setDescription(""); setPaymentStatus("pending"); setPaymentMethod(null);
  };

  const handleScanReceipt = async () => {
    Alert.alert("Scan Receipt", "Choose source", [
      { text: "Camera", onPress: () => scanFrom("camera") },
      { text: "Photo Library", onPress: () => scanFrom("library") },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const scanFrom = async (source: "camera" | "library") => {
    try {
      const opts: ImagePicker.ImagePickerOptions = { quality: 0.8, base64: true };
      const result = source === "camera"
        ? await ImagePicker.launchCameraAsync(opts)
        : await ImagePicker.launchImageLibraryAsync(opts);
      if (result.canceled || !result.assets?.[0]?.base64) return;

      setScanning(true);
      const asset = result.assets[0];
      const ext = asset.uri.split(".").pop() || "jpg";
      const fileName = `receipt_${Date.now()}.${ext}`;

      // Upload as attachment to the task
      const uploadResult = await uploadTaskAttachment(taskId, asset.base64, fileName, "image");
      const attachmentId = uploadResult.attachment.id;

      // Extract receipt data via Gemini
      const extractResult = await extractReceipt(attachmentId);
      if (extractResult.ok && extractResult.receiptData) {
        const rd = extractResult.receiptData;
        if (rd.total) setAmount(rd.total);
        if (rd.iva) { setIvaAuto(false); setIvaManual(rd.iva); }
        if (rd.vendor) setVendor(rd.vendor);
        if (rd.lineItems?.length) {
          setDescription(rd.lineItems.map((li: any) => `${li.description}: $${li.total}`).join("\n"));
        }
        Alert.alert("Receipt Scanned", "Fields auto-filled from receipt. Review and adjust before saving.");
      } else {
        Alert.alert("Scan Complete", "Could not extract data from this image. Fill in manually.");
      }
    } catch (err: any) {
      Alert.alert("Scan Failed", err.message);
    } finally {
      setScanning(false);
    }
  };

  const handleCreate = async () => {
    if (!amount) return;
    setSaving(true);
    try {
      await onAddExpense(taskId, {
        amount,
        iva_amount: ivaAmount,
        category,
        vendor: vendor.trim(),
        description: description.trim(),
        payment_status: paymentStatus,
        payment_method: paymentMethod,
      });
      reset();
      onCreated();
      onClose();
    } catch {
      // silent
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "center", padding: 20 }} onPress={onClose}>
        <Pressable onPress={() => {}} style={{ backgroundColor: "#1A1A1A", borderRadius: 12, maxHeight: "85%" }}>
          <ScrollView contentContainerStyle={{ padding: 20 }} showsVerticalScrollIndicator={false}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <Text style={{ color: "#06B6D4", fontFamily: "monospace", fontSize: 14, fontWeight: "bold", letterSpacing: 2 }}>
                NEW EXPENSE
              </Text>
              <Pressable
                onPress={handleScanReceipt}
                disabled={scanning}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  backgroundColor: "#06B6D422",
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: "#06B6D4",
                  opacity: scanning ? 0.5 : 1,
                }}
              >
                {scanning ? (
                  <ActivityIndicator size={12} color="#06B6D4" />
                ) : null}
                <Text style={{ color: "#06B6D4", fontFamily: "monospace", fontSize: 10, fontWeight: "bold" }}>
                  {scanning ? "SCANNING..." : "SCAN RECEIPT"}
                </Text>
              </Pressable>
            </View>

            {/* Amount */}
            <CostField value={amount} onChange={setAmount} label="AMOUNT (COP)" />

            {/* IVA */}
            <View style={{ marginTop: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10 }}>IVA 19% AUTO</Text>
                <Switch
                  value={ivaAuto}
                  onValueChange={setIvaAuto}
                  trackColor={{ false: "#2A2A2A", true: "#06B6D444" }}
                  thumbColor={ivaAuto ? "#06B6D4" : "#525252"}
                />
              </View>
              {!ivaAuto ? (
                <CostField value={ivaManual} onChange={setIvaManual} label="IVA MANUAL" />
              ) : amount ? (
                <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 10 }}>
                  IVA: ${Math.round(ivaAmount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}
                </Text>
              ) : null}
            </View>

            {/* Category */}
            <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginTop: 12, marginBottom: 6 }}>CATEGORY</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
              {CATEGORIES.map((c) => (
                <Pressable
                  key={c.value}
                  onPress={() => setCategory(c.value)}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 6,
                    backgroundColor: category === c.value ? "#06B6D422" : "#111",
                    borderWidth: 1,
                    borderColor: category === c.value ? "#06B6D4" : "#2A2A2A",
                  }}
                >
                  <Text style={{
                    color: category === c.value ? "#06B6D4" : "#525252",
                    fontFamily: "monospace",
                    fontSize: 10,
                  }}>
                    {c.icon} {c.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* Vendor */}
            <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 4 }}>VENDOR</Text>
            <TextInput
              value={vendor}
              onChangeText={setVendor}
              placeholder="Vendor name..."
              placeholderTextColor="#525252"
              style={{ backgroundColor: "#111", color: "#E5E5E5", borderRadius: 8, padding: 10, fontSize: 13, marginBottom: 12, borderWidth: 1, borderColor: "#2A2A2A" }}
            />

            {/* Description */}
            <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 4 }}>DESCRIPTION</Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="Optional details..."
              placeholderTextColor="#525252"
              multiline
              style={{ backgroundColor: "#111", color: "#E5E5E5", borderRadius: 8, padding: 10, fontSize: 13, marginBottom: 12, minHeight: 40, borderWidth: 1, borderColor: "#2A2A2A", textAlignVertical: "top" }}
            />

            {/* Payment Status */}
            <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>PAYMENT STATUS</Text>
            <View style={{ flexDirection: "row", gap: 6, marginBottom: 12 }}>
              {PAYMENT_STATUSES.map((s) => (
                <Pressable
                  key={s.value}
                  onPress={() => setPaymentStatus(s.value)}
                  style={{
                    flex: 1,
                    paddingVertical: 6,
                    borderRadius: 6,
                    alignItems: "center",
                    backgroundColor: paymentStatus === s.value ? s.color + "22" : "#111",
                    borderWidth: 1,
                    borderColor: paymentStatus === s.value ? s.color : "#2A2A2A",
                  }}
                >
                  <Text style={{ color: paymentStatus === s.value ? s.color : "#525252", fontFamily: "monospace", fontSize: 8, fontWeight: "bold" }}>
                    {s.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* Payment Method */}
            <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>PAYMENT METHOD</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
              <View style={{ flexDirection: "row", gap: 6 }}>
                {PAYMENT_METHODS.map((m) => (
                  <Pressable
                    key={m.value}
                    onPress={() => setPaymentMethod(paymentMethod === m.value ? null : m.value)}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                      borderRadius: 6,
                      backgroundColor: paymentMethod === m.value ? "#06B6D422" : "#111",
                      borderWidth: 1,
                      borderColor: paymentMethod === m.value ? "#06B6D4" : "#2A2A2A",
                    }}
                  >
                    <Text style={{ color: paymentMethod === m.value ? "#06B6D4" : "#525252", fontFamily: "monospace", fontSize: 10 }}>
                      {m.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>

            {/* Actions */}
            <View style={{ flexDirection: "row", gap: 10, justifyContent: "flex-end" }}>
              <Pressable onPress={onClose} style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
                <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 12 }}>CANCEL</Text>
              </Pressable>
              <Pressable
                onPress={handleCreate}
                disabled={!amount || saving}
                style={{ backgroundColor: amount ? "#06B6D4" : "#2A2A2A", paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 }}
              >
                <Text style={{ color: amount ? "#111" : "#525252", fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
                  {saving ? "ADDING..." : "ADD"}
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
