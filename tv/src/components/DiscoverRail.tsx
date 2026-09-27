import React, { useRef } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { colors, poster, spacing, fontSize, fontWeight, screenPad } from "../lib/theme";
import { DiscoverCard } from "./DiscoverCard";
import type { DiscoverItem } from "../lib/seerr";

const STRIDE = poster.width + poster.gap;

/**
 * Horizontal discovery rail (Seerr lane) — the DiscoverItem sibling of MediaRail.
 * Same geometry + focus-scroll behavior so mixed home rails feel uniform.
 */
export function DiscoverRail({
  title,
  items,
  onSelect,
  firstItemFocus = false,
  onRowFocus,
}: {
  title: string;
  items: DiscoverItem[];
  onSelect: (item: DiscoverItem) => void;
  firstItemFocus?: boolean;
  onRowFocus?: () => void;
}) {
  const listRef = useRef<FlatList<DiscoverItem>>(null);

  if (!items.length) return null;

  return (
    <View style={styles.rail}>
      <Text style={styles.title}>{title}</Text>
      <FlatList
        ref={listRef}
        data={items}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(it, i) => `${it.mediaType}-${it.tmdbId}-${i}`}
        contentContainerStyle={styles.content}
        ItemSeparatorComponent={Separator}
        initialNumToRender={8}
        windowSize={5}
        removeClippedSubviews={false}
        // getItemLayout guards scrollToIndex from throwing on un-rendered items.
        getItemLayout={(_, index) => ({ length: STRIDE, offset: STRIDE * index, index })}
        renderItem={({ item, index }) => (
          <DiscoverCard
            item={item}
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
  return <View style={{ width: poster.gap }} />;
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
  // vertical padding gives the 1.1 focus scale room to breathe without clipping.
  content: { paddingHorizontal: screenPad, paddingVertical: spacing.sm },
});
