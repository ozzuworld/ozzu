const base = require("./app.json");

module.exports = () => {
  const config = JSON.parse(JSON.stringify(base.expo));

  if (process.env.BUILD_TARGET === "phone") {
    // Strip the TV plugin for iPhone builds
    config.plugins = (config.plugins || []).filter((p) => {
      const name = Array.isArray(p) ? p[0] : p;
      return name !== "@react-native-tvos/config-tv";
    });
    config.orientation = "portrait";
  }

  return config;
};
