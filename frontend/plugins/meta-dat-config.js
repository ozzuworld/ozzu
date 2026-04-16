/**
 * Expo config plugin for Meta DAT SDK configuration.
 *
 * Android: Adds Bluetooth permissions and META_APP_ID metadata to AndroidManifest.
 * iOS: Adds MWDAT config, Bluetooth description, URL schemes to Info.plist.
 */
const {
  withAndroidManifest,
  withInfoPlist,
  withProjectBuildGradle,
  withGradleProperties,
  withXcodeProject,
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

      // Developer Mode: MetaAppID=0 bypasses portal validation
      if (!existingMeta.has("com.meta.wearable.mwdat.APPLICATION_ID")) {
        metaData.push({
          $: {
            "android:name": "com.meta.wearable.mwdat.APPLICATION_ID",
            "android:value": "0",
          },
        });
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
    // Add flatDir for stripped local AAR (mwdat-core)
    // Meta DAT Maven repo disabled — module is in stub mode, mwdat-camera not needed.
    // Re-enable when real SDK integration begins.
    if (!contents.includes("expo-glasses/android/libs")) {
      const reposBlock = [
        '    // Stripped mwdat-core AAR (duplicate Facebook classes removed)',
        '    flatDir { dirs "${rootProject.projectDir}/../modules/expo-glasses/android/libs" }',
      ].join("\n");
      contents = contents.replace(
        /allprojects\s*\{\s*\n\s*repositories\s*\{/,
        `allprojects {\n  repositories {\n${reposBlock}`
      );
    }
    config.modResults.contents = contents;
    return config;
  });
}

function withMetaDATiOS(config) {
  return withInfoPlist(config, (config) => {
    const plist = config.modResults;

    // Meta DAT SDK configuration — Developer Mode
    // Developer Mode: OMIT MetaAppID (do not set to "0" — the SDK treats string "0"
    // as an invalid app ID and throws "configuration is invalid or incomplete").
    // AppLinkURLScheme MUST include "://" suffix — the official sample app uses
    // "cameraaccess://", not "cameraaccess". Without "://", Meta AI constructs a
    // malformed callback URL and the registration callback never arrives.
    // TeamID is also required — maps to $(DEVELOPMENT_TEAM) in Xcode.
    plist.MWDAT = {
      AppLinkURLScheme: "ozzu://",
      TeamID: "$(DEVELOPMENT_TEAM)",
      Analytics: { OptOut: true },
    };

    // Background modes for Bluetooth glasses connection + audio for immersive TTS
    const bgModes = plist.UIBackgroundModes || [];
    if (!bgModes.includes("bluetooth-peripheral")) bgModes.push("bluetooth-peripheral");
    if (!bgModes.includes("external-accessory")) bgModes.push("external-accessory");
    if (!bgModes.includes("audio")) bgModes.push("audio");
    plist.UIBackgroundModes = bgModes;

    // External accessory protocol for Meta glasses
    const eaProtocols = plist.UISupportedExternalAccessoryProtocols || [];
    if (!eaProtocols.includes("com.meta.ar.wearable")) eaProtocols.push("com.meta.ar.wearable");
    plist.UISupportedExternalAccessoryProtocols = eaProtocols;

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

    return config;
  });
}

function withMetaDATMinSdk(config) {
  return withGradleProperties(config, (config) => {
    const props = config.modResults;
    const idx = props.findIndex(
      (p) => p.type === "property" && p.key === "android.minSdkVersion"
    );
    if (idx >= 0) {
      props[idx].value = "29";
    } else {
      props.push({ type: "property", key: "android.minSdkVersion", value: "29" });
    }
    return config;
  });
}

// No longer needed — mwdat-core AAR has been stripped of duplicate
// Facebook classes (fbjni, fbcore, proguard-annotations) and is
// included as a local file in expo-glasses/android/libs/.

function withMetaDATSPM(config) {
  return withXcodeProject(config, (config) => {
    const project = config.modResults;
    const pbx = project.hash.project.objects;

    // Skip if already added
    if (pbx.XCRemoteSwiftPackageReference) {
      const existing = Object.values(pbx.XCRemoteSwiftPackageReference).find(
        (ref) =>
          ref.repositoryURL &&
          ref.repositoryURL.includes("meta-wearables-dat-ios")
      );
      if (existing) return config;
    }

    const pkgRefUuid = project.generateUuid();
    const mwdatCoreUuid = project.generateUuid();
    const mwdatCameraUuid = project.generateUuid();

    // 1. Add XCRemoteSwiftPackageReference
    if (!pbx.XCRemoteSwiftPackageReference) {
      pbx.XCRemoteSwiftPackageReference = {};
    }
    pbx.XCRemoteSwiftPackageReference[pkgRefUuid] = {
      isa: "XCRemoteSwiftPackageReference",
      repositoryURL:
        "https://github.com/facebook/meta-wearables-dat-ios",
      requirement: {
        kind: "upToNextMajorVersion",
        minimumVersion: "0.6.0",
      },
    };
    pbx.XCRemoteSwiftPackageReference[`${pkgRefUuid}_comment`] =
      'XCRemoteSwiftPackageReference "meta-wearables-dat-ios"';

    // 2. Add XCSwiftPackageProductDependency
    if (!pbx.XCSwiftPackageProductDependency) {
      pbx.XCSwiftPackageProductDependency = {};
    }
    pbx.XCSwiftPackageProductDependency[mwdatCoreUuid] = {
      isa: "XCSwiftPackageProductDependency",
      package: pkgRefUuid,
      productName: "MWDATCore",
    };
    pbx.XCSwiftPackageProductDependency[`${mwdatCoreUuid}_comment`] =
      "MWDATCore";
    pbx.XCSwiftPackageProductDependency[mwdatCameraUuid] = {
      isa: "XCSwiftPackageProductDependency",
      package: pkgRefUuid,
      productName: "MWDATCamera",
    };
    pbx.XCSwiftPackageProductDependency[`${mwdatCameraUuid}_comment`] =
      "MWDATCamera";

    // 3. Add package reference to root project
    const projectUuid = project.getFirstProject().uuid;
    const projectObj = pbx.PBXProject[projectUuid];
    if (!projectObj.packageReferences) {
      projectObj.packageReferences = [];
    }
    projectObj.packageReferences.push({
      value: pkgRefUuid,
      comment: 'XCRemoteSwiftPackageReference "meta-wearables-dat-ios"',
    });

    // 4. Add product dependencies to main target
    const targetUuid = project.getFirstTarget().uuid;
    const nativeTarget = pbx.PBXNativeTarget[targetUuid];
    if (!nativeTarget.packageProductDependencies) {
      nativeTarget.packageProductDependencies = [];
    }
    nativeTarget.packageProductDependencies.push({
      value: mwdatCoreUuid,
      comment: "MWDATCore",
    });
    nativeTarget.packageProductDependencies.push({
      value: mwdatCameraUuid,
      comment: "MWDATCamera",
    });

    return config;
  });
}

module.exports = function withMetaDAT(config) {
  config = withMetaDATAndroid(config);
  config = withMetaDATMaven(config);
  config = withMetaDATMinSdk(config);
  config = withMetaDATiOS(config);
  config = withMetaDATSPM(config);
  return config;
};
