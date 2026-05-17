// dependency-cruiser config for Ozzu — minimal, focuses on producing an import graph
// of the surviving app surface. Forbidden patterns can be added once we see the graph.
module.exports = {
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: "(node_modules|\\.expo|/android/|/ios/|/build/|/dist/|/\\.cipher/)",
    },
    tsConfig: { fileName: require("path").resolve(__dirname, "../../frontend/tsconfig.json") },
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
    },
  },
  forbidden: [
    {
      name: "no-orphans",
      severity: "warn",
      from: { orphan: true, pathNot: "(\\.d\\.ts$|index\\.(t|j)sx?$|^\\.|tsconfig|babel\\.config|metro\\.config|app\\.json)" },
      to: {},
    },
    {
      name: "no-circular",
      severity: "warn",
      from: {},
      to: { circular: true },
    },
  ],
};
