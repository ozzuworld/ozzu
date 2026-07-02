#!/usr/bin/env bash
# preview-screen.sh — render a REAL RN screen via react-native-web at iPhone
# size and screenshot it through the headless `browser` container, so Cipher
# can SEE app UI on this (macOS-less) Linux box and iterate without a device.
#
# Usage:  scripts/preview-screen.sh [state] [outdir]
#   state  = query passed to the preview (e.g. clear | attention). Default: clear
#   outdir = where the PNG lands. Default: /tmp/ozzu-preview
#
# How it works (see frontend/preview/): esbuild bundles frontend/preview/entry.jsx
# (which mounts the real app/(tabs)/home.tsx directly, NOT through app/_layout —
# so none of the 9 native modules are pulled in), aliasing react-native ->
# react-native-web and stubbing only the native-coupled edges home touches
# (expo-router, expo-status-bar, directive-hooks, business-hooks, usePhoneLayout).
# A static server serves it; the browser container (network_mode host) navigates
# to it and returns a base64 PNG, cropped to the 393x852 iPhone frame.
#
# Fidelity note: react-native-web is ~90% faithful (layout / flex / type / color),
# NOT pixel-perfect iOS. King Kazuma's real-device screenshots stay ground truth.
set -euo pipefail

PREVIEW="/home/gcp/ozzu/frontend/preview"
BROWSER="http://127.0.0.1:3334"
STATE="${1:-clear}"
OUT="${2:-/tmp/ozzu-preview}"
PORT=8791
mkdir -p "$OUT"

# 1. bundle the harness
( cd "$PREVIEW" && node build.mjs >/dev/null )

# 2. ensure the static server is up (idempotent; no shell sleep — curl waits)
if ! curl -sf -o /dev/null "http://127.0.0.1:$PORT/index.html" 2>/dev/null; then
  ( cd "$PREVIEW" && nohup python3 -m http.server "$PORT" --bind 127.0.0.1 >/tmp/ozzu-preview-server.log 2>&1 & )
fi
curl -sf --retry-connrefused --retry 15 --retry-delay 1 -o /dev/null "http://127.0.0.1:$PORT/index.html"

# 3. navigate + screenshot via the browser container; crop to the iPhone frame
python3 - "$OUT" "$STATE" "$PORT" "$BROWSER" <<'PY'
import json, urllib.request, base64, sys
out, state, port, browser = sys.argv[1:5]
body = json.dumps({
    "url": f"http://127.0.0.1:{port}/index.html?state={state}",
    "session_id": "preview", "wait_for": "networkidle",
}).encode()
req = urllib.request.Request(f"{browser}/navigate", data=body,
                             headers={"Content-Type": "application/json"})
r = json.load(urllib.request.urlopen(req, timeout=60))
if not r.get("screenshot"):
    print("NO SCREENSHOT:", r.get("error")); sys.exit(1)
p = f"{out}/home-{state}.png"
open(p, "wb").write(base64.b64decode(r["screenshot"]))
# best-effort crop to the 393x852 iPhone frame (top-left of the viewport)
try:
    from PIL import Image
    Image.open(p).crop((0, 0, 393, 852)).save(p)
except Exception:
    pass
print(p)
PY
