// push-notifications.ts — Expo push notification setup
// NOTE: expo-notifications must be installed for this to activate (requires native build)

import { Platform } from "react-native";
import { getBridgeUrl, getAuthHeaders } from "./bridge-api";

let expoNotifications: any = null;

async function getNotificationsModule() {
  if (expoNotifications) return expoNotifications;
  try {
    expoNotifications = await import("expo-notifications");
    return expoNotifications;
  } catch {
    return null;
  }
}

export async function registerForPushNotifications(deviceId: string): Promise<string | null> {
  if (Platform.OS !== "ios") return null;

  try {
    const Notifications = await getNotificationsModule();
    if (!Notifications) return null;

    // Configure notification handling
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      }),
    });

    // Request permissions
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== "granted") {
      console.log("[push] Permission denied");
      return null;
    }

    // Get push token — projectId must be the EAS UUID from `eas init`
    // Run `eas init` in /frontend to generate it, then add to app.json extra.eas.projectId
    const { default: Constants } = await import("expo-constants");
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) {
      console.warn("[push] No EAS projectId configured — run `eas init` in /frontend and add projectId to app.json extra.eas.projectId");
      return null;
    }
    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = tokenData.data;

    // Register with backend
    const bridgeUrl = getBridgeUrl();
    await fetch(`${bridgeUrl}/api/devices/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(),
      },
      body: JSON.stringify({
        token,
        deviceId,
        platform: "ios",
        deviceName: "iPhone",
      }),
    });

    console.log("[push] Registered:", token);
    return token;
  } catch (err) {
    console.warn("[push] Registration failed:", err);
    return null;
  }
}
