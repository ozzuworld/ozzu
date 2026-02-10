import { Platform } from "react-native";
import {
  startPlayback,
  writeAudio,
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
    startPlayback();
    this.started = true;
  }

  addChunk(pcmBase64: string) {
    if (!this.started) this.start();
    writeAudio(pcmBase64);
  }

  flush() {
    // Native AudioTrack handles draining automatically
  }

  async stop() {
    if (!this.started) return;
    stopPlayback();
    this.started = false;
  }
}

// ── Mic capture via native AudioRecord ──

export class MicRecorder {
  private subscription: EventSubscription | null = null;
  private active = false;

  start(onChunk: (pcmBase64: string) => void) {
    if (this.active) return;
    this.subscription = onMicData((event) => {
      onChunk(event.data);
    });
    startRecording();
    this.active = true;
  }

  stop() {
    if (!this.active) return;
    stopRecording();
    this.subscription?.remove();
    this.subscription = null;
    this.active = false;
  }
}
