/**
 * Expo config plugin for Meta DAT SDK configuration.
 *
 * Android: Adds Bluetooth permissions and META_APP_ID metadata to AndroidManifest.
 * iOS: Adds MWDAT config, Bluetooth description, background modes, URL schemes,
 *      and external accessory protocols to Info.plist.
 */
const {
  withAndroidManifest,
  withInfoPlist,
  withProjectBuildGradle,
} = require("expo/config-plugins");

function withMetaDATAndroid(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const mainApp = manifest.application?.[0];

    // Add Bluetooth permissions (skip if already present)
    const permissions = manifest["uses-permission"] || [];
    const existingPerms = new Set(permissions.map((p) => p.$?.["android:name"]));

    const requiredPerms = [
      "android.permission.BLUETOOTH",
      "android.permission.BLUETOOTH_CONNECT",
      "android.permission.INTERNET",
    ];
    for (const perm of requiredPerms) {
      if (!existingPerms.has(perm)) {
        permissions.push({ $: { "android:name": perm } });
      }
    }
    manifest["uses-permission"] = permissions;

    // Add Meta DAT metadata to <application>
    if (mainApp) {
      const metaData = mainApp["meta-data"] || [];
      const existingMeta = new Set(metaData.map((m) => m.$?.["android:name"]));

      // Only add Meta DAT manifest entries if SDK is actually configured
      const metaAppId = process.env.EXPO_PUBLIC_META_APP_ID;
      if (metaAppId && metaAppId !== "NOT_CONFIGURED" && metaAppId !== "") {
        if (!existingMeta.has("com.meta.wearable.mwdat.APPLICATION_ID")) {
          metaData.push({
            $: {
              "android:name": "com.meta.wearable.mwdat.APPLICATION_ID",
              "android:value": metaAppId,
            },
          });
        }
      }
      if (!existingMeta.has("com.meta.wearable.mwdat.ANALYTICS_OPT_OUT")) {
        metaData.push({
          $: {
            "android:name": "com.meta.wearable.mwdat.ANALYTICS_OPT_OUT",
            "android:value": "true",
          },
        });
      }

      mainApp["meta-data"] = metaData;
    }

    return config;
  });
}

function withMetaDATMaven(config) {
  return withProjectBuildGradle(config, (config) => {
    let contents = config.modResults.contents;
    // Meta DAT SDK requires minSdkVersion 29 (Android 10+)
    contents = contents.replace(
      /minSdkVersion\s*=\s*Integer\.parseInt\(findProperty\('android\.minSdkVersion'\)\s*\?\:\s*'(\d+)'\)/,
      (match, currentMin) => {
        if (parseInt(currentMin, 10) < 29) {
          return match.replace(`'${currentMin}'`, "'29'");
        }
        return match;
      }
    );
    // Add Meta DAT SDK Maven repo to allprojects.repositories if not already present
    if (!contents.includes("meta-wearables-dat-android")) {
      const mavenBlock = [
        "    maven {",
        '      url "https://maven.pkg.github.com/facebook/meta-wearables-dat-android"',
        "      credentials {",
        "        username = System.getenv('GITHUB_USER') ?: 'github'",
        "        password = System.getenv('GITHUB_TOKEN') ?: ''",
        "      }",
        "    }",
      ].join("\n");
      contents = contents.replace(
        /allprojects\s*\{\s*\n\s*repositories\s*\{/,
        `allprojects {\n  repositories {\n${mavenBlock}`
      );
    }
    config.modResults.contents = contents;
    return config;
  });
}

function withMetaDATiOS(config) {
  return withInfoPlist(config, (config) => {
    const plist = config.modResults;

    // Meta DAT SDK configuration
    plist.MWDAT = {
      MetaAppID: "${EXPO_PUBLIC_META_APP_ID}",
      AppLinkURLScheme: "ozzu://",
      Analytics: { OptOut: true },
    };

    // Allow querying Meta AI app
    const querySchemes = plist.LSApplicationQueriesSchemes || [];
    if (!querySchemes.includes("fb-viewapp")) {
      querySchemes.push("fb-viewapp");
    }
    plist.LSApplicationQueriesSchemes = querySchemes;

    // Bluetooth usage description
    if (!plist.NSBluetoothAlwaysUsageDescription) {
      plist.NSBluetoothAlwaysUsageDescription =
        "Required to connect to your glasses";
    }

    // External accessory protocols
    const protocols = plist.UISupportedExternalAccessoryProtocols || [];
    if (!protocols.includes("com.meta.ar.wearable")) {
      protocols.push("com.meta.ar.wearable");
    }
    plist.UISupportedExternalAccessoryProtocols = protocols;

    // Background modes — append to existing
    const bgModes = plist.UIBackgroundModes || [];
    for (const mode of ["bluetooth-peripheral", "external-accessory"]) {
      if (!bgModes.includes(mode)) {
        bgModes.push(mode);
      }
    }
    plist.UIBackgroundModes = bgModes;

    return config;
  });
}

module.exports = function withMetaDAT(config) {
  config = withMetaDATAndroid(config);
  config = withMetaDATMaven(config);
  config = withMetaDATiOS(config);
  return config;
};
