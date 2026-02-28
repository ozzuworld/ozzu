const { withPodfileProperties } = require("expo/config-plugins");

/**
 * MediaPipe config plugin — ensures MediaPipeTasksVision pod links correctly.
 * The podspec already sets static_framework = true.
 * This plugin is a safety net for framework linkage issues.
 */
module.exports = function withMediaPipe(config) {
  // MediaPipeTasksVision requires static framework linkage.
  // If the build fails with dynamic linking errors, uncomment below:
  // config = withPodfileProperties(config, (c) => {
  //   c.modResults["ios.useFrameworks"] = "static";
  //   return c;
  // });
  return config;
};
