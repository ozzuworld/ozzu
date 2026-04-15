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
import * as Updates from "expo-updates";
import { isDeviceOwner, getVersionCode, downloadAndInstall } from "expo-device-owner";

// ── Config ──
const DEFAULT_BRIDGE =
  process.env.EXPO_PUBLIC_BRIDGE_URL || "https://home.ozzu.world/bridge";
const MIRROR_PORT = 5560;
const MIRROR_FPS = 5;
const UPDATE_CHECK_INTERVAL = 5 * 60 * 1000;

// ── Theme (matches PoC sci-fi aesthetic) ──
const C = {
  bg: "#020208",
  cyan: "#0ff5ee",
  cyanMid: "#0cc7c2",
  cyanDim: "#0aa8a3",
  cyanDark: "#064d4a",
  cyanGlow: "rgba(15, 245, 238, 0.15)",
  green: "#00ff41",
  red: "#ff3c3c",
  yellow: "#ffd700",
  frameBg: "rgba(6, 77, 74, 0.06)",
  surface: "rgba(15, 245, 238, 0.04)",
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
// Device Mirror — WebSocket binary frames
// ═══════════════════════════════════════
function DeviceMirror({ bridgeUrl }: { bridgeUrl: string }) {
  const [frameUri, setFrameUri] = useState<string | null>(null);
  const [status, setStatus] = useState<"connecting" | "online" | "offline">("connecting");
  const [fps, setFps] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const frameCountRef = useRef(0);
  const fpsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let mounted = true;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      if (!mounted) return;
      const wsUrl = bridgeUrl
        .replace(/^https:/, "wss:")
        .replace(/^http:/, "ws:");
      const ws = new WebSocket(`${wsUrl}/dev/mirror?port=${MIRROR_PORT}&fps=${MIRROR_FPS}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      setStatus("connecting");

      ws.onopen = () => {
        if (mounted) setStatus("online");
      };

      ws.onmessage = (event) => {
        if (!mounted) return;
        // Convert binary ArrayBuffer to base64 data URI
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const b64 = btoa(binary);
        setFrameUri(`data:image/png;base64,${b64}`);
        setStatus("online");
        frameCountRef.current++;
      };

      ws.onerror = () => {
        if (mounted) setStatus("offline");
      };

      ws.onclose = () => {
        if (mounted) {
          setStatus("offline");
          reconnectTimer = setTimeout(connect, 3000);
        }
      };
    }

    connect();

    // FPS counter
    fpsTimerRef.current = setInterval(() => {
      if (mounted) {
        setFps(frameCountRef.current);
        frameCountRef.current = 0;
      }
    }, 1000);

    return () => {
      mounted = false;
      clearTimeout(reconnectTimer);
      if (fpsTimerRef.current) clearInterval(fpsTimerRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [bridgeUrl]);

  const statusColor =
    status === "online" ? C.green : status === "connecting" ? C.yellow : C.red;

  return (
    <View style={{ flex: 0.42, marginRight: 16 }}>
      {/* Label */}
      <Text style={s.frameLabel}>
        DEVICE MIRROR // :{MIRROR_PORT}
      </Text>

      {/* Frame */}
      <View style={[s.frame, { flex: 1 }]}>
        {/* Corner accents */}
        <View style={[s.corner, s.cornerTL]} />
        <View style={[s.corner, s.cornerTR]} />
        <View style={[s.corner, s.cornerBL]} />
        <View style={[s.corner, s.cornerBR]} />

        {/* Content */}
        <View style={{ flex: 1, backgroundColor: "#000", overflow: "hidden" }}>
          {frameUri ? (
            <Image
              source={{ uri: frameUri }}
              style={{ flex: 1 }}
              resizeMode="contain"
            />
          ) : (
            <View style={s.emptyState}>
              <Text style={s.emptyText}>
                {status === "connecting" ? "CONNECTING..." : "NO SIGNAL"}
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* Status bar */}
      <View style={s.statusBar}>
        <Text style={[s.statusText, { color: statusColor }]}>
          {status.toUpperCase()}
        </Text>
        <Text style={s.statusText}>{fps} FPS</Text>
      </View>
    </View>
  );
}

// ═══════════════════════════════════════
// Diff Viewer — SSE live git diffs
// ═══════════════════════════════════════
function DiffViewer({ bridgeUrl }: { bridgeUrl: string }) {
  const [diff, setDiff] = useState<DiffData | null>(null);
  const [connected, setConnected] = useState(false);
  const [buildRunning, setBuildRunning] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  // Poll for diffs every 2 seconds (RN doesn't support Web Streams API for SSE)
  const lastDiffTimeRef = useRef(0);
  useEffect(() => {
    let mounted = true;

    async function poll() {
      try {
        const res = await fetch(`${bridgeUrl}/dev/diff`);
        if (!res.ok) throw new Error("fetch failed");
        const data = await res.json();
        if (mounted) {
          setConnected(true);
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
      } catch {
        if (mounted) setConnected(false);
      }
    }

    poll();
    const interval = setInterval(poll, 2000);
    return () => { mounted = false; clearInterval(interval); };
  }, [bridgeUrl]);

  // Poll build status
  useEffect(() => {
    let mounted = true;
    async function check() {
      try {
        const res = await fetch(`${bridgeUrl}/dev/build-status`);
        const data = await res.json();
        if (mounted) setBuildRunning(data.running);
      } catch {}
    }
    check();
    const interval = setInterval(check, 5000);
    return () => { mounted = false; clearInterval(interval); };
  }, [bridgeUrl]);

  const lineColor = (type: DiffLine["type"]) => {
    switch (type) {
      case "add": return C.green;
      case "del": return C.red;
      case "hunk": return C.cyanDim;
      default: return "rgba(10, 168, 163, 0.4)";
    }
  };

  const lineBg = (type: DiffLine["type"]) => {
    switch (type) {
      case "add": return "rgba(0, 255, 65, 0.05)";
      case "del": return "rgba(255, 60, 60, 0.05)";
      case "hunk": return "rgba(15, 245, 238, 0.02)";
      default: return "transparent";
    }
  };

  const lineBorder = (type: DiffLine["type"]) => {
    switch (type) {
      case "add": return C.green;
      case "del": return C.red;
      default: return "transparent";
    }
  };

  const timeStr = diff?.time
    ? new Date(diff.time).toLocaleTimeString("en", { hour12: false })
    : "--:--:--";

  return (
    <View style={{ flex: 0.58 }}>
      {/* Label */}
      <Text style={s.frameLabel}>LIVE DIFF // SOURCE MONITOR</Text>

      {/* Frame */}
      <View style={[s.frame, { flex: 1 }]}>
        <View style={[s.corner, s.cornerTL]} />
        <View style={[s.corner, s.cornerTR]} />
        <View style={[s.corner, s.cornerBL]} />
        <View style={[s.corner, s.cornerBR]} />

        <View style={{ flex: 1, backgroundColor: C.frameBg }}>
          {/* Header */}
          <View style={s.diffHeader}>
            <Text style={s.diffHeaderText}>
              {diff && diff.fileCount > 0
                ? `${diff.fileCount} FILE${diff.fileCount !== 1 ? "S" : ""} // +${diff.additions} -${diff.deletions}`
                : "AWAITING CHANGES"}
            </Text>
            <Text
              style={[
                s.diffHeaderTag,
                { color: buildRunning ? C.green : C.yellow },
              ]}
            >
              {buildRunning ? "AUTO-BUILD \u25CF" : "BUILD \u25CB IDLE"}
            </Text>
          </View>

          {/* Diff content */}
          <ScrollView
            ref={scrollRef}
            style={{ flex: 1 }}
            showsVerticalScrollIndicator={false}
          >
            {!diff || diff.fileCount === 0 ? (
              <View style={s.emptyState}>
                <Text style={s.emptyText}>AWAITING SOURCE MODIFICATIONS</Text>
              </View>
            ) : (
              diff.files.map((file, fi) => (
                <View key={fi} style={{ marginBottom: 4 }}>
                  {/* File header */}
                  <View style={s.fileHeader}>
                    <Text style={s.fileHeaderText}>
                      {"\u25B8"} {file.path}
                    </Text>
                  </View>
                  {/* Lines */}
                  {file.hunks.map((line, li) => (
                    <View
                      key={li}
                      style={{
                        backgroundColor: lineBg(line.type),
                        borderLeftWidth: 2,
                        borderLeftColor: lineBorder(line.type),
                        paddingHorizontal: 16,
                        paddingVertical: 1,
                      }}
                    >
                      <Text
                        style={{
                          fontFamily: "monospace",
                          fontSize: 11,
                          lineHeight: 17,
                          color: lineColor(line.type),
                        }}
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

          {/* Telemetry strip */}
          <View style={s.telemStrip}>
            <Text style={s.telemText}>
              {diff ? `${diff.fileCount} FILES` : "0 FILES"}
            </Text>
            <Text style={s.telemText}>{timeStr}</Text>
            <View style={{ flex: 1 }} />
            <Clock />
          </View>
        </View>
      </View>

      {/* Status bar */}
      <View style={s.statusBar}>
        <Text style={[s.statusText, { color: connected ? C.green : C.red }]}>
          {connected ? "STREAM CONNECTED" : "DISCONNECTED"}
        </Text>
      </View>
    </View>
  );
}

// ── Clock ──
function Clock() {
  const [time, setTime] = useState(
    new Date().toLocaleTimeString("en", { hour12: false })
  );
  useEffect(() => {
    const i = setInterval(
      () => setTime(new Date().toLocaleTimeString("en", { hour12: false })),
      1000
    );
    return () => clearInterval(i);
  }, []);
  return <Text style={[s.telemText, { color: C.cyanMid }]}>{time}</Text>;
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
    <View style={s.settingsContainer}>
      <Text style={s.settingsTitle}>OZZU TV // CONFIGURE</Text>
      <Text style={s.settingsLabel}>BRIDGE URL</Text>
      <TextInput
        value={inputUrl}
        onChangeText={setInputUrl}
        style={s.settingsInput}
        autoFocus
        selectTextOnFocus
        placeholderTextColor={C.cyanDark}
        placeholder="https://home.ozzu.world/bridge"
      />
      <View style={{ flexDirection: "row", gap: 20, marginTop: 24 }}>
        <Pressable
          onPress={() => onSave(inputUrl.replace(/\/+$/, ""))}
          style={s.settingsBtn}
        >
          <Text style={s.settingsBtnText}>CONNECT</Text>
        </Pressable>
        <Pressable onPress={onCancel} style={s.settingsBtnCancel}>
          <Text style={[s.settingsBtnText, { color: "#666" }]}>CANCEL</Text>
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

  // Hide system UI
  useEffect(() => {
    StatusBar.setHidden(true);
  }, []);

  // Back button closes settings
  useEffect(() => {
    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (editing) {
        setEditing(false);
        return true;
      }
      return false;
    });
    return () => handler.remove();
  }, [editing]);

  // Update checker (OTA + APK self-install)
  const checkForUpdates = useCallback(async () => {
    try {
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        setUpdateStatus("Downloading update...");
        await Updates.fetchUpdateAsync();
        setUpdateStatus("Restarting...");
        await Updates.reloadAsync();
        return;
      }
      const deviceOwner = isDeviceOwner();
      if (!deviceOwner) return;
      const currentVersion = getVersionCode();
      const res = await fetch(
        `${bridgeUrl}/tv/release/check?versionCode=${currentVersion}`
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data.updateAvailable) {
        setUpdateStatus(`Installing v${data.versionName}...`);
        await downloadAndInstall(`${bridgeUrl}/tv/release/download`);
        setUpdateStatus("Update installed — restarting...");
      }
    } catch (e) {
      console.log("Update check failed:", e);
      setUpdateStatus(null);
    }
  }, [bridgeUrl]);

  useEffect(() => {
    const initialCheck = setTimeout(checkForUpdates, 10_000);
    const interval = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL);
    return () => {
      clearTimeout(initialCheck);
      clearInterval(interval);
    };
  }, [checkForUpdates]);

  if (editing) {
    return (
      <SettingsScreen
        bridgeUrl={bridgeUrl}
        onSave={(url) => {
          setBridgeUrl(url);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <View style={s.root}>
      {/* Main split view */}
      <View style={s.splitContainer}>
        <DeviceMirror bridgeUrl={bridgeUrl} />
        <DiffViewer bridgeUrl={bridgeUrl} />
      </View>

      {/* Update status overlay */}
      {updateStatus && (
        <View style={s.updateOverlay}>
          <Text style={s.updateText}>{updateStatus}</Text>
        </View>
      )}

      {/* Settings gear — very subtle */}
      <Pressable
        onPress={() => setEditing(true)}
        style={s.settingsGear}
      >
        <Text style={{ color: C.cyan, fontFamily: "monospace", fontSize: 16 }}>
          {"\u2699"}
        </Text>
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

  splitContainer: {
    flex: 1,
    flexDirection: "row" as const,
    padding: 24,
    paddingTop: 32,
    paddingBottom: 16,
  },

  // ── Frame ──
  frame: {
    borderWidth: 1,
    borderColor: C.cyanDark,
    overflow: "hidden" as const,
  },

  frameLabel: {
    fontFamily: "monospace",
    fontSize: 9,
    letterSpacing: 4,
    color: C.cyanDim,
    textTransform: "uppercase" as const,
    marginBottom: 6,
    marginLeft: 4,
  },

  // Corner accents
  corner: {
    position: "absolute" as const,
    width: 12,
    height: 12,
    zIndex: 10,
  },
  cornerTL: {
    top: -1,
    left: -1,
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderTopColor: C.cyan,
    borderLeftColor: C.cyan,
  },
  cornerTR: {
    top: -1,
    right: -1,
    borderTopWidth: 2,
    borderRightWidth: 2,
    borderTopColor: C.cyan,
    borderRightColor: C.cyan,
  },
  cornerBL: {
    bottom: -1,
    left: -1,
    borderBottomWidth: 2,
    borderLeftWidth: 2,
    borderBottomColor: C.cyan,
    borderLeftColor: C.cyan,
  },
  cornerBR: {
    bottom: -1,
    right: -1,
    borderBottomWidth: 2,
    borderRightWidth: 2,
    borderBottomColor: C.cyan,
    borderRightColor: C.cyan,
  },

  // ── Status bar (below frame) ──
  statusBar: {
    flexDirection: "row" as const,
    justifyContent: "space-between" as const,
    paddingHorizontal: 4,
    paddingTop: 4,
  },
  statusText: {
    fontFamily: "monospace",
    fontSize: 8,
    letterSpacing: 2,
    color: C.cyanDark,
    textTransform: "uppercase" as const,
  },

  // ── Diff viewer ──
  diffHeader: {
    height: 28,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(15, 245, 238, 0.08)",
  },
  diffHeaderText: {
    fontFamily: "monospace",
    fontSize: 9,
    letterSpacing: 2,
    color: C.cyanDim,
    textTransform: "uppercase" as const,
  },
  diffHeaderTag: {
    fontFamily: "monospace",
    fontSize: 9,
    letterSpacing: 2,
    marginLeft: "auto" as any,
  },

  fileHeader: {
    backgroundColor: C.surface,
    paddingVertical: 4,
    paddingHorizontal: 16,
    borderLeftWidth: 2,
    borderLeftColor: C.cyanDim,
  },
  fileHeaderText: {
    fontFamily: "monospace",
    fontSize: 11,
    color: C.cyan,
    letterSpacing: 1,
  },

  telemStrip: {
    height: 26,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    paddingHorizontal: 16,
    gap: 20,
    borderTopWidth: 1,
    borderTopColor: "rgba(15, 245, 238, 0.08)",
  },
  telemText: {
    fontFamily: "monospace",
    fontSize: 9,
    letterSpacing: 2,
    color: C.cyanDark,
    textTransform: "uppercase" as const,
  },

  // ── Empty state ──
  emptyState: {
    flex: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    minHeight: 200,
  },
  emptyText: {
    fontFamily: "monospace",
    fontSize: 11,
    letterSpacing: 4,
    color: C.cyanDark,
    textTransform: "uppercase" as const,
  },

  // ── Settings ──
  settingsContainer: {
    flex: 1,
    backgroundColor: C.bg,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    padding: 40,
  },
  settingsTitle: {
    color: C.cyan,
    fontFamily: "monospace",
    fontSize: 18,
    letterSpacing: 4,
    marginBottom: 30,
  },
  settingsLabel: {
    color: C.cyanDim,
    fontFamily: "monospace",
    fontSize: 13,
    letterSpacing: 2,
    marginBottom: 12,
  },
  settingsInput: {
    width: 500,
    height: 50,
    backgroundColor: "#0d0d14",
    borderWidth: 1,
    borderColor: "rgba(10, 168, 163, 0.25)",
    color: C.cyan,
    fontFamily: "monospace",
    fontSize: 16,
    paddingHorizontal: 16,
    letterSpacing: 1,
  },
  settingsBtn: {
    backgroundColor: "rgba(10, 168, 163, 0.13)",
    borderWidth: 1,
    borderColor: C.cyanDim,
    paddingHorizontal: 32,
    paddingVertical: 12,
  },
  settingsBtnCancel: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: "#333",
    paddingHorizontal: 32,
    paddingVertical: 12,
  },
  settingsBtnText: {
    color: C.cyan,
    fontFamily: "monospace",
    fontSize: 14,
    letterSpacing: 2,
  },

  // ── Overlays ──
  updateOverlay: {
    position: "absolute" as const,
    bottom: 12,
    left: 0,
    right: 0,
    alignItems: "center" as const,
  },
  updateText: {
    color: C.cyan,
    fontFamily: "monospace",
    fontSize: 11,
    letterSpacing: 2,
    backgroundColor: "rgba(2, 2, 8, 0.8)",
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  settingsGear: {
    position: "absolute" as const,
    top: 8,
    right: 8,
    width: 32,
    height: 32,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    opacity: 0.15,
  },
};
