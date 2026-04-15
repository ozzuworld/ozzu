/**
 * Expo config plugin: configures release signing from environment variables.
 * In CI: uses OZZU_TV_KEYSTORE_BASE64, OZZU_TV_KEY_ALIAS, OZZU_TV_KEY_PASSWORD.
 * Locally: falls back to debug keystore (default Expo behavior).
 */
const { withAppBuildGradle } = require("expo/config-plugins");

module.exports = function signingConfig(config) {
  return withAppBuildGradle(config, (config) => {
    let contents = config.modResults.contents;

    // Only inject signing config if the env var markers aren't already present
    if (contents.includes("OZZU_TV_KEYSTORE_FILE")) return config;

    // Add signing config block inside android { }
    const signingBlock = `
    if (System.getenv("OZZU_TV_KEYSTORE_FILE")) {
        signingConfigs {
            release {
                storeFile file(System.getenv("OZZU_TV_KEYSTORE_FILE"))
                storePassword System.getenv("OZZU_TV_KEY_PASSWORD")
                keyAlias System.getenv("OZZU_TV_KEY_ALIAS")
                keyPassword System.getenv("OZZU_TV_KEY_PASSWORD")
            }
        }
        buildTypes {
            release {
                signingConfig signingConfigs.release
            }
        }
    }`;

    // Insert after "android {"
    contents = contents.replace(
      /(android\s*\{)/,
      `$1\n${signingBlock}\n`
    );

    config.modResults.contents = contents;
    return config;
  });
};
