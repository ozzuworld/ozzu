import { useEffect, useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  Image,
  StatusBar,
  ScrollView,
  Pressable,
  TextInput,
  BackHandler,
} from "react-native";
import { useKeepAwake } from "expo-keep-awake";
import * as Updates from "expo-updates";
import { isDeviceOwner, getVersionCode, downloadAndInstall } from "expo-device-owner";

// ── Config ──
const DEFAULT_BRIDGE =
  process.env.EXPO_PUBLIC_BRIDGE_URL || "https://home.ozzu.world/bridge";
const MIRROR_PORT = 5560;
const MIRROR_FPS = 5;
const UPDATE_CHECK_INTERVAL = 5 * 60 * 1000;

// ── Theme ──
const C = {
  bg: "#07070e",
  panelBg: "#0c0c16",
  panelBorder: "rgba(255, 255, 255, 0.06)",
  panelShadow: "#000000",
  labelColor: "rgba(255, 255, 255, 0.35)",
  textMuted: "rgba(255, 255, 255, 0.2)",
  green: "#4ade80",
  red: "#f87171",
  dimCyan: "rgba(15, 245, 238, 0.08)",
  white: "#f0f0f0",
};

// ── Types ──
interface DiffFile {
  path: string;
  hunks: DiffLine[];
}
interface DiffLine {
  type: "add" | "del" | "ctx" | "hunk";
  text: string;
}
interface DiffData {
  files: DiffFile[];
  additions: number;
  deletions: number;
  fileCount: number;
  time: number;
}

// ── Diff parser ──
function parseDiff(raw: string): DiffData {
  if (!raw.trim()) return { files: [], additions: 0, deletions: 0, fileCount: 0, time: 0 };
  const lines = raw.split("\n");
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let additions = 0, deletions = 0;
  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const m = line.match(/b\/(.+)$/);
      current = { path: m ? m[1] : "", hunks: [] };
      files.push(current);
    } else if (line.startsWith("@@") && current) {
      current.hunks.push({ type: "hunk", text: line });
    } else if (line.startsWith("+") && !line.startsWith("+++") && current) {
      additions++;
      current.hunks.push({ type: "add", text: line });
    } else if (line.startsWith("-") && !line.startsWith("---") && current) {
      deletions++;
      current.hunks.push({ type: "del", text: line });
    } else if (
      current &&
      !line.startsWith("index ") &&
      !line.startsWith("---") &&
      !line.startsWith("+++") &&
      !line.startsWith("diff ")
    ) {
      current.hunks.push({ type: "ctx", text: line });
    }
  }
  return { files, additions, deletions, fileCount: files.length, time: Date.now() };
}

// ═══════════════════════════════════════
// Floating Panel — depth frame
// ═══════════════════════════════════════
function Panel({
  label,
  children,
  style,
}: {
  label: string;
  children: React.ReactNode;
  style?: any;
}) {
  return (
    <View style={[s.panelOuter, style]}>
      {/* Label above */}
      <Text style={s.panelLabel}>{label}</Text>

      {/* Panel with depth */}
      <View style={s.panelFrame}>
        {/* Inner shadow layers for depth */}
        <View style={s.panelDepthOuter} />
        <View style={s.panelDepthInner} />

        {/* Content */}
        <View style={s.panelContent}>{children}</View>
      </View>
    </View>
  );
}

// ═══════════════════════════════════════
// Device Mirror
// ═══════════════════════════════════════
function DeviceMirror({ bridgeUrl }: { bridgeUrl: string }) {
  const [frameUri, setFrameUri] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let mounted = true;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      if (!mounted) return;
      const wsUrl = bridgeUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
      const ws = new WebSocket(`${wsUrl}/dev/mirror?port=${MIRROR_PORT}&fps=${MIRROR_FPS}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onmessage = (event) => {
        if (!mounted) return;
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        setFrameUri(`data:image/png;base64,${btoa(binary)}`);
      };

      ws.onerror = () => {};
      ws.onclose = () => {
        if (mounted) reconnectTimer = setTimeout(connect, 3000);
      };
    }

    connect();
    return () => {
      mounted = false;
      clearTimeout(reconnectTimer);
      if (wsRef.current) wsRef.current.close();
    };
  }, [bridgeUrl]);

  return (
    <View style={{ flex: 1, backgroundColor: "#000", borderRadius: 4, overflow: "hidden" }}>
      {frameUri ? (
        <Image source={{ uri: frameUri }} style={{ flex: 1 }} resizeMode="contain" />
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontFamily: "monospace", fontSize: 12, color: C.textMuted, letterSpacing: 3 }}>
            CONNECTING
          </Text>
        </View>
      )}
    </View>
  );
}

// ═══════════════════════════════════════
// Diff Viewer
// ═══════════════════════════════════════
function DiffViewer({ bridgeUrl }: { bridgeUrl: string }) {
  const [diff, setDiff] = useState<DiffData | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const lastDiffTimeRef = useRef(0);

  useEffect(() => {
    let mounted = true;
    async function poll() {
      try {
        const res = await fetch(`${bridgeUrl}/dev/diff`);
        if (!res.ok) return;
        const data = await res.json();
        if (mounted) {
          if (data.diff && data.time !== lastDiffTimeRef.current) {
            lastDiffTimeRef.current = data.time;
            const parsed = parseDiff(data.diff);
            parsed.time = data.time || Date.now();
            setDiff(parsed);
            setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
          } else if (!data.diff) {
            setDiff(null);
          }
        }
      } catch {}
    }
    poll();
    const interval = setInterval(poll, 2000);
    return () => { mounted = false; clearInterval(interval); };
  }, [bridgeUrl]);

  const lineColor = (type: DiffLine["type"]) => {
    switch (type) {
      case "add": return C.green;
      case "del": return C.red;
      case "hunk": return "rgba(255,255,255,0.25)";
      default: return "rgba(255,255,255,0.15)";
    }
  };

  const lineBg = (type: DiffLine["type"]) => {
    switch (type) {
      case "add": return "rgba(74, 222, 128, 0.06)";
      case "del": return "rgba(248, 113, 113, 0.06)";
      default: return "transparent";
    }
  };

  return (
    <ScrollView ref={scrollRef} style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
      {!diff || diff.fileCount === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 120 }}>
          <Text style={{ fontFamily: "monospace", fontSize: 11, color: C.textMuted, letterSpacing: 4 }}>
            AWAITING CHANGES
          </Text>
        </View>
      ) : (
        diff.files.map((file, fi) => (
          <View key={fi} style={{ marginBottom: 8 }}>
            <View style={{
              paddingVertical: 6,
              paddingHorizontal: 14,
              backgroundColor: "rgba(255,255,255,0.03)",
              borderBottomWidth: 1,
              borderBottomColor: "rgba(255,255,255,0.04)",
            }}>
              <Text style={{
                fontFamily: "monospace",
                fontSize: 10,
                color: "rgba(255,255,255,0.4)",
                letterSpacing: 1,
              }}>
                {file.path}
              </Text>
            </View>
            {file.hunks.map((line, li) => (
              <View key={li} style={{ backgroundColor: lineBg(line.type), paddingHorizontal: 14, paddingVertical: 1 }}>
                <Text
                  style={{ fontFamily: "monospace", fontSize: 10.5, lineHeight: 16, color: lineColor(line.type) }}
                  numberOfLines={1}
                >
                  {line.text}
                </Text>
              </View>
            ))}
          </View>
        ))
      )}
    </ScrollView>
  );
}

// ═══════════════════════════════════════
// Settings Screen
// ═══════════════════════════════════════
function SettingsScreen({
  bridgeUrl,
  onSave,
  onCancel,
}: {
  bridgeUrl: string;
  onSave: (url: string) => void;
  onCancel: () => void;
}) {
  const [inputUrl, setInputUrl] = useState(bridgeUrl);
  return (
    <View style={{ flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center", padding: 40 }}>
      <Text style={{ color: C.white, fontFamily: "monospace", fontSize: 16, letterSpacing: 4, marginBottom: 30, opacity: 0.6 }}>
        CONFIGURE
      </Text>
      <TextInput
        value={inputUrl}
        onChangeText={setInputUrl}
        style={{
          width: 480, height: 46, backgroundColor: "rgba(255,255,255,0.04)",
          borderWidth: 1, borderColor: "rgba(255,255,255,0.08)", borderRadius: 6,
          color: C.white, fontFamily: "monospace", fontSize: 14, paddingHorizontal: 16, letterSpacing: 0.5,
        }}
        autoFocus
        selectTextOnFocus
        placeholderTextColor="rgba(255,255,255,0.15)"
        placeholder="https://home.ozzu.world/bridge"
      />
      <View style={{ flexDirection: "row", gap: 16, marginTop: 20 }}>
        <Pressable
          onPress={() => onSave(inputUrl.replace(/\/+$/, ""))}
          style={{ backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 6, paddingHorizontal: 28, paddingVertical: 10 }}
        >
          <Text style={{ color: C.white, fontFamily: "monospace", fontSize: 13, letterSpacing: 2, opacity: 0.7 }}>SAVE</Text>
        </Pressable>
        <Pressable
          onPress={onCancel}
          style={{ paddingHorizontal: 28, paddingVertical: 10 }}
        >
          <Text style={{ color: C.white, fontFamily: "monospace", fontSize: 13, letterSpacing: 2, opacity: 0.3 }}>CANCEL</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ═══════════════════════════════════════
// Main App
// ═══════════════════════════════════════
export default function App() {
  const [bridgeUrl, setBridgeUrl] = useState(DEFAULT_BRIDGE);
  const [editing, setEditing] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);

  // Keep screen on — TV should never sleep while app is running
  useKeepAwake();
  useEffect(() => { StatusBar.setHidden(true); }, []);

  useEffect(() => {
    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (editing) { setEditing(false); return true; }
      return false;
    });
    return () => handler.remove();
  }, [editing]);

  const checkForUpdates = useCallback(async () => {
    try {
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        setUpdateStatus("Updating...");
        await Updates.fetchUpdateAsync();
        await Updates.reloadAsync();
        return;
      }
      const deviceOwner = isDeviceOwner();
      if (!deviceOwner) return;
      const currentVersion = getVersionCode();
      const res = await fetch(`${bridgeUrl}/tv/release/check?versionCode=${currentVersion}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.updateAvailable) {
        setUpdateStatus(`Installing v${data.versionName}...`);
        await downloadAndInstall(`${bridgeUrl}/tv/release/download`);
      }
    } catch {
      setUpdateStatus(null);
    }
  }, [bridgeUrl]);

  useEffect(() => {
    const t = setTimeout(checkForUpdates, 10_000);
    const i = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL);
    return () => { clearTimeout(t); clearInterval(i); };
  }, [checkForUpdates]);

  if (editing) {
    return (
      <SettingsScreen
        bridgeUrl={bridgeUrl}
        onSave={(url) => { setBridgeUrl(url); setEditing(false); }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <View style={s.root}>
      {/* Floating panels */}
      <View style={s.stage}>
        {/* Device mirror */}
        <Panel label={`redroid05 :${MIRROR_PORT}`} style={{ flex: 0.38 }}>
          <DeviceMirror bridgeUrl={bridgeUrl} />
        </Panel>

        {/* Gap */}
        <View style={{ width: 28 }} />

        {/* Diff viewer */}
        <Panel label="PLANNING" style={{ flex: 0.52 }}>
          <DiffViewer bridgeUrl={bridgeUrl} />
        </Panel>
      </View>

      {/* Update overlay */}
      {updateStatus && (
        <View style={{ position: "absolute", bottom: 20, left: 0, right: 0, alignItems: "center" }}>
          <Text style={{ fontFamily: "monospace", fontSize: 11, color: "rgba(255,255,255,0.3)", letterSpacing: 2 }}>
            {updateStatus}
          </Text>
        </View>
      )}

      {/* Settings gear */}
      <Pressable
        onPress={() => setEditing(true)}
        style={{ position: "absolute", top: 12, right: 16, opacity: 0.1 }}
      >
        <Text style={{ color: "#fff", fontSize: 18 }}>{"\u2699"}</Text>
      </Pressable>
    </View>
  );
}

// ═══════════════════════════════════════
// Styles
// ═══════════════════════════════════════
const s = {
  root: {
    flex: 1,
    backgroundColor: C.bg,
  } as const,

  // The stage centers the floating panels with generous padding
  stage: {
    flex: 1,
    flexDirection: "row" as const,
    paddingHorizontal: 60,
    paddingVertical: 48,
  },

  // ── Panel ──
  panelOuter: {
    // flex set per-instance
  },

  panelLabel: {
    fontFamily: "monospace",
    fontSize: 10,
    letterSpacing: 3,
    color: C.labelColor,
    textTransform: "uppercase" as const,
    marginBottom: 10,
    marginLeft: 2,
  },

  panelFrame: {
    flex: 1,
    borderRadius: 8,
    overflow: "hidden" as const,
    backgroundColor: C.panelBg,
    // Depth — outer border + shadow
    borderWidth: 1,
    borderColor: C.panelBorder,
    // Elevation for Android shadow
    elevation: 20,
    shadowColor: C.panelShadow,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.6,
    shadowRadius: 24,
  },

  panelDepthOuter: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: "rgba(255, 255, 255, 0.04)",
  },

  panelDepthInner: {
    position: "absolute" as const,
    bottom: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: "rgba(0, 0, 0, 0.3)",
  },

  panelContent: {
    flex: 1,
    overflow: "hidden" as const,
  },
};
