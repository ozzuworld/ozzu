const { withAppBuildGradle } = require("expo/config-plugins");

/**
 * MediaPipe config plugin — ensures native dependencies resolve on both platforms.
 * iOS: MediaPipeTasksVision via podspec (static_framework = true in ExpoMediaPipe.podspec)
 * Android: com.google.mediapipe:tasks-vision via Maven (in module build.gradle)
 */
module.exports = function withMediaPipe(config) {
  // Android: ensure google() maven repo is present (usually already is, but safety net)
  config = withAppBuildGradle(config, (c) => {
    if (!c.modResults.contents.includes("com.google.mediapipe")) {
      // The dependency is in the module's own build.gradle, not the app's.
      // This block is a no-op placeholder for future Android-level config if needed.
    }
    return c;
  });

  return config;
};
