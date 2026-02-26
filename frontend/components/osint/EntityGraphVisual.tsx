import { useState, useMemo, useCallback } from "react";
import { View, Text, Pressable } from "react-native";
import Svg, { Circle, Line, Text as SvgText } from "react-native-svg";

// Entity type colors
const TYPE_COLORS: Record<string, string> = {
  person: "#06B6D4",
  email: "#3B82F6",
  username: "#22C55E",
  phone: "#A855F7",
  domain: "#8B5CF6",
  ip: "#F97316",
  social_account: "#F59E0B",
  organization: "#EF4444",
  location: "#10B981",
  image: "#EC4899",
};

interface Entity {
  id: number;
  entity_type: string;
  value: string;
  label: string | null;
}

interface Relationship {
  id: number;
  source_entity_id: number;
  target_entity_id: number;
  relationship: string;
  confidence: number;
}

interface Props {
  entities: Entity[];
  relationships: Relationship[];
  width?: number;
  height?: number;
}

// Fruchterman-Reingold force-directed layout (simplified)
function computeLayout(entities: Entity[], relationships: Relationship[], width: number, height: number) {
  if (entities.length === 0) return [];

  const k = Math.sqrt((width * height) / entities.length) * 0.5;
  const iterations = 50;

  // Initialize positions randomly
  const positions: { x: number; y: number }[] = entities.map(() => ({
    x: Math.random() * (width - 40) + 20,
    y: Math.random() * (height - 40) + 20,
  }));

  const idToIdx: Record<number, number> = {};
  entities.forEach((e, i) => { idToIdx[e.id] = i; });

  for (let iter = 0; iter < iterations; iter++) {
    const temp = (1 - iter / iterations) * 10;
    const disp: { dx: number; dy: number }[] = positions.map(() => ({ dx: 0, dy: 0 }));

    // Repulsive forces between all pairs
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const dx = positions[i].x - positions[j].x;
        const dy = positions[i].y - positions[j].y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        disp[i].dx += fx;
        disp[i].dy += fy;
        disp[j].dx -= fx;
        disp[j].dy -= fy;
      }
    }

    // Attractive forces along edges
    for (const rel of relationships) {
      const si = idToIdx[rel.source_entity_id];
      const ti = idToIdx[rel.target_entity_id];
      if (si === undefined || ti === undefined) continue;

      const dx = positions[si].x - positions[ti].x;
      const dy = positions[si].y - positions[ti].y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      disp[si].dx -= fx;
      disp[si].dy -= fy;
      disp[ti].dx += fx;
      disp[ti].dy += fy;
    }

    // Apply displacements with temperature
    for (let i = 0; i < positions.length; i++) {
      const dispLen = Math.sqrt(disp[i].dx * disp[i].dx + disp[i].dy * disp[i].dy);
      if (dispLen > 0) {
        const scale = Math.min(dispLen, temp) / dispLen;
        positions[i].x += disp[i].dx * scale;
        positions[i].y += disp[i].dy * scale;
      }
      // Keep within bounds
      positions[i].x = Math.max(20, Math.min(width - 20, positions[i].x));
      positions[i].y = Math.max(20, Math.min(height - 20, positions[i].y));
    }
  }

  return positions;
}

export function EntityGraphVisual({ entities, relationships, width = 350, height = 300 }: Props) {
  const [selected, setSelected] = useState<number | null>(null);

  const positions = useMemo(
    () => computeLayout(entities, relationships, width, height),
    [entities, relationships, width, height]
  );

  const idToIdx = useMemo(() => {
    const map: Record<number, number> = {};
    entities.forEach((e, i) => { map[e.id] = i; });
    return map;
  }, [entities]);

  const selectedEntity = selected !== null ? entities.find((e) => e.id === selected) : null;
  const selectedRels = selected !== null
    ? relationships.filter((r) => r.source_entity_id === selected || r.target_entity_id === selected)
    : [];

  if (entities.length === 0) {
    return (
      <View style={{ padding: 20, alignItems: "center" }}>
        <Text style={{ color: "#525252", fontSize: 11, fontFamily: "monospace" }}>No entities to visualize</Text>
      </View>
    );
  }

  return (
    <View>
      <View style={{ backgroundColor: "#0A0A0A", borderRadius: 10, borderWidth: 1, borderColor: "#222", overflow: "hidden" }}>
        <Svg width={width} height={height}>
          {/* Edges */}
          {relationships.map((rel) => {
            const si = idToIdx[rel.source_entity_id];
            const ti = idToIdx[rel.target_entity_id];
            if (si === undefined || ti === undefined) return null;
            const isHighlighted = selected === rel.source_entity_id || selected === rel.target_entity_id;
            return (
              <Line
                key={rel.id}
                x1={positions[si]?.x || 0}
                y1={positions[si]?.y || 0}
                x2={positions[ti]?.x || 0}
                y2={positions[ti]?.y || 0}
                stroke={isHighlighted ? "#06B6D4" : "#333"}
                strokeWidth={Math.max(1, rel.confidence / 40)}
                opacity={isHighlighted ? 0.8 : 0.3}
              />
            );
          })}

          {/* Nodes */}
          {entities.map((entity, i) => {
            const pos = positions[i];
            if (!pos) return null;
            const color = TYPE_COLORS[entity.entity_type] || "#6B7280";
            const isSelected = selected === entity.id;
            const isNeighbor = selectedRels.some(
              (r) => r.source_entity_id === entity.id || r.target_entity_id === entity.id
            );
            const radius = isSelected ? 10 : isNeighbor ? 8 : 6;

            return (
              <Circle
                key={entity.id}
                cx={pos.x}
                cy={pos.y}
                r={radius}
                fill={color}
                opacity={selected === null || isSelected || isNeighbor ? 1 : 0.3}
                onPress={() => setSelected(isSelected ? null : entity.id)}
              />
            );
          })}

          {/* Labels for selected + neighbors */}
          {entities.map((entity, i) => {
            const pos = positions[i];
            if (!pos) return null;
            const isSelected = selected === entity.id;
            const isNeighbor = selectedRels.some(
              (r) => r.source_entity_id === entity.id || r.target_entity_id === entity.id
            );
            if (!isSelected && !isNeighbor) return null;

            const label = (entity.label || entity.value).substring(0, 15);
            return (
              <SvgText
                key={`label-${entity.id}`}
                x={pos.x}
                y={pos.y - 12}
                fill={isSelected ? "#E5E5E5" : "#737373"}
                fontSize={9}
                fontFamily="monospace"
                textAnchor="middle"
              >
                {label}
              </SvgText>
            );
          })}
        </Svg>
      </View>

      {/* Legend */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8, paddingHorizontal: 4 }}>
        {Object.entries(TYPE_COLORS).map(([type, color]) => {
          const count = entities.filter((e) => e.entity_type === type).length;
          if (count === 0) return null;
          return (
            <View key={type} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
              <Text style={{ color: "#525252", fontSize: 9, fontFamily: "monospace" }}>{type.replace("_", " ")} ({count})</Text>
            </View>
          );
        })}
      </View>

      {/* Selected entity detail */}
      {selectedEntity && (
        <View style={{ backgroundColor: "#1A1A1A", borderRadius: 8, padding: 10, marginTop: 8 }}>
          <Text style={{ color: TYPE_COLORS[selectedEntity.entity_type] || "#6B7280", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>
            {selectedEntity.entity_type.toUpperCase()}: {selectedEntity.label || selectedEntity.value}
          </Text>
          {selectedRels.length > 0 && (
            <View style={{ marginTop: 4, gap: 2 }}>
              {selectedRels.slice(0, 8).map((rel) => {
                const other = rel.source_entity_id === selected
                  ? entities.find((e) => e.id === rel.target_entity_id)
                  : entities.find((e) => e.id === rel.source_entity_id);
                return (
                  <Text key={rel.id} style={{ color: "#737373", fontSize: 9, fontFamily: "monospace" }}>
                    {rel.relationship.replace(/_/g, " ")} → {other?.label || other?.value || "?"} ({rel.confidence}%)
                  </Text>
                );
              })}
            </View>
          )}
        </View>
      )}
    </View>
  );
}
