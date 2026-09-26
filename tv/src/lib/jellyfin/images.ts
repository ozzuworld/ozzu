// Jellyfin image URLs. Built manually (the SDK URL helpers vary by version and
// can't be tested here) — these query params are the stable Jellyfin contract.
// Images route through the same bridge proxy as everything else.

import { getBaseUrl, getAccessToken } from "./client";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";

export function qs(params: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

function imageUrl(
  itemId: string,
  type: string,
  tag: string | undefined,
  fillWidth: number
): string {
  const token = getAccessToken();
  const query = qs({ tag, fillWidth, quality: 90, api_key: token });
  return `${getBaseUrl()}/Items/${itemId}/Images/${type}?${query}`;
}

/** Vertical poster (2:3). Falls back to the parent series poster for episodes. */
export function posterUrl(item: BaseItemDto, fillWidth = 400): string | undefined {
  const id = item.Id;
  const primary = item.ImageTags?.Primary;
  if (id && primary) return imageUrl(id, "Primary", primary, fillWidth);
  if (item.SeriesId && item.SeriesPrimaryImageTag) {
    return imageUrl(item.SeriesId, "Primary", item.SeriesPrimaryImageTag, fillWidth);
  }
  return undefined;
}

/** Wide backdrop (16:9). Falls back to a parent backdrop. */
export function backdropUrl(item: BaseItemDto, fillWidth = 1920): string | undefined {
  const id = item.Id;
  const tags = item.BackdropImageTags;
  if (id && tags && tags.length) return imageUrl(id, "Backdrop", tags[0], fillWidth);
  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length) {
    return imageUrl(item.ParentBackdropItemId, "Backdrop", item.ParentBackdropImageTags[0], fillWidth);
  }
  return undefined;
}

/** Title logo art (for the hero). */
export function logoUrl(item: BaseItemDto, fillWidth = 600): string | undefined {
  const id = item.Id;
  const tag = item.ImageTags?.Logo;
  if (id && tag) return imageUrl(id, "Logo", tag, fillWidth);
  return undefined;
}

/** Landscape thumbnail for Continue Watching rows. */
export function thumbUrl(item: BaseItemDto, fillWidth = 700): string | undefined {
  const id = item.Id;
  const thumb = item.ImageTags?.Thumb;
  if (id && thumb) return imageUrl(id, "Thumb", thumb, fillWidth);
  return backdropUrl(item, fillWidth) || posterUrl(item, fillWidth);
}
