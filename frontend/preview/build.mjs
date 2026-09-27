import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FE = path.resolve(__dirname, "..");            // frontend/
const NM = path.join(FE, "node_modules");            // app deps
const req = createRequire(path.join(FE, "package.json"));
const rnw = req.resolve("react-native-web");
const stub = (f) => path.join(__dirname, "stubs", f);

// Redirect the native-coupled edges the screens touch to preview stubs, and
// react-native -> react-native-web. Everything else (design-tokens,
// chainConstants, ContentPanel, the SOC components) resolves to REAL source.
// bridge-api points at same-origin relative URLs; serve.py proxies those to
// the live local bridge, so previews render with REAL data.
const redirect = {
  name: "preview-redirect",
  setup(build) {
    build.onResolve({ filter: /^react-native$/ }, () => ({ path: rnw }));
    build.onResolve({ filter: /^expo-status-bar$/ }, () => ({ path: stub("expo-status-bar.js") }));
    build.onResolve({ filter: /^expo-router$/ }, () => ({ path: stub("expo-router.js") }));
    build.onResolve({ filter: /^react-native-safe-area-context$/ }, () => ({ path: stub("safe-area-context.js") }));
    build.onResolve({ filter: /lib\/usePhoneLayout$/ }, () => ({ path: stub("usePhoneLayout.js") }));
    build.onResolve({ filter: /lib\/directive-hooks$/ }, () => ({ path: stub("directive-hooks.js") }));
    build.onResolve({ filter: /lib\/business-hooks$/ }, () => ({ path: stub("business-hooks.js") }));
    build.onResolve({ filter: /lib\/bridge-api$/ }, () => ({ path: stub("bridge-api.js") }));
    build.onResolve({ filter: /lib\/useBridgeStream$/ }, () => ({ path: stub("useBridgeStream.js") }));
    build.onResolve({ filter: /lib\/ha-context$/ }, () => ({ path: stub("ha-context.js") }));
  },
};

await esbuild.build({
  entryPoints: [path.join(__dirname, "entry.jsx")],
  bundle: true,
  outfile: path.join(__dirname, "dist", "bundle.js"),
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  jsxImportSource: "react",
  loader: {
    ".png": "dataurl", ".jpg": "dataurl", ".jpeg": "dataurl",
    ".gif": "dataurl", ".svg": "dataurl", ".ttf": "dataurl", ".otf": "dataurl",
  },
  resolveExtensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".js", ".json"],
  define: {
    "process.env.NODE_ENV": '"development"',
    "process.env.EXPO_OS": '"web"',
    __DEV__: "true",
    global: "globalThis",
  },
  nodePaths: [NM],
  plugins: [redirect],
  logLevel: "info",
});

console.log("BUILD OK");
