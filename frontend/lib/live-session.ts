import { GoogleGenAI, Modality, type Session } from "@google/genai";

const API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY ?? "";
const ai = new GoogleGenAI({ apiKey: API_KEY });

const MODEL = "gemini-2.5-flash-native-audio-preview-09-2025";
const VOICE = "Orus";

const SYSTEM_PREFIX =
  "You are the AI overseer of a smart home called ozzu. " +
  "Concise, slightly sci-fi tone. " +
  "Current entity states:\n";

export interface LiveCallbacks {
  onAudioChunk: (pcmBase64: string) => void;
  onTranscript: (text: string) => void;
  onTurnComplete: () => void;
  onError: (msg: string) => void;
}

/**
 * Persistent Live API session.
 * Connects once and stays open for multiple turns.
 */
export class LiveChat {
  private session: Session | null = null;
  private callbacks: LiveCallbacks | null = null;
  private entityContext = "";

  async connect(
    entityContext: string,
    callbacks: LiveCallbacks
  ): Promise<void> {
    this.callbacks = callbacks;
    this.entityContext = entityContext;

    this.session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: VOICE },
          },
        },
        systemInstruction: SYSTEM_PREFIX + entityContext,
        outputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => {},
        onmessage: (message) => {
          const parts = message.serverContent?.modelTurn?.parts;
          if (parts) {
            for (const part of parts) {
              if ("inlineData" in part && part.inlineData?.data) {
                this.callbacks?.onAudioChunk(part.inlineData.data);
              }
            }
          }

          const transcript = message.serverContent?.outputTranscription?.text;
          if (transcript) {
            this.callbacks?.onTranscript(transcript);
          }

          if (message.serverContent?.turnComplete) {
            this.callbacks?.onTurnComplete();
          }
        },
        onerror: (e) => {
          this.callbacks?.onError(e.message ?? "Live API error");
        },
        onclose: () => {
          this.session = null;
        },
      },
    });
  }

  /** Update callbacks (e.g. when starting a new turn). */
  setCallbacks(callbacks: LiveCallbacks) {
    this.callbacks = callbacks;
  }

  /** Send a text message on the existing session. */
  send(text: string) {
    this.session?.sendClientContent({
      turns: text,
      turnComplete: true,
    });
  }

  /** Send raw mic audio (16kHz 16-bit PCM, base64). */
  sendAudio(pcmBase64: string) {
    this.session?.sendRealtimeInput({
      audio: new Blob(
        [Uint8Array.from(atob(pcmBase64), (c) => c.charCodeAt(0))],
        { type: "audio/pcm;rate=16000" }
      ) as any,
    });
  }

  close() {
    this.session?.close();
    this.session = null;
    this.callbacks = null;
  }

  get connected() {
    return this.session !== null;
  }
}
