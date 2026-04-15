/**
 * Expo config plugin: forces expo-updates ENABLED in debug builds.
 * Adapted from frontend/plugins/enable-updates.js for TV app.
 * Android-only — TV is always Android.
 */
const { withAndroidManifest } = require("expo/config-plugins");

module.exports = function enableUpdates(config) {
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
};
