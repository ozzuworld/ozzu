/**
 * Expo config plugin: forces getUseDeveloperSupport() to return false.
 * When BuildConfig.DEBUG is true (debug builds), expo-updates creates a
 * DisabledUpdatesController BEFORE reading manifest metadata — so even with
 * ENABLED=true in the manifest, OTA updates never work in debug builds.
 * This plugin patches MainApplication.kt to always return false, enabling
 * expo-updates to function in debug APKs.
 */
const { withMainApplication } = require("expo/config-plugins");

module.exports = function disableDevSupport(config) {
  return withMainApplication(config, (config) => {
    config.modResults.contents = config.modResults.contents.replace(
      /override fun getUseDeveloperSupport\(\): Boolean\s*=\s*BuildConfig\.DEBUG/,
      "override fun getUseDeveloperSupport(): Boolean = false"
    );
    return config;
  });
};
