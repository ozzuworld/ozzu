import { requireNativeModule } from "expo-modules-core";

interface ExtractedNumber {
  number: string;
  raw: string;
  digits: number;
}

const CallImport = requireNativeModule("CallImport");

export async function extractNumbers(imageUri: string): Promise<ExtractedNumber[]> {
  return CallImport.extractNumbers(imageUri);
}

export async function extractNumbersFromMultiple(
  imageUris: string[]
): Promise<ExtractedNumber[]> {
  return CallImport.extractNumbersFromMultiple(imageUris);
}
