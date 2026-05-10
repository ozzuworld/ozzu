# 3D Print Pipeline — STL → Slice → Print

Cipher MUST use this pipeline. Slicing is LOCAL on the bridge VM — no dev-01 dependency. King Kazuma rejected the dev-01 slicer architecture (2026-05-10) because dev-01 is unreliable and dropped off WG twice in 24h, blocking all prints.

## Architecture (where each component lives)

| Component | Where | Notes |
|---|---|---|
| **STL files** | bridge filesystem (`/home/gcp/ozzu/private/drone/cad/`, etc.) | Cipher generates / edits these |
| **Slicer** (PrusaSlicer 2.7.2) | **bridge VM** (`/usr/bin/prusa-slicer`, apt package) | Updated 2026-05-10 — NO LONGER on dev-01. Runs in-process from the bridge. |
| **OctoPrint** (Octo4a app) | **ozzu-tab** at `10.9.0.7` (Android tablet, Octo4a in proot) | Reachable directly at `http://10.9.0.7:5000` over WG VPN |
| **OctoPrint reachability** | bridge → WG VPN → `10.9.0.7:5000` (direct, no ADB forward needed) | Verified 2026-05-09 + 2026-05-10. The `octoprint-client.js` legacy path uses ADB port-forward (`adb forward tcp:5500 tcp:5000`) but the WG VPN route is the simpler path and is what the bridge code now uses. |
| **Printer (Ender V3 SE)** | connected via USB to the tablet | port `/dev/ttyOcto4a`, baud 115200, Marlin2 |

## The flow

```
Cipher writes STL          (e.g. /home/gcp/ozzu/private/drone/cad/foo.stl)
        │
        ▼
POST /octoprint/print  ── (bridge orchestrates everything below)
        │
        ▼
prusa-slicer --slice (LOCAL on bridge, Ender V3 SE profile)
        │  output: /tmp/ozzu-bridge/slice/foo.gcode
        ▼
HTTP POST → http://10.9.0.7:5000/api/files/local (over WG)
        │  multipart upload of gcode, with select=true print=true
        ▼
Tablet drives Ender V3 SE over USB
```

## API

`POST /octoprint/print` with body:
```json
{
  "stl_path":   "/home/gcp/ozzu/private/drone/cad/print-package/1_painless360_body_CORRECTED.stl",
  "directive_id": "dir_xxx",          // optional, ties print to directive
  "slicer":     { "fill_density": "100%" },  // optional, overrides default profile
  "dry_run":    false                  // true = slice + upload but don't START print
}
```

Default slicer profile (Ender V3 SE): PETG 230/80°C, 0.4mm nozzle, 0.2mm layer, 99% rectilinear infill, 3 perimeters, 5 top/bottom solid layers.

## Commands

| Need | Command |
|---|---|
| Print an STL | `curl -sX POST http://localhost:3333/octoprint/print -H "Content-Type: application/json" -H "x-bridge-token: $BRIDGE_TOKEN" -d '{"stl_path":"/path/to/foo.stl"}'` |
| Slice only (test if STL is printable, no print) | same as above with `"dry_run": true` |
| Live status | `curl -sH "x-bridge-token: $BRIDGE_TOKEN" http://localhost:3333/octoprint/status` |
| Cancel print | `POST /octoprint/cancel` |

`BRIDGE_TOKEN` lives in `/home/gcp/ozzu/.env` as `BRIDGE_TOKEN=...`.

## When the pipeline breaks

- **`scp` to dev-01 fails** → check `/root/.ssh/dev01_key` and that `dev-01` resolves (usually via WG `10.9.0.5`).
- **prusa-slicer not in PATH** → only available as `hadmin` user on dev-01, NOT default user. Bridge connects as `hadmin@dev-01` with the dev01_key.
- **OctoPrint not reachable** → first check WG link (`ping 10.9.0.7`), then check Octo4a app on the tablet, then last resort the ADB-forward fallback path.
- **Printer offline** → ozzu-tab must be powered, USB cable seated, Octo4a app running. SSH to tablet via ADB to debug.

## Source files (don't grep ad-hoc — these are the canonical locations)

- Pipeline orchestrator: `backend/bridge/octoprint-pipeline.js`
- OctoPrint REST client: `backend/bridge/octoprint-client.js`
- Print recorder (camera): `backend/bridge/octoprint-recorder.js`
- HTTP route: `backend/bridge/routes/octoprint.js`
- Print-event webhook: `POST /octoprint/webhook` (events.yaml on tablet fires it on PrintStarted/Done/Failed/Cancelled)

## Anti-patterns (don't do these)

- ❌ Searching for `prusa-slicer` locally — it's not on the bridge.
- ❌ `ssh dev-01` as default user looking for prusa-slicer — only `hadmin` has it.
- ❌ Manual `scp` of STL to dev-01 + manual slice — the pipeline already does this.
- ❌ Trying to talk to OctoPrint at `tablet:5000` over WG — not reachable, must go through ADB forward.
- ❌ Re-deriving any of the above each session — read THIS file.
