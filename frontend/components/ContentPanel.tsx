import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import {
  View,
  Text,
  Animated,
  Easing,
  useWindowDimensions,
  ScrollView,
  Platform,
} from "react-native";
import { TVPressable } from "./TVPressable";
import { RARITY_COLORS } from "../lib/rooms";

interface ContentPanelProps {
  visible: boolean;
  title: string;
  content: string;
  onClose: () => void;
}

const RARE = RARITY_COLORS.rare;
const SHIMMER_PERIOD = 2500;

// ── Loot-box animation constants ──
const NUM_RAYS = 8;
const NUM_PARTICLES = 16;
const RAY_DISTANCE = 160;
const PARTICLE_DISTANCE = 130;
const BURST_COLOR = "rgba(147,197,253,0.9)"; // blue-white
const RAY_COLOR = "rgba(96,165,250,0.7)";
const PARTICLE_COLOR = "rgba(34,211,238,0.8)";

// ── Colors ──
const C = {
  bg: "rgba(10, 10, 20, 0.95)",
  headerBg: "rgba(59, 130, 246, 0.08)",
  headerBorder: "rgba(59, 130, 246, 0.15)",
  text: "#CBD5E1",
  textBright: "#E2E8F0",
  textDim: "#64748B",
  accent: "#60A5FA",
  accentDim: "rgba(59, 130, 246, 0.15)",
  codeBg: "rgba(30, 41, 59, 0.8)",
  codeBorder: "rgba(59, 130, 246, 0.12)",
  codeText: "#93C5FD",
  tableBorder: "rgba(100, 116, 139, 0.25)",
  tableHeaderBg: "rgba(59, 130, 246, 0.06)",
  statusPending: "#FBBF24",
  statusActive: "#34D399",
  statusDone: "#60A5FA",
  bullet: "#3B82F6",
};

// ── Inline markdown parser ──
type InlineNode =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string }
  | { type: "bolditalic"; text: string };

function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  // Match: ***bold italic***, **bold**, *italic*, `code`
  const re = /(\*{3}(.+?)\*{3}|\*{2}(.+?)\*{2}|\*(.+?)\*|`([^`]+)`)/g;
  let last = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push({ type: "text", text: text.slice(last, match.index) });
    }
    if (match[2]) nodes.push({ type: "bolditalic", text: match[2] });
    else if (match[3]) nodes.push({ type: "bold", text: match[3] });
    else if (match[4]) nodes.push({ type: "italic", text: match[4] });
    else if (match[5]) nodes.push({ type: "code", text: match[5] });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    nodes.push({ type: "text", text: text.slice(last) });
  }
  return nodes;
}

function InlineText({ text }: { text: string }) {
  const nodes = parseInline(text);
  return (
    <Text>
      {nodes.map((n, i) => {
        switch (n.type) {
          case "bold":
            return (
              <Text key={i} style={{ color: C.textBright, fontWeight: "700" }}>
                {n.text}
              </Text>
            );
          case "italic":
            return (
              <Text key={i} style={{ color: C.text, fontStyle: "italic" }}>
                {n.text}
              </Text>
            );
          case "bolditalic":
            return (
              <Text
                key={i}
                style={{
                  color: C.textBright,
                  fontWeight: "700",
                  fontStyle: "italic",
                }}
              >
                {n.text}
              </Text>
            );
          case "code":
            return (
              <Text
                key={i}
                style={{
                  backgroundColor: C.codeBg,
                  color: C.codeText,
                  fontFamily: "monospace",
                  fontSize: 12,
                  paddingHorizontal: 4,
                  borderRadius: 3,
                }}
              >
                {n.text}
              </Text>
            );
          default:
            return (
              <Text key={i} style={{ color: C.text }}>
                {n.text}
              </Text>
            );
        }
      })}
    </Text>
  );
}

// ── Block-level parser ──
type Block =
  | { type: "h1" | "h2" | "h3"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bullet"; text: string; indent: number }
  | { type: "codeblock"; lang: string; text: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "hr" }
  | { type: "status"; label: string; status: string };

function parseBlocks(content: string): Block[] {
  const lines = content.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.trimStart().startsWith("```")) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "codeblock", lang, text: codeLines.join("\n") });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Headers
    if (line.startsWith("### ")) {
      blocks.push({ type: "h3", text: line.slice(4) });
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({ type: "h2", text: line.slice(3) });
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push({ type: "h1", text: line.slice(2) });
      i++;
      continue;
    }

    // Table (detect by | at start)
    if (line.trimStart().startsWith("|") && line.includes("|", 1)) {
      const tableLines: string[] = [line];
      i++;
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      // Parse table
      const parsedRows = tableLines
        .filter((l) => !/^\|[\s-:|]+\|$/.test(l.trim())) // skip separator rows
        .map((l) =>
          l
            .split("|")
            .slice(1, -1)
            .map((c) => c.trim())
        );
      if (parsedRows.length > 0) {
        blocks.push({
          type: "table",
          headers: parsedRows[0],
          rows: parsedRows.slice(1),
        });
      }
      continue;
    }

    // Status line pattern: [status] Title or - [status] Title
    const statusMatch = line.match(
      /^\s*[-*]?\s*\[(\w+(?:[_ ]\w+)?)\]\s+(.+)/
    );
    if (statusMatch) {
      blocks.push({
        type: "status",
        status: statusMatch[1],
        label: statusMatch[2],
      });
      i++;
      continue;
    }

    // Bullet list
    const bulletMatch = line.match(/^(\s*)[-*]\s+(.*)/);
    if (bulletMatch) {
      const indent = Math.floor(bulletMatch[1].length / 2);
      blocks.push({ type: "bullet", text: bulletMatch[2], indent });
      i++;
      continue;
    }

    // Empty line → skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph — collect consecutive non-empty lines
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("#") &&
      !lines[i].startsWith("```") &&
      !lines[i].startsWith("|") &&
      !/^[-*]\s/.test(lines[i]) &&
      !/^---+$/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", text: paraLines.join(" ") });
  }

  return blocks;
}

// ── Status badge color ──
function statusColor(status: string): string {
  const s = status.toLowerCase().replace(/[_ ]/g, "");
  if (["completed", "done", "complete"].includes(s)) return C.statusDone;
  if (["inprogress", "active", "planning", "planned"].includes(s))
    return C.statusActive;
  if (["pending", "stale", "waiting"].includes(s)) return C.statusPending;
  return C.textDim;
}

// ── Block renderers ──
function MarkdownContent({ content }: { content: string }) {
  const blocks = useMemo(() => parseBlocks(content), [content]);

  return (
    <>
      {blocks.map((block, i) => {
        switch (block.type) {
          case "h1":
            return (
              <View key={i} style={{ marginTop: i > 0 ? 14 : 0, marginBottom: 6 }}>
                <Text
                  style={{
                    color: C.accent,
                    fontSize: 16,
                    fontWeight: "700",
                    letterSpacing: 0.5,
                  }}
                >
                  {block.text}
                </Text>
                <View
                  style={{
                    height: 1,
                    backgroundColor: C.accentDim,
                    marginTop: 4,
                  }}
                />
              </View>
            );

          case "h2":
            return (
              <View key={i} style={{ marginTop: 12, marginBottom: 4 }}>
                <Text
                  style={{
                    color: C.textBright,
                    fontSize: 14,
                    fontWeight: "700",
                    letterSpacing: 0.3,
                  }}
                >
                  {block.text}
                </Text>
              </View>
            );

          case "h3":
            return (
              <View key={i} style={{ marginTop: 10, marginBottom: 3 }}>
                <Text
                  style={{
                    color: C.textBright,
                    fontSize: 13,
                    fontWeight: "600",
                  }}
                >
                  {block.text}
                </Text>
              </View>
            );

          case "paragraph":
            return (
              <View key={i} style={{ marginVertical: 3 }}>
                <Text style={{ fontSize: 13, lineHeight: 19 }} selectable>
                  <InlineText text={block.text} />
                </Text>
              </View>
            );

          case "bullet":
            return (
              <View
                key={i}
                style={{
                  flexDirection: "row",
                  paddingLeft: 8 + block.indent * 14,
                  marginVertical: 2,
                }}
              >
                <View
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 2.5,
                    backgroundColor:
                      block.indent === 0 ? C.bullet : C.textDim,
                    marginTop: 7,
                    marginRight: 8,
                  }}
                />
                <Text
                  style={{ flex: 1, fontSize: 13, lineHeight: 19 }}
                  selectable
                >
                  <InlineText text={block.text} />
                </Text>
              </View>
            );

          case "status":
            return (
              <View
                key={i}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingLeft: 8,
                  marginVertical: 3,
                }}
              >
                <View
                  style={{
                    paddingHorizontal: 6,
                    paddingVertical: 2,
                    borderRadius: 4,
                    backgroundColor: "rgba(0,0,0,0.3)",
                    borderWidth: 1,
                    borderColor: statusColor(block.status) + "40",
                    marginRight: 8,
                  }}
                >
                  <Text
                    style={{
                      color: statusColor(block.status),
                      fontSize: 10,
                      fontFamily: "monospace",
                      fontWeight: "600",
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                    }}
                  >
                    {block.status}
                  </Text>
                </View>
                <Text
                  style={{ color: C.text, fontSize: 13, flex: 1 }}
                  selectable
                >
                  <InlineText text={block.label} />
                </Text>
              </View>
            );

          case "codeblock":
            return (
              <View
                key={i}
                style={{
                  marginVertical: 6,
                  borderRadius: 8,
                  backgroundColor: C.codeBg,
                  borderWidth: 1,
                  borderColor: C.codeBorder,
                  overflow: "hidden",
                }}
              >
                {block.lang ? (
                  <View
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 4,
                      borderBottomWidth: 1,
                      borderBottomColor: C.codeBorder,
                    }}
                  >
                    <Text
                      style={{
                        color: C.textDim,
                        fontSize: 10,
                        fontFamily: "monospace",
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                      }}
                    >
                      {block.lang}
                    </Text>
                  </View>
                ) : null}
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <Text
                    style={{
                      color: C.codeText,
                      fontSize: 12,
                      fontFamily: "monospace",
                      lineHeight: 18,
                      padding: 10,
                    }}
                    selectable
                  >
                    {block.text}
                  </Text>
                </ScrollView>
              </View>
            );

          case "table":
            return (
              <View
                key={i}
                style={{
                  marginVertical: 6,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: C.tableBorder,
                  overflow: "hidden",
                }}
              >
                {/* Header row */}
                <View
                  style={{
                    flexDirection: "row",
                    backgroundColor: C.tableHeaderBg,
                    borderBottomWidth: 1,
                    borderBottomColor: C.tableBorder,
                  }}
                >
                  {block.headers.map((h, j) => (
                    <View
                      key={j}
                      style={{
                        flex: 1,
                        paddingHorizontal: 8,
                        paddingVertical: 6,
                        borderRightWidth:
                          j < block.headers.length - 1 ? 1 : 0,
                        borderRightColor: C.tableBorder,
                      }}
                    >
                      <Text
                        style={{
                          color: C.accent,
                          fontSize: 11,
                          fontWeight: "700",
                          fontFamily: "monospace",
                        }}
                      >
                        {h}
                      </Text>
                    </View>
                  ))}
                </View>
                {/* Data rows */}
                {block.rows.map((row, ri) => (
                  <View
                    key={ri}
                    style={{
                      flexDirection: "row",
                      borderBottomWidth:
                        ri < block.rows.length - 1 ? 1 : 0,
                      borderBottomColor: C.tableBorder,
                      backgroundColor:
                        ri % 2 === 0
                          ? "transparent"
                          : "rgba(255,255,255,0.02)",
                    }}
                  >
                    {row.map((cell, j) => (
                      <View
                        key={j}
                        style={{
                          flex: 1,
                          paddingHorizontal: 8,
                          paddingVertical: 5,
                          borderRightWidth:
                            j < row.length - 1 ? 1 : 0,
                          borderRightColor: C.tableBorder,
                        }}
                      >
                        <Text
                          style={{
                            color: C.text,
                            fontSize: 11,
                            fontFamily: "monospace",
                          }}
                          selectable
                        >
                          {cell}
                        </Text>
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            );

          case "hr":
            return (
              <View
                key={i}
                style={{
                  height: 1,
                  backgroundColor: C.tableBorder,
                  marginVertical: 10,
                }}
              />
            );

          default:
            return null;
        }
      })}
    </>
  );
}

// ── Pre-computed ray/particle angles ──
const RAY_ANGLES = Array.from({ length: NUM_RAYS }, (_, i) => (i * 2 * Math.PI) / NUM_RAYS);
const PARTICLE_ANGLES = Array.from({ length: NUM_PARTICLES }, (_, i) => (i * 2 * Math.PI) / NUM_PARTICLES);

// ── Main Panel with Loot-Box Animation ──
export function ContentPanel({
  visible,
  title,
  content,
  onClose,
}: ContentPanelProps) {
  const [shouldRender, setShouldRender] = useState(false);
  // Must be called unconditionally (Rules of Hooks)
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();

  // ── Animated values ──
  // Phase 1: Light burst
  const burstScale = useRef(new Animated.Value(0)).current;
  const burstOpacity = useRef(new Animated.Value(0)).current;

  // Phase 2: Rays & particles convergence
  const rayProgress = useRef(new Animated.Value(0)).current;
  const rayOpacity = useRef(new Animated.Value(0)).current;
  const particleProgress = useRef(new Animated.Value(0)).current;
  const particleOpacity = useRef(new Animated.Value(0)).current;

  // Phase 3: Panel materialization
  const panelScale = useRef(new Animated.Value(0.3)).current;
  const panelOpacity = useRef(new Animated.Value(0)).current;

  // Phase 4: Afterglow
  const afterglowOpacity = useRef(new Animated.Value(0)).current;

  // Shimmer glow (ongoing)
  const glowAnim = useRef(new Animated.Value(0)).current;

  // Close animation extras
  const closeBurstScale = useRef(new Animated.Value(0)).current;
  const closeBurstOpacity = useRef(new Animated.Value(0)).current;

  const resetAnimValues = useCallback(() => {
    burstScale.setValue(0);
    burstOpacity.setValue(0);
    rayProgress.setValue(0);
    rayOpacity.setValue(0);
    particleProgress.setValue(0);
    particleOpacity.setValue(0);
    panelScale.setValue(0.3);
    panelOpacity.setValue(0);
    afterglowOpacity.setValue(0);
    closeBurstScale.setValue(0);
    closeBurstOpacity.setValue(0);
  }, []);

  // ── Opening animation ──
  useEffect(() => {
    if (visible) {
      resetAnimValues();
      setShouldRender(true);

      // Phase 1: Light burst (0-400ms)
      const phase1 = Animated.parallel([
        Animated.timing(burstOpacity, {
          toValue: 1,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(burstScale, {
          toValue: 15,
          duration: 400,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]);
      const phase1Fade = Animated.timing(burstOpacity, {
        toValue: 0,
        duration: 250,
        delay: 150,
        useNativeDriver: true,
      });

      // Phase 2: Energy convergence (200-600ms)
      const phase2 = Animated.parallel([
        Animated.timing(rayOpacity, {
          toValue: 1,
          duration: 100,
          delay: 200,
          useNativeDriver: true,
        }),
        Animated.timing(rayProgress, {
          toValue: 1,
          duration: 400,
          delay: 200,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(particleOpacity, {
          toValue: 1,
          duration: 100,
          delay: 250,
          useNativeDriver: true,
        }),
        Animated.timing(particleProgress, {
          toValue: 1,
          duration: 350,
          delay: 250,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]);
      const phase2Fade = Animated.parallel([
        Animated.timing(rayOpacity, {
          toValue: 0,
          duration: 150,
          delay: 550,
          useNativeDriver: true,
        }),
        Animated.timing(particleOpacity, {
          toValue: 0,
          duration: 150,
          delay: 550,
          useNativeDriver: true,
        }),
      ]);

      // Phase 3: Panel materialization (400-800ms)
      const phase3 = Animated.parallel([
        Animated.timing(panelOpacity, {
          toValue: 1,
          duration: 300,
          delay: 400,
          useNativeDriver: true,
        }),
        Animated.spring(panelScale, {
          toValue: 1,
          friction: 8,
          tension: 65,
          delay: 400,
          useNativeDriver: true,
        }),
      ]);

      // Phase 4: Afterglow settle (800-1000ms)
      const phase4 = Animated.sequence([
        Animated.timing(afterglowOpacity, {
          toValue: 0.8,
          duration: 200,
          delay: 800,
          useNativeDriver: true,
        }),
        Animated.timing(afterglowOpacity, {
          toValue: 0.3,
          duration: 200,
          useNativeDriver: true,
        }),
      ]);

      // Run all phases together (delays handle orchestration)
      const openAnim = Animated.parallel([
        phase1,
        phase1Fade,
        phase2,
        phase2Fade,
        phase3,
        phase4,
      ]);
      openAnim.start();
      return () => openAnim.stop();
    } else if (shouldRender) {
      // ── Closing animation ──
      // Panel dissolve
      const closePanel = Animated.parallel([
        Animated.timing(panelOpacity, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(panelScale, {
          toValue: 0.85,
          duration: 300,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]);

      // Afterglow flare + fade
      const closeGlow = Animated.sequence([
        Animated.timing(afterglowOpacity, {
          toValue: 0.9,
          duration: 100,
          useNativeDriver: true,
        }),
        Animated.timing(afterglowOpacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]);

      // Collapse-into-light burst
      const closeBurst = Animated.parallel([
        Animated.timing(closeBurstOpacity, {
          toValue: 0.8,
          duration: 150,
          delay: 100,
          useNativeDriver: true,
        }),
        Animated.timing(closeBurstScale, {
          toValue: 3,
          duration: 200,
          delay: 100,
          useNativeDriver: true,
        }),
        Animated.timing(closeBurstOpacity, {
          toValue: 0,
          duration: 200,
          delay: 250,
          useNativeDriver: true,
        }),
      ]);

      const closeAnim = Animated.parallel([closePanel, closeGlow, closeBurst]);
      closeAnim.start(() => {
        setShouldRender(false);
        resetAnimValues();
      });
      return () => closeAnim.stop();
    }
  }, [visible]);

  // Shimmer glow (runs while panel is visible)
  useEffect(() => {
    if (!shouldRender) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, {
          toValue: 1,
          duration: SHIMMER_PERIOD / 2,
          useNativeDriver: false,
        }),
        Animated.timing(glowAnim, {
          toValue: 0,
          duration: SHIMMER_PERIOD / 2,
          useNativeDriver: false,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [shouldRender]);

  if (!shouldRender) return null;

  const panelWidth = Math.min(screenWidth * 0.6, 600);
  const panelHeight = screenHeight * 0.65;

  // Center of the panel in absolute coordinates (for burst/ray origin)
  const panelCenterX = 20 + panelWidth / 2;
  const panelCenterY = screenHeight - 20 - panelHeight / 2;

  const glowOpacity = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 0.7],
  });

  return (
    <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 }} pointerEvents="box-none">
      {/* ── Light burst (Phase 1) ── */}
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: panelCenterX - 15,
          top: panelCenterY - 15,
          width: 30,
          height: 30,
          borderRadius: 15,
          backgroundColor: BURST_COLOR,
          opacity: burstOpacity,
          transform: [{ scale: burstScale }],
        }}
      />

      {/* ── Energy rays (Phase 2) ── */}
      {RAY_ANGLES.map((angle, i) => {
        const startX = Math.cos(angle) * RAY_DISTANCE;
        const startY = Math.sin(angle) * RAY_DISTANCE;
        const tx = rayProgress.interpolate({
          inputRange: [0, 1],
          outputRange: [startX, 0],
        });
        const ty = rayProgress.interpolate({
          inputRange: [0, 1],
          outputRange: [startY, 0],
        });
        const rotation = (angle * 180) / Math.PI;
        return (
          <Animated.View
            key={`ray-${i}`}
            pointerEvents="none"
            style={{
              position: "absolute",
              left: panelCenterX - 15,
              top: panelCenterY - 1,
              width: 30,
              height: 2,
              borderRadius: 1,
              backgroundColor: RAY_COLOR,
              opacity: rayOpacity,
              transform: [
                { translateX: tx },
                { translateY: ty },
                { rotate: `${rotation}deg` },
              ],
            }}
          />
        );
      })}

      {/* ── Converging particles (Phase 2) ── */}
      {PARTICLE_ANGLES.map((angle, i) => {
        const startX = Math.cos(angle) * PARTICLE_DISTANCE;
        const startY = Math.sin(angle) * PARTICLE_DISTANCE;
        const tx = particleProgress.interpolate({
          inputRange: [0, 1],
          outputRange: [startX, 0],
        });
        const ty = particleProgress.interpolate({
          inputRange: [0, 1],
          outputRange: [startY, 0],
        });
        const pScale = particleProgress.interpolate({
          inputRange: [0, 0.5, 1],
          outputRange: [0.5, 1.2, 0.3],
        });
        return (
          <Animated.View
            key={`particle-${i}`}
            pointerEvents="none"
            style={{
              position: "absolute",
              left: panelCenterX - 3,
              top: panelCenterY - 3,
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: PARTICLE_COLOR,
              opacity: particleOpacity,
              transform: [
                { translateX: tx },
                { translateY: ty },
                { scale: pScale },
              ],
            }}
          />
        );
      })}

      {/* ── Afterglow (behind panel) ── */}
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: panelCenterX - panelWidth * 0.4,
          top: panelCenterY - panelHeight * 0.3,
          width: panelWidth * 0.8,
          height: panelHeight * 0.6,
          borderRadius: panelWidth * 0.4,
          backgroundColor: "rgba(59,130,246,0.15)",
          opacity: afterglowOpacity,
        }}
      />

      {/* ── Close burst (collapse-into-light) ── */}
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: panelCenterX - 10,
          top: panelCenterY - 10,
          width: 20,
          height: 20,
          borderRadius: 10,
          backgroundColor: BURST_COLOR,
          opacity: closeBurstOpacity,
          transform: [{ scale: closeBurstScale }],
        }}
      />

      {/* ── Panel (Phase 3: materializes with spring) ── */}
      <Animated.View
        style={{
          position: "absolute",
          bottom: 20,
          left: 20,
          width: panelWidth,
          height: panelHeight,
          opacity: panelOpacity,
          transform: [{ scale: panelScale }],
        }}
      >
        {/* Glow border */}
        <Animated.View
          style={{
            position: "absolute",
            top: -2,
            left: -2,
            right: -2,
            bottom: -2,
            borderRadius: 14,
            borderWidth: 1.5,
            borderColor: RARE.border,
            ...(Platform.OS === "web"
              ? {}
              : {
                  elevation: 8,
                  shadowColor: RARE.glow,
                  shadowOffset: { width: 0, height: 0 },
                  shadowOpacity: glowOpacity as any,
                  shadowRadius: 12,
                }),
          }}
        />

        {/* Panel container */}
        <View
          style={{
            flex: 1,
            borderRadius: 12,
            overflow: "hidden",
            backgroundColor: C.bg,
          }}
        >
          {/* Header */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingVertical: 8,
              paddingHorizontal: 14,
              backgroundColor: C.headerBg,
              borderBottomWidth: 1,
              borderBottomColor: C.headerBorder,
            }}
          >
            <View
              style={{ flexDirection: "row", alignItems: "center", flex: 1 }}
            >
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: RARE.border,
                  marginRight: 8,
                }}
              />
              <Text
                style={{
                  color: RARE.text,
                  fontSize: 12,
                  fontFamily: "monospace",
                  fontWeight: "600",
                  letterSpacing: 1,
                  textTransform: "uppercase",
                }}
                numberOfLines={1}
              >
                {title || "CIPHER OUTPUT"}
              </Text>
            </View>

            <TVPressable
              rarity="rare"
              onPress={onClose}
              style={{ paddingHorizontal: 10, paddingVertical: 4 }}
            >
              <Text
                style={{
                  color: RARE.text,
                  fontSize: 10,
                  fontFamily: "monospace",
                  fontWeight: "600",
                  letterSpacing: 1,
                }}
              >
                CLOSE
              </Text>
            </TVPressable>
          </View>

          {/* Content */}
          <ScrollView
            style={{ flex: 1, paddingHorizontal: 14, paddingVertical: 10 }}
            showsVerticalScrollIndicator={true}
          >
            <MarkdownContent content={content} />
            <View style={{ height: 16 }} />
          </ScrollView>
        </View>
      </Animated.View>
    </View>
  );
}
