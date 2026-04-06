// remote-logger.ts — sends console logs + uncaught errors to the bridge
// Install once at app startup via installRemoteLogger()

import { Platform } from "react-native";
import { getBridgeUrl } from "./bridge-api";

const DEVICE = `${Platform.OS}-${Platform.Version}`;

function post(level: string, msg: string, stack?: string) {
  const url = `${getBridgeUrl()}/api/device-logs`;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device: DEVICE, level, msg, stack }),
  }).catch(() => {}); // never throw
}

export function installRemoteLogger() {
  // Redirect console
  const _log = console.log.bind(console);
  const _warn = console.warn.bind(console);
  const _error = console.error.bind(console);

  console.log = (...args: any[]) => { _log(...args); post("log", args.map(String).join(" ")); };
  console.warn = (...args: any[]) => { _warn(...args); post("warn", args.map(String).join(" ")); };
  console.error = (...args: any[]) => { _error(...args); post("error", args.map(String).join(" ")); };

  // React Native global error handler
  const ErrorUtils = (global as any).ErrorUtils;
  if (ErrorUtils) {
    const prev = ErrorUtils.getGlobalHandler();
    ErrorUtils.setGlobalHandler((error: Error, isFatal: boolean) => {
      post("crash", `[${isFatal ? "FATAL" : "error"}] ${error?.message}`, error?.stack);
      if (prev) prev(error, isFatal);
    });
  }

  post("log", `[remote-logger] installed on ${DEVICE}`);
}
