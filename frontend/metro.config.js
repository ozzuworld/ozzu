const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);

// Enable conditional exports so @google/genai resolves its browser entry point
config.resolver.unstable_enablePackageExports = true;
config.resolver.unstable_conditionNames = ["browser", "import", "require"];

module.exports = withNativeWind(config, { input: "./global.css" });
