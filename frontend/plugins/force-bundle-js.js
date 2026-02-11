/**
 * Expo config plugin: forces JS bundling into APK for all build types.
 * Sets debuggableVariants = [] so the debug APK embeds the JS bundle
 * instead of requiring Metro (which is unreachable over VPN/wireless ADB).
 */
const { withAppBuildGradle } = require("expo/config-plugins");

module.exports = function forceBundleJs(config) {
  return withAppBuildGradle(config, (config) => {
    // Replace the commented-out line with an active one
    config.modResults.contents = config.modResults.contents.replace(
      /\/\/\s*debuggableVariants\s*=\s*\[.*?\]/,
      'debuggableVariants = []'
    );
    return config;
  });
};
