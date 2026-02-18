import {
  requireNativeModule,
  EventEmitter,
  type EventSubscription,
} from "expo-modules-core";

// ── Types ──

export type SttResultEvent = {
  text: string;
  isFinal: boolean;
};

export type SttErrorEvent = {
  error: string;
};

export type TtsAudioEvent = {
  data: string; // base64 PCM (24kHz, 16-bit mono)
};

export type TtsErrorEvent = {
  error: string;
};

export type VoiceInfo = {
  id: string;
  name: string;
  language: string;
  quality: string;
};

type CipherVoiceEvents = Record<string, (...args: any[]) => void> & {
  onSttResult: (event: SttResultEvent) => void;
  onSttError: (event: SttErrorEvent) => void;
  onTtsStarted: (event: {}) => void;
  onTtsAudio: (event: TtsAudioEvent) => void;
  onTtsDone: (event: {}) => void;
  onTtsError: (event: TtsErrorEvent) => void;
};

// ── Native module (graceful fallback if not in current binary) ──

let CipherVoice: any = null;
let emitter: EventEmitter<CipherVoiceEvents> | null = null;

try {
  CipherVoice = requireNativeModule("CipherVoice");
  emitter = new EventEmitter<CipherVoiceEvents>(CipherVoice);
} catch {
  // Native module not available (Android/TV builds) — all functions return safe defaults
}

/** Whether the native module is loaded in the current binary */
export const nativeAvailable = CipherVoice !== null;

// ── Functions ──

/** True only on iPhone with speech recognition support */
export function isAvailable(): boolean {
  if (!CipherVoice) return false;
  return CipherVoice.isAvailable();
}

/** Request speech recognition + microphone permissions */
export async function requestPermissions(): Promise<boolean> {
  if (!CipherVoice) return false;
  return CipherVoice.requestPermissions();
}

/** Start on-device STT (SFSpeechRecognizer, A18 Pro Neural Engine) */
export async function startListening(): Promise<boolean> {
  if (!CipherVoice) return false;
  return CipherVoice.startListening();
}

/** Stop listening */
export function stopListening(): void {
  if (!CipherVoice) return;
  CipherVoice.stopListening();
}

/** Speak text via on-device TTS (AVSpeechSynthesizer) */
export async function speak(text: string): Promise<boolean> {
  if (!CipherVoice) return false;
  return CipherVoice.speak(text);
}

/** Interrupt current TTS mid-speech */
export function interrupt(): void {
  if (!CipherVoice) return;
  CipherVoice.interrupt();
}

/** Set TTS voice by identifier */
export function setVoice(voiceId: string): void {
  if (!CipherVoice) return;
  CipherVoice.setVoice(voiceId);
}

/** List available premium/enhanced English voices */
export function getAvailableVoices(): VoiceInfo[] {
  if (!CipherVoice) return [];
  return CipherVoice.getAvailableVoices();
}

// ── Event subscriptions (no-op if native module missing) ──

const noopSubscription: EventSubscription = { remove: () => {} };

/** STT result — emitted for both interim and final transcripts */
export function onSttResult(
  callback: (event: SttResultEvent) => void
): EventSubscription {
  if (!emitter) return noopSubscription;
  return emitter.addListener("onSttResult", callback);
}

/** STT error */
export function onSttError(
  callback: (event: SttErrorEvent) => void
): EventSubscription {
  if (!emitter) return noopSubscription;
  return emitter.addListener("onSttError", callback);
}

/** TTS started speaking */
export function onTtsStarted(callback: (event: {}) => void): EventSubscription {
  if (!emitter) return noopSubscription;
  return emitter.addListener("onTtsStarted", callback);
}

/** TTS audio chunk captured (base64 PCM 24kHz 16-bit mono) for relay to bridge */
export function onTtsAudio(
  callback: (event: TtsAudioEvent) => void
): EventSubscription {
  if (!emitter) return noopSubscription;
  return emitter.addListener("onTtsAudio", callback);
}

/** TTS finished speaking */
export function onTtsDone(callback: (event: {}) => void): EventSubscription {
  if (!emitter) return noopSubscription;
  return emitter.addListener("onTtsDone", callback);
}

/** TTS error */
export function onTtsError(
  callback: (event: TtsErrorEvent) => void
): EventSubscription {
  if (!emitter) return noopSubscription;
  return emitter.addListener("onTtsError", callback);
}
