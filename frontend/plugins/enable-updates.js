/**
 * Expo config plugin: forces expo-updates ENABLED in debug builds.
 * By default, expo-updates is disabled for debug variants.
 * We need it enabled because we deploy JS-only changes via OTA
 * and never connect to Metro (wireless ADB over VPN doesn't support adb reverse).
 *
 * Android: sets meta-data in AndroidManifest.xml
 * iOS: sets EXUpdates keys in Info.plist
 */
const {
  withAndroidManifest,
  withInfoPlist,
} = require("expo/config-plugins");

function withAndroidUpdates(config) {
  return withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application?.[0];
    if (!app) return config;

    const metaData = app["meta-data"] || [];

    for (const meta of metaData) {
      const name = meta.$?.["android:name"];
      if (name === "expo.modules.updates.ENABLED") {
        meta.$["android:value"] = "true";
      }
      if (name === "expo.modules.updates.EXPO_UPDATES_LAUNCH_WAIT_MS") {
        meta.$["android:value"] = "5000";
      }
    }

    return config;
  });
}

function withIosUpdates(config) {
  return withInfoPlist(config, (config) => {
    config.modResults.EXUpdatesEnabled = true;
    config.modResults.EXUpdatesURL = "http://10.8.0.1:3333/api/manifest";
    config.modResults.EXUpdatesLaunchWaitMs = 5000;
    return config;
  });
}

module.exports = function enableUpdates(config) {
  config = withAndroidUpdates(config);
  config = withIosUpdates(config);
  return config;
};
