/**
 * Expo config plugin: forces getUseDeveloperSupport() to return false.
 * Required so expo-updates works in debug APKs (TV never connects to Metro).
 * Adapted from frontend/plugins/disable-dev-support.js.
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
