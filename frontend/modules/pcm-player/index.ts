import { requireNativeModule, EventEmitter, type EventSubscription } from "expo-modules-core";

type PcmPlayerEvents = Record<string, (...args: any[]) => void> & {
  onMicData: (event: { data: string }) => void;
};

const PcmPlayer = requireNativeModule("PcmPlayer");
const emitter = new EventEmitter<PcmPlayerEvents>(PcmPlayer);

export function startPlayback(): void {
  PcmPlayer.startPlayback();
}

export function writeAudio(base64Pcm: string): void {
  PcmPlayer.writeAudio(base64Pcm);
}

export function stopPlayback(): void {
  PcmPlayer.stopPlayback();
}

export function startRecording(): void {
  PcmPlayer.startRecording();
}

export function stopRecording(): void {
  PcmPlayer.stopRecording();
}

export function onMicData(
  callback: (event: { data: string }) => void
): EventSubscription {
  return emitter.addListener("onMicData", callback);
}
