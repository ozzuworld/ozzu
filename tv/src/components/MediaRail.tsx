import React, { useRef } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { colors, poster, spacing, fontSize, fontWeight, screenPad } from "../lib/theme";
import { PosterCard } from "./PosterCard";

const STRIDE = poster.width + poster.gap;

export function MediaRail({
  title,
  items,
  onSelect,
  firstItemFocus = false,
  onRowFocus,
}: {
  title: string;
  items: BaseItemDto[];
  onSelect: (item: BaseItemDto) => void;
  firstItemFocus?: boolean;
  onRowFocus?: () => void;
}) {
  const listRef = useRef<FlatList<BaseItemDto>>(null);

  if (!items.length) return null;

  return (
    <View style={styles.rail}>
      <Text style={styles.title}>{title}</Text>
      <FlatList
        ref={listRef}
        data={items}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(it, i) => it.Id ?? String(i)}
        contentContainerStyle={styles.content}
        ItemSeparatorComponent={Separator}
        initialNumToRender={8}
        windowSize={5}
        removeClippedSubviews={false}
        // getItemLayout guards scrollToIndex from throwing on un-rendered items.
        getItemLayout={(_, index) => ({ length: STRIDE, offset: STRIDE * index, index })}
        renderItem={({ item, index }) => (
          <PosterCard
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
