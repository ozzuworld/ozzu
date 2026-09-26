import React, { useRef } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import type { Marker } from "../lib/bridge";
import { colors, thumb, spacing, fontSize, fontWeight, screenPad } from "../lib/theme";
import { MarkerCard } from "./MarkerCard";

const STRIDE = thumb.width + thumb.gap;

/** Horizontal rail of broker continue-watching markers (P2). Mirrors MediaRail's
 * geometry/focus behavior but renders MarkerCards (postgres rows, not Jellyfin items). */
export function MarkerRail({
  title,
  markers,
  onSelect,
  firstItemFocus = false,
  onRowFocus,
}: {
  title: string;
  markers: Marker[];
  onSelect: (m: Marker) => void;
  firstItemFocus?: boolean;
  onRowFocus?: () => void;
}) {
  const listRef = useRef<FlatList<Marker>>(null);

  if (!markers.length) return null;

  return (
    <View style={styles.rail}>
      <Text style={styles.title}>{title}</Text>
      <FlatList
        ref={listRef}
        data={markers}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(m) => String(m.id)}
        contentContainerStyle={styles.content}
        ItemSeparatorComponent={Separator}
        initialNumToRender={6}
        windowSize={5}
        removeClippedSubviews={false}
        getItemLayout={(_, index) => ({ length: STRIDE, offset: STRIDE * index, index })}
        renderItem={({ item, index }) => (
          <MarkerCard
            marker={item}
            hasTVPreferredFocus={firstItemFocus && index === 0}
            onPress={() => onSelect(item)}
            onFocus={() => {
              onRowFocus?.();
              listRef.current?.scrollToIndex({ index, viewPosition: 0.08, animated: true });
            }}
          />
        )}
      />
    </View>
  );
}

function Separator() {
  return <View style={{ width: thumb.gap }} />;
}

const styles = StyleSheet.create({
  rail: { marginBottom: spacing.xl },
  title: {
    color: colors.text.secondary,
    fontSize: fontSize.railTitle,
    fontWeight: fontWeight.semibold,
    marginLeft: screenPad,
    marginBottom: spacing.md,
  },
  content: { paddingHorizontal: screenPad, paddingVertical: spacing.sm },
});
