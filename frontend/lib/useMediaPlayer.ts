import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useEntity } from "./useEntity";
import { useHA } from "./ha-context";

const ENTITY_ID = "media_player.spotify_king_kazuma";

export interface MediaPlayerState {
  state: "playing" | "paused" | "idle" | "off" | "unavailable";
  trackName: string;
  artist: string;
  albumName: string;
  albumArt: string;
  duration: number;
  position: number;
  volume: number;
  isPlaying: boolean;
  shuffle: boolean;
  repeat: string;
  source: string;
  available: boolean;
}

export interface MediaPlayerControls {
  playPause: () => void;
  nextTrack: () => void;
  prevTrack: () => void;
  setVolume: (v: number) => void;
  seek: (seconds: number) => void;
  toggleShuffle: () => void;
  setRepeat: (mode: string) => void;
}

export function useMediaPlayer(): {
  state: MediaPlayerState;
  controls: MediaPlayerControls;
} {
  const entity = useEntity(ENTITY_ID);
  const { callService } = useHA();
  const [position, setPosition] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const attrs = entity?.attributes ?? {};
  const entityState = (entity?.state ?? "unavailable") as MediaPlayerState["state"];
  const isPlaying = entityState === "playing";
  const shuffle = (attrs.shuffle as boolean) ?? false;

  // Extract position from entity and interpolate locally
  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    const haPosition = (attrs.media_position as number) ?? 0;
    const updatedAt = attrs.media_position_updated_at as string | undefined;

    if (updatedAt && isPlaying) {
      const elapsed = (Date.now() - new Date(updatedAt).getTime()) / 1000;
      setPosition(haPosition + Math.max(0, elapsed));

      timerRef.current = setInterval(() => {
        setPosition((p) => p + 1);
      }, 1000);
    } else {
      setPosition(haPosition);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [attrs.media_position, attrs.media_position_updated_at, isPlaying]);

  const duration = (attrs.media_duration as number) ?? 0;

  const state: MediaPlayerState = useMemo(
    () => ({
      state: entityState,
      trackName: (attrs.media_title as string) ?? "",
      artist: (attrs.media_artist as string) ?? "",
      albumName: (attrs.media_album_name as string) ?? "",
      albumArt: (attrs.entity_picture as string) ?? "",
      duration,
      position: Math.min(position, duration || Infinity),
      volume: (attrs.volume_level as number) ?? 0,
      isPlaying,
      shuffle,
      repeat: (attrs.repeat as string) ?? "off",
      source: (attrs.source as string) ?? "",
      available: !!entity && entityState !== "unavailable",
    }),
    [entityState, attrs, position, duration, isPlaying, shuffle, entity]
  );

  const svc = useCallback(
    (service: string, data?: Record<string, unknown>) => {
      callService("media_player", service, data, { entity_id: ENTITY_ID });
    },
    [callService]
  );

  const playPause = useCallback(() => svc("media_play_pause"), [svc]);
  const nextTrack = useCallback(() => svc("media_next_track"), [svc]);
  const prevTrack = useCallback(() => svc("media_previous_track"), [svc]);
  const setVolume = useCallback(
    (v: number) => svc("volume_set", { volume_level: v }),
    [svc]
  );
  const seek = useCallback(
    (seconds: number) => svc("media_seek", { seek_position: seconds }),
    [svc]
  );
  const toggleShuffle = useCallback(
    () => svc("shuffle_set", { shuffle: !shuffle }),
    [svc, shuffle]
  );
  const setRepeat = useCallback(
    (mode: string) => svc("repeat_set", { repeat: mode }),
    [svc]
  );

  const controls: MediaPlayerControls = useMemo(
    () => ({
      playPause,
      nextTrack,
      prevTrack,
      setVolume,
      seek,
      toggleShuffle,
      setRepeat,
    }),
    [playPause, nextTrack, prevTrack, setVolume, seek, toggleShuffle, setRepeat]
  );

  return { state, controls };
}
