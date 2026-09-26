import React, { useEffect, useRef } from "react";
import { BackHandler, StyleSheet, View } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";
import { useNavigation, useRoute } from "@react-navigation/native";
import {
  directStreamUrl,
  reportProgress,
  reportStart,
  reportStopped,
} from "../lib/jellyfin/playback";

export function PlayerScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const itemId: string = route.params?.itemId;
  const startSeconds: number = route.params?.startSeconds ?? 0;

  const url = directStreamUrl(itemId);
  const seeked = useRef(false);
  const started = useRef(false);
  const posRef = useRef(startSeconds);

  const player = useVideoPlayer(url, (p) => {
    p.timeUpdateEventInterval = 10;
    p.play();
  });

  useEffect(() => {
    const statusSub = player.addListener("statusChange", ({ status }: any) => {
      if (status !== "readyToPlay") return;
      if (!seeked.current && startSeconds > 1) {
        seeked.current = true;
        player.currentTime = startSeconds;
      }
      if (!started.current) {
        started.current = true;
        void reportStart(itemId, player.currentTime || startSeconds);
      }
    });
    const timeSub = player.addListener("timeUpdate", (payload: any) => {
      const t = payload?.currentTime ?? player.currentTime ?? 0;
      posRef.current = t;
      void reportProgress(itemId, t, !player.playing);
    });
    return () => {
      statusSub?.remove?.();
      timeSub?.remove?.();
      void reportStopped(itemId, posRef.current);
    };
  }, [player, itemId, startSeconds]);

  // Remote/back exits the player (and the cleanup above reports the resume point).
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
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  video: { flex: 1 },
});
