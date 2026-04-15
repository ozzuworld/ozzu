/**
 * Expo config plugin: adds Android TV leanback support to the manifest.
 * Replaces the sed hacks in build-tv.yml with a proper config plugin.
 *
 * Adds:
 * - <uses-feature android:name="android.software.leanback" android:required="false" />
 * - <uses-feature android:name="android.hardware.touchscreen" android:required="false" />
 * - LEANBACK_LAUNCHER category to the main activity intent filter
 */
const { withAndroidManifest } = require("expo/config-plugins");

module.exports = function tvLeanback(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;

    // Add uses-feature declarations
    const features = manifest["uses-feature"] || [];
    const existingFeatures = new Set(features.map((f) => f.$?.["android:name"]));

    if (!existingFeatures.has("android.software.leanback")) {
      features.push({
        $: {
          "android:name": "android.software.leanback",
          "android:required": "false",
        },
      });
    }
    if (!existingFeatures.has("android.hardware.touchscreen")) {
      features.push({
        $: {
          "android:name": "android.hardware.touchscreen",
          "android:required": "false",
        },
      });
    }
    manifest["uses-feature"] = features;

    // Add LEANBACK_LAUNCHER category to the main activity's intent filter
    const app = manifest.application?.[0];
    if (app) {
      const activities = app.activity || [];
      for (const activity of activities) {
        const filters = activity["intent-filter"] || [];
        for (const filter of filters) {
          const categories = filter.category || [];
          const hasMain = categories.some(
            (c) => c.$?.["android:name"] === "android.intent.category.LAUNCHER"
          );
          if (hasMain) {
            const hasLeanback = categories.some(
              (c) => c.$?.["android:name"] === "android.intent.category.LEANBACK_LAUNCHER"
            );
            if (!hasLeanback) {
              categories.push({
                $: { "android:name": "android.intent.category.LEANBACK_LAUNCHER" },
              });
              filter.category = categories;
            }
          }
        }
      }
    }

    return config;
  });
};
