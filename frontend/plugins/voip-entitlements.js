const { withInfoPlist, withEntitlementsPlist } = require("expo/config-plugins");

function withVoipEntitlements(config) {
  config = withInfoPlist(config, (c) => {
    const modes = c.modResults.UIBackgroundModes || [];
    if (!modes.includes("voip")) modes.push("voip");
    if (!modes.includes("audio")) modes.push("audio");
    c.modResults.UIBackgroundModes = modes;
    return c;
  });

  config = withEntitlementsPlist(config, (c) => {
    c.modResults["aps-environment"] =
      c.modResults["aps-environment"] || "production";
    return c;
  });

  return config;
}

module.exports = withVoipEntitlements;
