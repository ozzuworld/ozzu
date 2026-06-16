// Playback: stream URL + progress reporting (drives Continue Watching / resume).
//
// Phase 1 uses direct static streaming — ExoPlayer (under expo-video on Android
// TV) decodes most container/codec combos (MKV/MP4, H.264/HEVC, AAC/AC3), so a
// transcode fallback (PlaybackInfo + HLS) is deferred to Phase 3.

import { getPlaystateApi } from "@jellyfin/sdk/lib/utils/api";
import { getApi, getBaseUrl, getAccessToken, getDeviceId } from "./client";
import { qs } from "./images";
import { secondsToTicks } from "../format";

/** Direct-play URL for expo-video. */
export function directStreamUrl(itemId: string, mediaSourceId?: string): string {
  const query = qs({
    static: true,
    mediaSourceId,
    deviceId: getDeviceId(),
    api_key: getAccessToken(),
  });
  return `${getBaseUrl()}/Videos/${itemId}/stream?${query}`;
}

export async function reportStart(itemId: string, positionSeconds: number): Promise<void> {
  try {
    await getPlaystateApi(getApi()).reportPlaybackStart({
      playbackStartInfo: {
        ItemId: itemId,
        PositionTicks: secondsToTicks(positionSeconds),
        CanSeek: true,
        PlayMethod: "DirectPlay",
      },
    } as any);
  } catch {
    /* best-effort */
  }
}

export async function reportProgress(
  itemId: string,
  positionSeconds: number,
  isPaused: boolean
): Promise<void> {
  try {
    await getPlaystateApi(getApi()).reportPlaybackProgress({
      playbackProgressInfo: {
        ItemId: itemId,
        PositionTicks: secondsToTicks(positionSeconds),
        IsPaused: isPaused,
        PlayMethod: "DirectPlay",
      },
    } as any);
  } catch {
    /* best-effort */
  }
}

export async function reportStopped(itemId: string, positionSeconds: number): Promise<void> {
  try {
    await getPlaystateApi(getApi()).reportPlaybackStopped({
      playbackStopInfo: {
        ItemId: itemId,
        PositionTicks: secondsToTicks(positionSeconds),
      },
    } as any);
  } catch {
    /* best-effort */
  }
}
