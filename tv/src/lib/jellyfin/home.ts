// Home-screen rails. Enum-valued params are passed as their literal API string
// values (cast) so they serialize correctly regardless of SDK enum naming.

import {
  getItemsApi,
  getUserLibraryApi,
  getUserViewsApi,
} from "@jellyfin/sdk/lib/utils/api";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { getApi } from "./client";

const IMG = ["Primary", "Backdrop", "Thumb", "Logo"];
const FIELDS = ["PrimaryImageAspectRatio", "Overview"];

export async function getContinueWatching(userId: string): Promise<BaseItemDto[]> {
  const { data } = await getItemsApi(getApi()).getResumeItems({
    userId,
    limit: 16,
    mediaTypes: ["Video"],
    fields: FIELDS,
    enableImageTypes: IMG,
  } as any);
  return data.Items ?? [];
}

export async function getLatest(userId: string, parentId?: string): Promise<BaseItemDto[]> {
  const { data } = await getUserLibraryApi(getApi()).getLatestMedia({
    userId,
    parentId,
    limit: 18,
    fields: FIELDS,
    enableImageTypes: IMG,
  } as any);
  return data ?? [];
}

export interface LibraryView {
  id: string;
  name: string;
  collectionType?: string;
}

export async function getLibraries(userId: string): Promise<LibraryView[]> {
  const { data } = await getUserViewsApi(getApi()).getUserViews({ userId } as any);
  return (data.Items ?? [])
    .filter((v) => !!v.Id)
    .map((v) => ({
      id: v.Id as string,
      name: v.Name ?? "Library",
      collectionType: (v.CollectionType as string) ?? undefined,
    }));
}

/** Items inside one library view (for "Latest in <library>" rails and the grid). */
export async function getItemsInView(
  userId: string,
  parentId: string,
  limit = 24
): Promise<BaseItemDto[]> {
  const { data } = await getItemsApi(getApi()).getItems({
    userId,
    parentId,
    recursive: true,
    includeItemTypes: ["Movie", "Series"],
    sortBy: ["DateCreated"],
    sortOrder: ["Descending"],
    limit,
    fields: FIELDS,
    enableImageTypes: IMG,
  } as any);
  return data.Items ?? [];
}
