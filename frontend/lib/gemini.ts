import { GoogleGenAI, Modality } from "@google/genai";

const API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY ?? "";

const ai = new GoogleGenAI({ apiKey: API_KEY });

const SYSTEM_PREFIX =
  "You are the AI overseer of a smart home called ozzu. " +
  "Concise, slightly sci-fi tone. " +
  "Current entity states:\n";

export async function* streamChat(
  message: string,
  entityContext: string
): AsyncGenerator<string> {
  const config = {
    systemInstruction: SYSTEM_PREFIX + entityContext,
  };
  const contents = [{ role: "user" as const, parts: [{ text: message }] }];

  try {
    // Try streaming first
    const response = await ai.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents,
      config,
    });

    let gotChunks = false;
    for await (const chunk of response) {
      const text = chunk.text;
      if (text) {
        gotChunks = true;
        yield text;
      }
    }
    if (gotChunks) return;
  } catch {
    // Streaming not supported (e.g. Android TV Hermes) — fall through
  }

  // Fallback: non-streaming call
  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents,
    config,
  });

  const text = result.text;
  if (text) {
    // Simulate streaming by yielding word-by-word
    const words = text.split(" ");
    for (const word of words) {
      yield word + " ";
    }
  }
}

const TTS_VOICE = "Orus";

export async function generateSpeech(text: string): Promise<string | null> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: TTS_VOICE },
          },
        },
      },
    });

    const part = response.candidates?.[0]?.content?.parts?.[0];
    if (part && "inlineData" in part && part.inlineData?.data) {
      return part.inlineData.data;
    }
    return null;
  } catch {
    return null;
  }
}
