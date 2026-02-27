import { useState } from "react";
import { View, Text, Modal, Pressable, TextInput, TouchableWithoutFeedback, Image, ScrollView } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system";
import { createOsintProfile, uploadOsintImage } from "../../lib/bridge-api";
import { PROFILE_TYPE_EMOJI } from "../../lib/osint-constants";

// Simple SHA-1 implementation for password hashing (no external deps)
async function sha1(message: string): Promise<string> {
  // Use SubtleCrypto if available (modern RN)
  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hash = await globalThis.crypto.subtle.digest("SHA-1", data);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  }
  // Fallback: pure JS SHA-1
  return jsSha1(message);
}

function jsSha1(msg: string): string {
  function rotl(n: number, s: number) { return (n << s) | (n >>> (32 - s)); }
  const utf8 = unescape(encodeURIComponent(msg));
  const words: number[] = [];
  for (let i = 0; i < utf8.length; i++) {
    words[i >> 2] |= (utf8.charCodeAt(i) & 0xff) << (24 - (i % 4) * 8);
  }
  words[utf8.length >> 2] |= 0x80 << (24 - (utf8.length % 4) * 8);
  const len = utf8.length * 8;
  words[((len + 64 >> 9) << 4) + 15] = len;
  const w = new Array(80);
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
  for (let i = 0; i < words.length; i += 16) {
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let j = 0; j < 80; j++) {
      w[j] = j < 16 ? (words[i + j] | 0) : rotl(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
      let f: number, k: number;
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const t = (rotl(a, 5) + f + e + k + w[j]) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map(v => (v >>> 0).toString(16).padStart(8, "0")).join("").toUpperCase();
}

const TEXT_PROFILE_TYPES = [
  { key: "email" as const, label: "Email", emoji: "📧" },
  { key: "username" as const, label: "Username", emoji: "👤" },
  { key: "password" as const, label: "Password", emoji: "🔑" },
  { key: "phone" as const, label: "Phone", emoji: "📱" },
  { key: "domain" as const, label: "Domain", emoji: "🌐" },
  { key: "ip" as const, label: "IP", emoji: "📡" },
];

type ProfileType = "email" | "username" | "password" | "phone" | "domain" | "ip" | "image";

interface Props {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function AddProfileModal({ visible, onClose, onCreated }: Props) {
  const [type, setType] = useState<ProfileType>("username");
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageFilename, setImageFilename] = useState<string | null>(null);

  const pickImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.9,
      base64: false,
      allowsEditing: false,
    });
    if (!result.canceled && result.assets[0]) {
      setImageUri(result.assets[0].uri);
      setImageFilename(result.assets[0].fileName || "photo.jpg");
      if (!label.trim()) {
        setLabel("Photo " + new Date().toLocaleDateString());
      }
    }
  };

  const handleSubmit = async () => {
    if (type === "image") {
      if (!imageUri) {
        setError("Select an image first");
        return;
      }
      if (!label.trim()) {
        setError("Label is required");
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const base64 = await FileSystem.readAsStringAsync(imageUri, { encoding: FileSystem.EncodingType.Base64 });
        await uploadOsintImage(label.trim(), base64, imageFilename || undefined);
        setLabel("");
        setImageUri(null);
        setImageFilename(null);
        setType("username");
        onCreated();
        onClose();
      } catch (err: any) {
        setError(err.message);
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (!label.trim() || !value.trim()) {
      setError("Label and value are required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      let finalValue = value.trim();
      if (type === "password") {
        finalValue = await sha1(finalValue);
      }
      await createOsintProfile(label.trim(), type, finalValue);
      setLabel("");
      setValue("");
      setType("username");
      onCreated();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.85)" }}>
          <TouchableWithoutFeedback>
            <View style={{ width: 340, maxHeight: "85%", backgroundColor: "#111111", borderWidth: 1, borderColor: "#333", borderRadius: 12, padding: 20 }}>
              <Text style={{ color: "#06B6D4", fontSize: 14, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 2, textAlign: "center", marginBottom: 16 }}>
                ADD PROFILE
              </Text>

              {/* Mode toggle: Text vs Image */}
              <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
                <Pressable
                  onPress={() => setType("username")}
                  style={{
                    flex: 1, backgroundColor: type !== "image" ? "#1E3A5F" : "#1A1A1A",
                    borderWidth: 2, borderColor: type !== "image" ? "#3B82F6" : "#333",
                    borderRadius: 10, paddingVertical: 10, alignItems: "center",
                  }}
                >
                  <Text style={{ color: type !== "image" ? "#60A5FA" : "#737373", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>
                    TEXT
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setType("image")}
                  style={{
                    flex: 1, backgroundColor: type === "image" ? "#1E3A5F" : "#1A1A1A",
                    borderWidth: 2, borderColor: type === "image" ? "#3B82F6" : "#333",
                    borderRadius: 10, paddingVertical: 10, alignItems: "center",
                  }}
                >
                  <Text style={{ color: type === "image" ? "#60A5FA" : "#737373", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>
                    IMAGE
                  </Text>
                </Pressable>
              </View>

              {type !== "image" ? (
                <>
                  {/* Type selector — text profile types */}
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
                    <View style={{ flexDirection: "row", gap: 6 }}>
                      {TEXT_PROFILE_TYPES.map((pt) => (
                        <Pressable
                          key={pt.key}
                          onPress={() => setType(pt.key)}
                          hitSlop={8}
                          style={{
                            backgroundColor: type === pt.key ? "#1E3A5F" : "#1A1A1A",
                            borderWidth: 2,
                            borderColor: type === pt.key ? "#3B82F6" : "#333",
                            borderRadius: 10,
                            paddingVertical: 10,
                            paddingHorizontal: 12,
                            alignItems: "center",
                          }}
                        >
                          <Text style={{ color: type === pt.key ? "#60A5FA" : "#737373", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>
                            {pt.emoji} {pt.label.toUpperCase()}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </ScrollView>

                  {/* Label input */}
                  <TextInput
                    value={label}
                    onChangeText={setLabel}
                    placeholder="Label (e.g. Personal Email)"
                    placeholderTextColor="#525252"
                    style={{ backgroundColor: "#1A1A1A", borderWidth: 1, borderColor: "#333", borderRadius: 8, color: "#E5E5E5", fontSize: 13, fontFamily: "monospace", padding: 12, marginBottom: 8 }}
                  />

                  {/* Value input */}
                  <TextInput
                    value={value}
                    onChangeText={setValue}
                    placeholder={type === "email" ? "email@example.com" : type === "username" ? "username" : type === "phone" ? "+14155551234" : type === "domain" ? "example.com" : type === "ip" ? "192.168.1.1 or 2001:db8::1" : "password (hashed locally)"}
                    placeholderTextColor="#525252"
                    secureTextEntry={type === "password"}
                    autoCapitalize="none"
                    style={{ backgroundColor: "#1A1A1A", borderWidth: 1, borderColor: "#333", borderRadius: 8, color: "#E5E5E5", fontSize: 13, fontFamily: "monospace", padding: 12, marginBottom: 4 }}
                  />

                  {type === "password" && (
                    <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace", marginBottom: 8, textAlign: "center" }}>
                      SHA-1 hashed locally — never sent as plaintext
                    </Text>
                  )}
                </>
              ) : (
                <>
                  {/* Image picker */}
                  <Pressable
                    onPress={pickImage}
                    style={{
                      backgroundColor: "#1A1A1A", borderWidth: 2, borderColor: imageUri ? "#22C55E" : "#333",
                      borderRadius: 10, borderStyle: imageUri ? "solid" : "dashed",
                      paddingVertical: imageUri ? 8 : 32, alignItems: "center", marginBottom: 12,
                    }}
                  >
                    {imageUri ? (
                      <Image source={{ uri: imageUri }} style={{ width: 200, height: 200, borderRadius: 8 }} resizeMode="cover" />
                    ) : (
                      <>
                        <Text style={{ color: "#525252", fontSize: 28, marginBottom: 4 }}>📷</Text>
                        <Text style={{ color: "#737373", fontSize: 12, fontFamily: "monospace" }}>TAP TO SELECT IMAGE</Text>
                      </>
                    )}
                  </Pressable>

                  {/* Label input */}
                  <TextInput
                    value={label}
                    onChangeText={setLabel}
                    placeholder="Label (e.g. My Photo)"
                    placeholderTextColor="#525252"
                    style={{ backgroundColor: "#1A1A1A", borderWidth: 1, borderColor: "#333", borderRadius: 8, color: "#E5E5E5", fontSize: 13, fontFamily: "monospace", padding: 12, marginBottom: 4 }}
                  />

                  <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace", marginBottom: 8, textAlign: "center" }}>
                    Scans EXIF metadata, reverse image search, avatar matching
                  </Text>
                </>
              )}

              {error && (
                <Text style={{ color: "#EF4444", fontSize: 11, fontFamily: "monospace", marginBottom: 8, textAlign: "center" }}>
                  {error}
                </Text>
              )}

              {/* Buttons */}
              <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                <Pressable
                  onPress={onClose}
                  style={{ flex: 1, backgroundColor: "#1A1A1A", borderWidth: 1, borderColor: "#333", borderRadius: 8, paddingVertical: 12, alignItems: "center" }}
                >
                  <Text style={{ color: "#737373", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>CANCEL</Text>
                </Pressable>
                <Pressable
                  onPress={handleSubmit}
                  disabled={submitting}
                  style={({ pressed }) => ({
                    flex: 1,
                    backgroundColor: pressed ? "#1E3A5F" : "#0E2A4F",
                    borderWidth: 1,
                    borderColor: "#3B82F6",
                    borderRadius: 8,
                    paddingVertical: 12,
                    alignItems: "center",
                    opacity: submitting ? 0.5 : 1,
                  })}
                >
                  <Text style={{ color: "#60A5FA", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>
                    {submitting ? (type === "image" ? "UPLOADING..." : "ADDING...") : `${PROFILE_TYPE_EMOJI[type]} ADD`}
                  </Text>
                </Pressable>
              </View>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}
