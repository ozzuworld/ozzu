// Phone-specific config: removes the TV plugin so we get a standard iPhone build.
// Used by the iOS GitHub Actions workflow.
const base = require("./app.json");

const config = JSON.parse(JSON.stringify(base.expo));

// Remove the TV plugin
config.plugins = (config.plugins || []).filter((p) => {
  const name = Array.isArray(p) ? p[0] : p;
  return name !== "@react-native-tvos/config-tv";
});

// Phone orientation
config.orientation = "portrait";

module.exports = () => config;
