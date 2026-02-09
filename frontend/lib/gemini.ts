import { GoogleGenAI } from "@google/genai";

const API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY ?? "";

const ai = new GoogleGenAI({ apiKey: API_KEY });

export async function* streamChat(
  message: string,
  entityContext: string
): AsyncGenerator<string> {
  const response = await ai.models.generateContentStream({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: message }] }],
    config: {
      systemInstruction:
        "You are the AI overseer of a smart home called ozzu. " +
        "Concise, slightly sci-fi tone. " +
        "Current entity states:\n" +
        entityContext,
    },
  });

  for await (const chunk of response) {
    const text = chunk.text;
    if (text) yield text;
  }
}
