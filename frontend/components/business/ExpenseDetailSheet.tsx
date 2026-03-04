import { useState, useEffect } from "react";
import { View, Text, Modal, ScrollView, Pressable, TextInput, Alert, ActivityIndicator } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { CostField, formatCOPDisplay } from "./CostField";
import type { BusinessExpense, ReceiptData } from "../../lib/bridge-api";
import { uploadTaskAttachment, extractReceipt } from "../../lib/bridge-api";

const CATEGORIES = ["materials", "labor", "services", "equipment", "transport", "permits", "fees", "other"] as const;
const PAYMENT_STATUSES = [
  { value: "pending", label: "PENDING", color: "#EAB308" },
  { value: "paid", label: "PAID", color: "#22C55E" },
  { value: "partial", label: "PARTIAL", color: "#F97316" },
  { value: "overdue", label: "OVERDUE", color: "#EF4444" },
] as const;

interface ExpenseDetailSheetProps {
  expense: BusinessExpense | null;
  visible: boolean;
  onClose: () => void;
  onSave: (expenseId: number, data: Partial<BusinessExpense>) => void;
  onDelete: (expense: BusinessExpense) => void;
  taskId?: number;
}

export function ExpenseDetailSheet({ expense, visible, onClose, onSave, onDelete, taskId }: ExpenseDetailSheetProps) {
  const [amount, setAmount] = useState<number | null>(null);
  const [ivaAmount, setIvaAmount] = useState<number | null>(null);
  const [category, setCategory] = useState("other");
  const [vendor, setVendor] = useState("");
  const [description, setDescription] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("pending");
  const [scanning, setScanning] = useState(false);
  const [scannedAttachmentId, setScannedAttachmentId] = useState<number | null>(null);
  const [scannedReceiptData, setScannedReceiptData] = useState<any>(null);

  useEffect(() => {
    if (expense) {
      setAmount(expense.amount);
      setIvaAmount(expense.iva_amount);
      setCategory(expense.category);
      setVendor(expense.vendor);
      setDescription(expense.description);
      setPaymentStatus(expense.payment_status);
      setScannedAttachmentId(null);
      setScannedReceiptData(null);
    }
  }, [expense?.id]);

  if (!expense) return null;

  const handleSave = () => {
    const data: Partial<BusinessExpense> = {
      amount: amount || expense.amount,
      iva_amount: ivaAmount || 0,
      category,
      vendor: vendor.trim(),
      description: description.trim(),
      payment_status: paymentStatus as any,
    };
    if (scannedAttachmentId) data.attachment_id = scannedAttachmentId;
    if (scannedReceiptData) data.receipt_data = scannedReceiptData;
    onSave(expense.id, data);
    onClose();
  };

  const handleDelete = () => {
    Alert.alert("Delete Expense", `Delete this ${formatCOPDisplay(expense.amount)} expense?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => { onDelete(expense); onClose(); } },
    ]);
  };

  const handleScanReceipt = () => {
    if (!taskId) return;
    Alert.alert("Scan Receipt", "Choose source", [
      { text: "Camera", onPress: () => scanFrom("camera") },
      { text: "Photo Library", onPress: () => scanFrom("library") },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const scanFrom = async (source: "camera" | "library") => {
    if (!taskId) return;
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

      const uploadResult = await uploadTaskAttachment(taskId, asset.base64, fileName, "image");
      setScannedAttachmentId(uploadResult.attachment.id);
      const extractResult = await extractReceipt(uploadResult.attachment.id);
      if (extractResult.ok && extractResult.receiptData) {
        const rd = extractResult.receiptData;
        setScannedReceiptData(rd);
        if (rd.total) setAmount(rd.total);
        if (rd.iva) setIvaAmount(rd.iva);
        if (rd.vendor) setVendor(rd.vendor);
        if (rd.lineItems?.length) {
          setDescription(rd.lineItems.map((li: any) => `${li.description}: $${li.total}`).join("\n"));
        }
        Alert.alert("Receipt Scanned", "Fields updated from receipt. Review and save.");
      } else {
        Alert.alert("Scan Complete", "Could not extract data from this image.");
      }
    } catch (err: any) {
      Alert.alert("Scan Failed", err.message);
    } finally {
      setScanning(false);
    }
  };

  const receiptData: ReceiptData | null = expense.receipt_data;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)" }}>
        <Pressable style={{ height: 120 }} onPress={onClose} />
        <View style={{ flex: 1, backgroundColor: "#111111", borderTopLeftRadius: 20, borderTopRightRadius: 20 }}>
          <Pressable onPress={onClose} style={{ alignItems: "center", paddingTop: 12, paddingBottom: 8 }}>
            <View style={{ width: 40, height: 4, backgroundColor: "#555", borderRadius: 2 }} />
          </Pressable>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <Text style={{ color: "#06B6D4", fontFamily: "monospace", fontSize: 14, fontWeight: "bold", letterSpacing: 2 }}>
                EXPENSE DETAIL
              </Text>
              <View style={{
                backgroundColor: (expense.verified || scannedReceiptData) ? "#22C55E22" : "#EAB30822",
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 4,
              }}>
                <Text style={{
                  color: (expense.verified || scannedReceiptData) ? "#22C55E" : "#EAB308",
                  fontFamily: "monospace",
                  fontSize: 9,
                  fontWeight: "bold",
                }}>
                  {(expense.verified || scannedReceiptData) ? "VERIFIED" : "UNVERIFIED"}
                </Text>
              </View>
            </View>

            {/* Amount */}
            <CostField value={amount} onChange={setAmount} label="AMOUNT (COP)" />

            {/* IVA */}
            <View style={{ marginTop: 12 }}>
              <CostField value={ivaAmount} onChange={setIvaAmount} label="IVA" />
            </View>

            {/* Category */}
            <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginTop: 12, marginBottom: 6 }}>CATEGORY</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
              {CATEGORIES.map((c) => (
                <Pressable
                  key={c}
                  onPress={() => setCategory(c)}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 5,
                    borderRadius: 6,
                    backgroundColor: category === c ? "#06B6D422" : "#1A1A1A",
                    borderWidth: 1,
                    borderColor: category === c ? "#06B6D4" : "#2A2A2A",
                  }}
                >
                  <Text style={{ color: category === c ? "#06B6D4" : "#525252", fontFamily: "monospace", fontSize: 10 }}>{c}</Text>
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
              style={{ backgroundColor: "#1A1A1A", color: "#E5E5E5", borderRadius: 8, padding: 10, fontSize: 13, marginBottom: 12, borderWidth: 1, borderColor: "#2A2A2A" }}
            />

            {/* Description */}
            <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 4 }}>DESCRIPTION</Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="Details..."
              placeholderTextColor="#525252"
              multiline
              style={{ backgroundColor: "#1A1A1A", color: "#E5E5E5", borderRadius: 8, padding: 10, fontSize: 13, marginBottom: 12, minHeight: 50, borderWidth: 1, borderColor: "#2A2A2A", textAlignVertical: "top" }}
            />

            {/* Payment status */}
            <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>PAYMENT STATUS</Text>
            <View style={{ flexDirection: "row", gap: 6, marginBottom: 16 }}>
              {PAYMENT_STATUSES.map((s) => (
                <Pressable
                  key={s.value}
                  onPress={() => setPaymentStatus(s.value)}
                  style={{
                    flex: 1,
                    paddingVertical: 6,
                    borderRadius: 6,
                    alignItems: "center",
                    backgroundColor: paymentStatus === s.value ? s.color + "22" : "#1A1A1A",
                    borderWidth: 1,
                    borderColor: paymentStatus === s.value ? s.color : "#2A2A2A",
                  }}
                >
                  <Text style={{ color: paymentStatus === s.value ? s.color : "#525252", fontFamily: "monospace", fontSize: 9, fontWeight: "bold" }}>
                    {s.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* Scan receipt button */}
            {taskId ? (
              <Pressable
                onPress={handleScanReceipt}
                disabled={scanning}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  backgroundColor: "#06B6D422",
                  paddingVertical: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: "#06B6D4",
                  marginBottom: 16,
                  opacity: scanning ? 0.5 : 1,
                }}
              >
                {scanning ? <ActivityIndicator size={14} color="#06B6D4" /> : null}
                <Text style={{ color: "#06B6D4", fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>
                  {scanning ? "SCANNING RECEIPT..." : "SCAN RECEIPT"}
                </Text>
              </Pressable>
            ) : null}

            {/* Receipt data panel */}
            {receiptData ? (
              <View style={{ marginBottom: 16 }}>
                <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 8 }}>RECEIPT DATA</Text>
                <View style={{ backgroundColor: "#1A1A1A", borderRadius: 8, padding: 12 }}>
                  {receiptData.vendor ? (
                    <Text style={{ color: "#A3A3A3", fontSize: 12, marginBottom: 4 }}>Vendor: {receiptData.vendor}</Text>
                  ) : null}
                  {receiptData.date ? (
                    <Text style={{ color: "#A3A3A3", fontSize: 12, marginBottom: 4 }}>Date: {receiptData.date}</Text>
                  ) : null}
                  {receiptData.documentNumber ? (
                    <Text style={{ color: "#A3A3A3", fontSize: 12, marginBottom: 4 }}>Doc #: {receiptData.documentNumber}</Text>
                  ) : null}
                  {receiptData.lineItems && receiptData.lineItems.length > 0 ? (
                    <View style={{ marginTop: 8 }}>
                      <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9, marginBottom: 4 }}>LINE ITEMS</Text>
                      {receiptData.lineItems.map((item, i) => (
                        <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 3, borderBottomWidth: 1, borderBottomColor: "#222" }}>
                          <Text style={{ color: "#A3A3A3", fontSize: 11, flex: 1 }} numberOfLines={1}>{item.description}</Text>
                          <Text style={{ color: "#E5E5E5", fontSize: 11, fontFamily: "monospace" }}>{formatCOPDisplay(item.total)}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </View>
              </View>
            ) : null}

            {/* Actions */}
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
              <Pressable onPress={handleDelete} style={{ paddingVertical: 10 }}>
                <Text style={{ color: "#EF4444", fontFamily: "monospace", fontSize: 11 }}>DELETE</Text>
              </Pressable>
              <Pressable
                onPress={handleSave}
                style={{ backgroundColor: "#06B6D4", paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 }}
              >
                <Text style={{ color: "#111", fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>SAVE</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
