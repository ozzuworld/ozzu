/**
 * Expo config plugin: adds permissions required for Device Owner silent install.
 * Adds REQUEST_INSTALL_PACKAGES and INSTALL_PACKAGES to AndroidManifest.
 */
const { withAndroidManifest } = require("expo/config-plugins");

module.exports = function deviceOwnerConfig(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const permissions = manifest["uses-permission"] || [];
    const existing = new Set(permissions.map((p) => p.$?.["android:name"]));

    const required = [
      "android.permission.REQUEST_INSTALL_PACKAGES",
      "android.permission.INTERNET",
    ];

    for (const perm of required) {
      if (!existing.has(perm)) {
        permissions.push({ $: { "android:name": perm } });
      }
    }
    manifest["uses-permission"] = permissions;

    return config;
  });
};
