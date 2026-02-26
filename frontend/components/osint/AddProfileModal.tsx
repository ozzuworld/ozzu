import { useState } from "react";
import { View, Text, Modal, Pressable, TextInput, TouchableWithoutFeedback } from "react-native";
import { createOsintProfile } from "../../lib/bridge-api";
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

const PROFILE_TYPES = [
  { key: "email" as const, label: "Email", emoji: "📧" },
  { key: "username" as const, label: "Username", emoji: "👤" },
  { key: "password" as const, label: "Password", emoji: "🔑" },
  { key: "phone" as const, label: "Phone", emoji: "📱" },
  { key: "domain" as const, label: "Domain", emoji: "🌐" },
];

interface Props {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function AddProfileModal({ visible, onClose, onCreated }: Props) {
  const [type, setType] = useState<"email" | "username" | "password" | "phone" | "domain">("username");
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
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
            <View style={{ width: 320, backgroundColor: "#111111", borderWidth: 1, borderColor: "#333", borderRadius: 12, padding: 20 }}>
              <Text style={{ color: "#06B6D4", fontSize: 14, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 2, textAlign: "center", marginBottom: 16 }}>
                🛡 ADD PROFILE
              </Text>

              {/* Type selector — large tap targets */}
              <View style={{ flexDirection: "row", gap: 6, marginBottom: 16 }}>
                {PROFILE_TYPES.map((pt) => (
                  <Pressable
                    key={pt.key}
                    onPress={() => setType(pt.key)}
                    hitSlop={8}
                    style={{
                      flex: 1,
                      backgroundColor: type === pt.key ? "#1E3A5F" : "#1A1A1A",
                      borderWidth: 2,
                      borderColor: type === pt.key ? "#3B82F6" : "#333",
                      borderRadius: 10,
                      paddingVertical: 12,
                      alignItems: "center",
                    }}
                  >
                    <Text style={{ color: type === pt.key ? "#60A5FA" : "#737373", fontSize: 13, fontFamily: "monospace", fontWeight: "bold" }}>
                      {pt.emoji} {pt.label.toUpperCase()}
                    </Text>
                  </Pressable>
                ))}
              </View>

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
                placeholder={type === "email" ? "email@example.com" : type === "username" ? "username" : type === "phone" ? "+14155551234" : type === "domain" ? "example.com" : "password (hashed locally)"}
                placeholderTextColor="#525252"
                secureTextEntry={type === "password"}
                autoCapitalize="none"
                style={{ backgroundColor: "#1A1A1A", borderWidth: 1, borderColor: "#333", borderRadius: 8, color: "#E5E5E5", fontSize: 13, fontFamily: "monospace", padding: 12, marginBottom: 4 }}
              />

              {type === "password" && (
                <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace", marginBottom: 8, textAlign: "center" }}>
                  🔒 SHA-1 hashed locally — never sent as plaintext
                </Text>
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
                    {submitting ? "ADDING..." : `${PROFILE_TYPE_EMOJI[type]} ADD`}
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
