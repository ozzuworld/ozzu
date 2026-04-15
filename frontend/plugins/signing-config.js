/**
 * Expo config plugin: configures release signing.
 * In CI with keystore env vars: uses production signing.
 * Otherwise: uses debug keystore for release builds (allows OTA without Play Store signing).
 */
const { withAppBuildGradle } = require("expo/config-plugins");

module.exports = function signingConfig(config) {
  return withAppBuildGradle(config, (config) => {
    let contents = config.modResults.contents;

    if (contents.includes("OZZU_KEYSTORE_FILE")) return config;

    const signingBlock = `
    if (System.getenv("OZZU_KEYSTORE_FILE")) {
        signingConfigs {
            release {
                storeFile file(System.getenv("OZZU_KEYSTORE_FILE"))
                storePassword System.getenv("OZZU_KEY_PASSWORD")
                keyAlias System.getenv("OZZU_KEY_ALIAS")
                keyPassword System.getenv("OZZU_KEY_PASSWORD")
            }
        }
        buildTypes {
            release {
                signingConfig signingConfigs.release
            }
        }
    } else {
        // Fall back to debug signing for release builds (dev/staging)
        buildTypes {
            release {
                signingConfig signingConfigs.debug
            }
        }
    }`;

    contents = contents.replace(
      /(android\s*\{)/,
      `$1\n${signingBlock}\n`
    );

    config.modResults.contents = contents;
    return config;
  });
};
