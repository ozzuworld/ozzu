#!/usr/bin/env bash
# preview-screen.sh — render a REAL RN screen via react-native-web at iPhone
# size and screenshot it through the headless `browser` container, so Cipher
# can SEE app UI on this (macOS-less) Linux box and iterate without a device.
#
# Usage:  scripts/preview-screen.sh [screen] [extra-query] [outdir]
#   screen      = home | soc-home | soc-chain | soc-findings | soc-eng   (default: home)
#   extra-query = route params, e.g. "slug=false-relay" or "id=SKYLINE-SOC-2026-001";
#                 for home: "state=attention"
#   outdir      = where the PNG lands. Default: /tmp/ozzu-preview
#
# How it works (see frontend/preview/): esbuild bundles frontend/preview/entry.jsx
# (mounts the chosen screen directly, NOT through app/_layout — so none of the
# native modules are pulled in), aliasing react-native -> react-native-web and
# stubbing only the native-coupled edges (expo-router, expo-status-bar,
# bridge-api, useBridgeStream, ha-context, safe-area-context, usePhoneLayout,
# directive/business hooks). serve.py serves the harness single-origin and
# PROXIES /soc/* etc. to the live bridge at 127.0.0.1:3333 (loopback keyless
# by design) — previews render with REAL data, not fixtures. The browser
# container (network_mode host) navigates to it and returns a base64 PNG,
# cropped to the 393x852 iPhone frame.
#
# Fidelity note: react-native-web is ~90% faithful (layout / flex / type / color),
# NOT pixel-perfect iOS/Android. King Kazuma's real-device view stays ground truth.
set -euo pipefail

PREVIEW="/home/gcp/ozzu/frontend/preview"
BROWSER="http://127.0.0.1:3334"
SCREEN="${1:-home}"
EXTRA="${2:-}"
OUT="${3:-/tmp/ozzu-preview}"
PORT=8791
mkdir -p "$OUT"

# 1. bundle the harness
( cd "$PREVIEW" && node build.mjs >/dev/null )

# 2. ensure the preview server (static + bridge proxy) is up. The /status probe
#    proves the PROXY is live — a stale plain http.server on the port fails it
#    and gets replaced.
if ! curl -sf -o /dev/null "http://127.0.0.1:$PORT/status" 2>/dev/null; then
  pkill -f "http.server $PORT" 2>/dev/null || true
  pkill -f "preview/serve.py" 2>/dev/null || true
  ( cd "$PREVIEW" && nohup python3 serve.py "$PORT" >/tmp/ozzu-preview-server.log 2>&1 & )
fi
curl -sf --retry-connrefused --retry 15 --retry-delay 1 -o /dev/null "http://127.0.0.1:$PORT/index.html"

# 3. navigate + screenshot via the browser container; crop to the iPhone frame
python3 - "$OUT" "$SCREEN" "$EXTRA" "$PORT" "$BROWSER" <<'PY'
import json, time, urllib.request, urllib.parse, base64, sys
out, screen, extra, port, browser = sys.argv[1:6]
q = urllib.parse.urlencode({"screen": screen}) + (f"&{extra}" if extra else "")
sid = f"preview-{screen}"

def post(endpoint, payload, timeout=60):
    req = urllib.request.Request(f"{browser}{endpoint}", data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=timeout))

# Navigate on the load event — NOT networkidle: screens fetch live bridge data
# through the proxy and some keep polling, so networkidle can hang. Load, then
# give React a fixed settle window to render the fetched data, then screenshot.
r = post("/navigate", {"url": f"http://127.0.0.1:{port}/index.html?{q}",
                       "session_id": sid, "wait_for": "load"})
if not r.get("ok"):
    print("NAVIGATE FAILED:", r.get("error")); sys.exit(1)
time.sleep(3.5)
r = post("/screenshot", {"session_id": sid})
if not r.get("screenshot"):
    print("NO SCREENSHOT:", r.get("error")); sys.exit(1)
suffix = ""
if "=" in extra:
    suffix = "-" + extra.split("=", 1)[1]
p = f"{out}/{screen}{suffix}.png"
open(p, "wb").write(base64.b64decode(r["screenshot"]))
# best-effort crop to the 393x852 iPhone frame (top-left of the viewport)
try:
    from PIL import Image
    Image.open(p).crop((0, 0, 393, 852)).save(p)
except Exception:
    pass
print(p)
PY
