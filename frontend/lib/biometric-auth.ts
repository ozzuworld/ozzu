import * as LocalAuthentication from 'expo-local-authentication';

export const BRIDGE_PIN = process.env.EXPO_PUBLIC_BRIDGE_PIN || '1234';

export async function canUseBiometric(): Promise<boolean> {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  if (!hasHardware) return false;
  const isEnrolled = await LocalAuthentication.isEnrolledAsync();
  return isEnrolled;
}

export async function authenticateWithBiometric(promptMessage: string): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage,
    cancelLabel: 'Cancel',
    disableDeviceFallback: true,
  });
  return result.success;
}
