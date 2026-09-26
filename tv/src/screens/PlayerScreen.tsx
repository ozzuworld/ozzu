import React, { useEffect, useRef, useState } from "react";
import { BackHandler, StyleSheet, View } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";
import { useNavigation, useRoute } from "@react-navigation/native";
import {
  reportProgress,
  reportStart,
  reportStopped,
  streamSource,
} from "../lib/jellyfin/playback";
import { brokerRemove, markerUpsert } from "../lib/bridge";
import type { BrokerPlayParams } from "../navigation/routes";
import { Spinner } from "../components/States";
import { colors } from "../lib/theme";

// ≥92% watched = done. The marker flips watched:true (Maintainerr-compatible
// semantics) and — delete-after-watched client rule (research §9.2 ④) — the
// broker drops the torrent. The marker stays permanent: re-grab resumes from
// the offset (stremio fetches piece-deadline-first on seek).
const WATCHED_FRACTION = 0.92;

export function PlayerScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const itemId: string | undefined = route.params?.itemId;
  const broker: BrokerPlayParams | undefined = route.params?.broker;
  const startSeconds: number = (broker ? broker.startSeconds : route.params?.startSeconds) ?? 0;

  // Jellyfin lane: header-auth direct stream (JF12 rejects api_key query).
  // Broker lane: plain HTTP from stremio-server — no auth, Range-seek native.
  const source = broker ? { uri: broker.url } : streamSource(itemId as string);

  const [buffering, setBuffering] = useState(!!broker); // cold broker start joins the swarm first
  const seeked = useRef(false);
  const started = useRef(false);
  const posRef = useRef(startSeconds);
  const watchedSent = useRef(false);

  const player = useVideoPlayer(source, (p) => {
    p.timeUpdateEventInterval = 10;
    p.play();
  });

  const brokerMarker = (pos: number, watched: boolean) => {
    if (!broker) return;
    void markerUpsert({
      kind: broker.season != null || broker.episode != null ? "episode" : "movie",
      title: broker.title,
      season: broker.season ?? null,
      episode: broker.episode ?? null,
      infoHash: broker.infoHash,
      fileIdx: broker.fileIdx,
      fileName: broker.fileName ?? null,
      positionSeconds: Math.floor(pos),
      durationSeconds: Number.isFinite(player.duration) && player.duration > 0 ? Math.floor(player.duration) : null,
      watched,
    }).catch(() => { /* best-effort — bridge may be unreachable */ });
  };

  useEffect(() => {
    const statusSub = player.addListener("statusChange", ({ status }: any) => {
      if (status === "readyToPlay") {
        setBuffering(false);
        if (!seeked.current && startSeconds > 1) {
          seeked.current = true;
          player.currentTime = startSeconds; // broker: stremio refetches FROM the offset
        }
        if (!started.current) {
          started.current = true;
          if (!broker) void reportStart(itemId as string, player.currentTime || startSeconds);
        }
      } else if (status !== "loading" && status !== "idle") {
        setBuffering(false);
      }
    });
    const timeSub = player.addListener("timeUpdate", (payload: any) => {
      const t = payload?.currentTime ?? player.currentTime ?? 0;
      posRef.current = t;
      if (broker) {
        const dur = Number.isFinite(player.duration) ? player.duration : 0;
        const done = dur > 0 && t / dur >= WATCHED_FRACTION;
        brokerMarker(t, done);
        if (done && !watchedSent.current) {
          watchedSent.current = true;
          void brokerRemove(broker.infoHash).catch(() => {}); // delete-after-watched
        }
      } else {
        void reportProgress(itemId as string, t, !player.playing);
      }
    });
    return () => {
      statusSub?.remove?.();
      timeSub?.remove?.();
      // Exit = persist the resume point (the permanent half of resume).
      if (broker) {
        const dur = Number.isFinite(player.duration) ? player.duration : 0;
        const done = watchedSent.current || (dur > 0 && posRef.current / dur >= WATCHED_FRACTION);
        brokerMarker(posRef.current, done);
        if (done && !watchedSent.current) void brokerRemove(broker.infoHash).catch(() => {});
      } else if (itemId) {
        void reportStopped(itemId, posRef.current);
      }
    };
  }, [player, itemId, broker, startSeconds]);

  // Remote/back exits the player (cleanup above reports the resume point).
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      nav.goBack();
      return true;
    });
    return () => sub.remove();
  }, [nav]);

  return (
    <View style={styles.root}>
      <VideoView player={player} style={styles.video} nativeControls contentFit="contain" />
      {buffering ? (
        <View style={styles.bufferOverlay} pointerEvents="none">
          <Spinner label="Joining the swarm — buffering from your server…" />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  video: { flex: 1 },
  bufferOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.bg.scrim, justifyContent: "center", alignItems: "center" },
});
