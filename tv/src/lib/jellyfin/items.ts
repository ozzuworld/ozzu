// Single-item detail. (Series seasons/episodes + Next Up land in Phase 2.)

import { getUserLibraryApi } from "@jellyfin/sdk/lib/utils/api";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { getApi } from "./client";

export async function getItemDetail(userId: string, itemId: string): Promise<BaseItemDto> {
  const { data } = await getUserLibraryApi(getApi()).getItem({ userId, itemId } as any);
  return data;
}
