# 3D Print Pipeline — STL → Slice → Print → Record

Cipher MUST use this pipeline. Slicing AND recording are LOCAL on the bridge VM — NO dev-01 dependency anywhere in the print path. King Kazuma's standing rule (2026-05-10): dev-01 must NOT be in the print pipeline. dev-01 is unreliable (dropped off WG twice in 24h blocking all prints) and there's no engineering reason it ever needed to be in the path. Both slicer (dir_1778425211161) and recorder (dir_1778450259617) were fixed to remove the dev-01 dependency.

## Architecture (where each component lives)

| Component | Where | Notes |
|---|---|---|
| **STL files** | bridge filesystem (`/home/gcp/ozzu/private/drone/cad/`, etc.) | Cipher generates / edits these |
| **Slicer** (PrusaSlicer 2.7.2) | **bridge VM** (`/usr/bin/prusa-slicer`, apt package) | Updated 2026-05-10 — NO LONGER on dev-01. Runs in-process from the bridge. |
| **Print camera recorder** (ffmpeg) | **bridge VM** (`/usr/bin/ffmpeg`, apt package) | Updated 2026-05-10 — NO LONGER on dev-01. ffmpeg pulls MJPEG from `http://10.9.0.7:5001/mjpeg` directly over WG, encodes H.264 MP4, saves to `/home/gcp/ozzu/data/files/3d-prints/<date>/`. |
| **OctoPrint** (Octo4a app) | **ozzu-tab** at `10.9.0.7` (Android tablet, Octo4a in proot) | Reachable directly at `http://10.9.0.7:5000` over WG VPN |
| **MJPEG camera service** | **ozzu-tab** at `http://10.9.0.7:5001/mjpeg` (Android tablet, mjpeg-streamer or Octo4a webcam) | Source for recorder ffmpeg |
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

In parallel, when OctoPrint webhook fires PrintStarted:
        ▼
ffmpeg (LOCAL on bridge) ←─── http://10.9.0.7:5001/mjpeg (over WG)
        │  -c:v libx264 -preset veryfast -crf 23 -movflags +faststart
        │  output: /tmp/ozzu-rec/<jobName>.mp4
        ▼
On webhook PrintDone/Failed/Cancelled:
SIGINT → ffmpeg → flush moov atom → close MP4 cleanly
        │
        ▼
mv → /home/gcp/ozzu/data/files/3d-prints/<YYYY-MM-DD>/<ts>_<jobName>.mp4
        │
        ▼
INSERT INTO postgres files table (folder = "3D Prints")
        │
        ▼
Mobile app shows it in Files / 3D Prints
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
| Print an STL | `curl -sX POST http://localhost:3333/octoprint/print -H "Content-Type: application/json" -H "Authorization: Bearer $BRIDGE_TOKEN" -d '{"stl_path":"/path/to/foo.stl"}'` |
| Slice only (test if STL is printable, no print) | same as above with `"dry_run": true` |
| Live status | `curl -sH "Authorization: Bearer $BRIDGE_TOKEN" http://localhost:3333/octoprint/status` |
| Cancel print | `POST /octoprint/cancel` |

`BRIDGE_TOKEN` lives in `/home/gcp/ozzu/.env` as `BRIDGE_TOKEN=...`.

## When the pipeline breaks

- **prusa-slicer not in PATH inside container** → `docker exec bridge which prusa-slicer` should print `/usr/bin/prusa-slicer`. If missing, run `docker exec bridge apt install -y prusa-slicer` (it's in the Dockerfile so a rebuild also fixes it permanently).
- **ffmpeg not in PATH inside container** → `docker exec bridge which ffmpeg` should print `/usr/bin/ffmpeg`. Same fix as above with `ffmpeg`.
- **OctoPrint not reachable** → first check WG link (`ping 10.9.0.7`), then check Octo4a app on the tablet.
- **MJPEG camera not reachable** → `curl -sI http://10.9.0.7:5001/mjpeg` from the bridge container. Should return HTTP 200 with `Content-Type: multipart/x-mixed-replace`. If it 404s or times out, check the tablet's mjpeg-streamer / Octo4a webcam config.
- **Printer offline** → ozzu-tab must be powered, USB cable seated, Octo4a app running. SSH to tablet via ADB to debug.
- **Recorder produces empty MP4** → check `/tmp/ozzu-rec/<jobName>.log` inside bridge container for ffmpeg stderr. Common cause: MJPEG service not running on tablet at the time recording started.

## Source files (don't grep ad-hoc — these are the canonical locations)

- Pipeline orchestrator: `backend/bridge/octoprint-pipeline.js`
- OctoPrint REST client: `backend/bridge/octoprint-client.js`
- Print recorder (camera): `backend/bridge/octoprint-recorder.js`
- HTTP route: `backend/bridge/routes/octoprint.js`
- Print-event webhook: `POST /octoprint/webhook` (events.yaml on tablet fires it on PrintStarted/Done/Failed/Cancelled)

## Anti-patterns (don't do these)

- ❌ **Adding dev-01 anywhere in the print pipeline.** Standing rule from King Kazuma. Both prusa-slicer and ffmpeg run IN the bridge container as apt packages. dev-01 has no role in the print path. Every previous Cipher session that "needed dev-01 because it had X installed" got the architecture wrong — install it in the bridge container instead.
- ❌ `ssh dev-01` for ANY print-pipeline operation (slicing, recording, anything). dev-01 is unreliable and removed from the path.
- ❌ Manual `scp` of STL or gcode anywhere — the bridge's `/octoprint/print` endpoint does the whole chain locally.
- ❌ Re-deriving the slicer/recorder paths each session — read THIS file. The bridge container has prusa-slicer + ffmpeg pre-installed via Dockerfile.
- ❌ ADB-forwarding to talk to OctoPrint when WG-direct works fine. The legacy ADB path in `octoprint-client.js` is opt-in via `OCTOPRINT_USE_ADB=1` only; default is WG-direct to `10.9.0.7:5000`.
