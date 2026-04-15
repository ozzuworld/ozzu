/**
 * Expo config plugin: forces JS bundling into APK for all build types.
 * Sets debuggableVariants = [] so the debug APK embeds the JS bundle
 * instead of requiring Metro (TV has no dev server access).
 * Adapted from frontend/plugins/force-bundle-js.js.
 */
const { withAppBuildGradle } = require("expo/config-plugins");

module.exports = function forceBundleJs(config) {
  return withAppBuildGradle(config, (config) => {
    config.modResults.contents = config.modResults.contents.replace(
      /\/\/\s*debuggableVariants\s*=\s*\[.*?\]/,
      'debuggableVariants = []'
    );
    return config;
  });
};
