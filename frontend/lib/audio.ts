import { Platform } from "react-native";
import {
  startPlayback,
  writeAudio,
  flushPlayback,
  stopPlayback,
  startRecording,
  stopRecording,
  onMicData,
} from "../modules/pcm-player";
import type { EventSubscription } from "expo-modules-core";

// ── Gapless streaming playback via native AudioTrack ──

export class StreamingPlayer {
  private started = false;

  start() {
    if (this.started) return;
    try {
      startPlayback();
      this.started = true;
    } catch (err) {
      console.error("[StreamingPlayer] startPlayback failed:", err);
    }
  }

  addChunk(pcmBase64: string) {
    if (!this.started) this.start();
    writeAudio(pcmBase64);
  }

  flush() {
    if (!this.started) return;
    flushPlayback();
  }

  stop() {
    if (!this.started) return;
    try {
      stopPlayback();
    } catch (err) {
      console.error("[StreamingPlayer] stopPlayback failed:", err);
    }
    this.started = false;
  }
}

// ── Mic capture via native AudioRecord ──

export class MicRecorder {
  private subscription: EventSubscription | null = null;
  private active = false;

  start(onChunk: (pcmBase64: string) => void) {
    if (this.active) return;
    try {
      this.subscription = onMicData((event) => {
        onChunk(event.data);
      });
      startRecording();
      this.active = true;
    } catch (err) {
      console.error("[MicRecorder] startRecording failed:", err);
      this.subscription?.remove();
      this.subscription = null;
    }
  }

  stop() {
    if (!this.active) return;
    try {
      stopRecording();
    } catch (err) {
      console.error("[MicRecorder] stopRecording failed:", err);
    }
    this.subscription?.remove();
    this.subscription = null;
    this.active = false;
  }
}
