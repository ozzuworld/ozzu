import { useEffect, useRef, useMemo } from "react";
import {
  View,
  Text,
  Animated,
  Dimensions,
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

// ── Main Panel ──
export function ContentPanel({
  visible,
  title,
  content,
  onClose,
}: ContentPanelProps) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(40)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: 40,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible]);

  // Shimmer glow
  useEffect(() => {
    if (!visible) return;
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
  }, [visible]);

  if (!visible) return null;

  const { width: screenWidth, height: screenHeight } = Dimensions.get("window");
  const panelWidth = Math.min(screenWidth * 0.6, 600);
  const panelHeight = screenHeight * 0.65;

  const glowOpacity = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 0.7],
  });

  return (
    <Animated.View
      style={{
        position: "absolute",
        bottom: 20,
        left: 20,
        width: panelWidth,
        height: panelHeight,
        opacity: fadeAnim,
        transform: [{ translateY: slideAnim }],
        zIndex: 100,
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
  );
}
