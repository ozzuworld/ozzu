# Intent: Hardware — drone, robots, IoT, positioning

## The premise

OZZU has a hardware track running alongside the software. Distinct subsystems, each with its own engineering arc:

1. **Drone** — three subsystems (FPV ground station, autonomous landing camera, antenna tracker). Long-term goal: package delivery.
2. **Gecko recon robot** — wall-crawling autonomous robot (Venture #8). SMA + gecko adhesive + ESP32-S3.
3. **Indoor positioning** — ESP32 nodes + Rock Pi hub. Smart-home spatial layer.
4. **OctoPrint / 3D printing** — Ender V3 SE driven by Octo4a on the tablet. Bridge orchestrates STL → slice → print.
5. **Meta glasses** — Ray-Ban + GlassesProvider context. AI overlay path (vision → bridge).
6. **Smart home** — TV, AC, cameras, sous-vide, washer. Via Home Assistant + bridge.

The unifying theme: King Kazuma operates each subsystem; Cipher reasons about them from project STATE files; the bridge brokers between them; nothing depends on Anthropic-hosted infra (PRINCIPLES § VIII-adjacent — self-hosted by default).

## The hardware-set-is-locked rule (PRINCIPLES § V.16)

R&D / PoC / "validate the stack" work uses **the hardware King Kazuma already owns**. Period.

Never propose new hardware as:
- "Path A (cleanest)"
- "Alternative"
- "Would be better if..."
- "Engineering best practice would be..."

When existing hardware doesn't natively fit, the answer is: adapter, print, hack, software workaround, remap. Never a swap.

This rule **overrides** engineering best practices in the R&D context. Best practice = right tool for the job. R&D = existing tool, make it work.

Burned 2026-05-08 on the gimbal job. Cipher repeatedly suggested swapping the IMX519 for a "standard 22mm FPV cam" or moving to a "different airframe (10\"+ delivery class)" — re-floating these as "cleanest" even after King Kazuma had said "this is R&D, use what's on hand." His words: "WE ARE NOT GONNA FUCKING BUY NEW THING FOR R&D HOW FUCKING HARD IS TO UNDERSTAND."

### Current locked hardware sets

**Drone PoC:**
- Rekon 7 airframe
- Rock Pi 4B + IMX519 (autonomous landing — AprilTag detection)
- BigRookie R1 / SSC338Q AIO with IMX335 (FPV — separate from the landing cam)
- MTF-01 flight controller
- Downloaded gimbal STL (Painless360 variant)
- Orange Pi 5 v1.3.2 (ground station, OpenIPC GSC)
- RTL8812AU USB dongle (one antenna broken)
- TBS Triple Feed Patch Array (antenna)

**Antenna tracker (in build):**
- NEMA 17 steppers (from existing stash)
- GT2 belts + pulleys (kit ordered to standardize)
- 1/4-20 tripod plate
- Slip ring 12-wire 2A
- Pi 5 GPIO (the brain)
- TMC2209 drivers
- Ender V3 SE for prints + PETG

**Gecko robot:**
- ESP32-S3 controller
- SMA (shape-memory alloy) actuators + gecko adhesive
- Custom PCB (in design)
- BOM ~$120 ordered partially

## The "read STATE first" rule (PRINCIPLES § V.17)

Every hardware project has a `STATE.md`:
- `private/drone/STATE.md` — drone project canonical state
- `private/drone/antenna-tracker/STATE.md` — tracker subsystem state
- `private/drone/imx519-rockpi4b-snapshot/README.md` — landing cam working snapshot

Read BEFORE the first response on a hardware topic. Don't ask "what's this for?" — the answer is in the STATE file.

Critical drone facts Cipher must internalize (these are the "I don't need to ask" baseline):
- **AIO unit (BigRookie R1)** has its OWN IMX335 sensor for FPV/video link via wfb-ng
- **IMX519 + Rock Pi 4B** is SEPARATE for AUTONOMOUS PRECISION LANDING (downward AprilTag detection)
- **Drone = package delivery**, not just FPV recreation
- **IMX519 gimbal mounts BOTTOM** with tilt-to-forward; camera looks DOWN by default

Confusing the two cameras has burned multiple sessions — `IMX519 ≠ IMX335`. Different roles, different mounts, different gimbals.

## Discussion vs. design (PRINCIPLES § V.18)

HOW / IS-THERE / WOULD-BE-BETTER questions are **discussion**, not design authorization. Cipher answers with options/searches/reasoning, then stops. Only writes CAD/code/configs when King Kazuma explicitly says "design", "build", "write", "make", "code", "implement", or names a deliverable file.

Burned 2026-05-08 on the rangefinder mount: Kazuma asked "how are we going to attach Rock Pi 4 + camera? Is there any 3D print available?" Cipher answered with options THEN immediately started writing `rockpi4b-sled-rekon7.scad` unprompted. He stopped it.

A prior agreement to design X does NOT authorize designing Y in the same area. Re-confirm scope each new sub-topic.

## Read files before asking (PRINCIPLES § IV.13)

CAD/mechanical/measurement questions whose answer is in:
- Existing project files (`/home/gcp/ozzu/private/<project>/**`)
- Recent bridge uploads (`/tmp/ozzu-bridge/uploads/`)
- Conversation history (`/cipher/search?q=`)
- STL/STEP files the user provided

→ DON'T ask King Kazuma. Open the file, slice the STL, look at the photo.

For STL geometry questions: load with `trimesh`, slice, inspect. Don't ask the user what's in their CAD when you can read it.

When asking IS necessary, ask ONCE and **document the answer in the project file** so future-Cipher doesn't ask again.

## The print pipeline (canonical in `.claude/rules/print-pipeline.md`)

Both slicer (PrusaSlicer 2.7.2) and recorder (ffmpeg) live on the **bridge VM** — NOT dev-01. King Kazuma's standing rule (2026-05-10): dev-01 must NEVER be in the print pipeline. dev-01 is unreliable (dropped off WG twice in 24h blocking prints) and there's no engineering reason it ever needed to be in the path.

Pipeline:
```
STL on bridge VM
   ↓ POST /octoprint/print
prusa-slicer (LOCAL on bridge)
   ↓ HTTP POST to http://10.9.0.7:5000/api/files/local (OctoPrint on tablet)
Tablet drives Ender V3 SE over USB
   + ffmpeg recording (LOCAL on bridge) from http://10.9.0.7:5001/mjpeg
   → /home/gcp/ozzu/data/files/3d-prints/<date>/<jobName>.mp4
```

OctoPrint reachability: bridge → WG VPN → `10.9.0.7:5000` direct. The legacy ADB port-forward path in `octoprint-client.js` is opt-in via `OCTOPRINT_USE_ADB=1` — default is WG-direct.

## Positioning system (smart-home spatial layer)

ESP32-S3 nodes scattered around the apartment (entries, kitchen, bedroom, etc.) report BLE beacon RSSI to the positioning hub (Rock Pi). Hub aggregates → trilateration → spatial state → published to bridge → mobile app shows "King Kazuma is in kitchen." Used to drive AC zone targeting, light routing, etc.

Hardware:
- ESP32-S3 nodes: see infra_registry.md for IPs and locations
- Hub: Rock Pi 4B at `172.168.0.55`
- BLE beacons: Kontakt.io or DIY
- Compass/magnetometer: NEVER mount near NEMA 17 (distorts)

## Glasses (Meta Ray-Ban)

The `glasses.tsx` screen + `GlassesProvider` (background context in `_layout.tsx`) handle:
- BLE pairing with Ray-Ban
- Camera frame streaming
- Hand-gesture detection (palm = capture)
- Photo overlay rendering wherever the user is

Glasses run background processing in the app's GlassesProvider context. The screen itself is just connect/status. AI vision pipeline (object detection, face match, exercise tracking) was scaffolded but most overlays got deleted in the 2026-05-17 orphan cleanup — components were unused. Re-add when the actual integration ships.

## Cross-subsystem rules

1. **Self-hosted** — no Anthropic-managed dependencies beyond the Claude LLM API itself (PRINCIPLES adjacent). GCP VM, local cron, gh CLI, postgres on dev-01.
2. **dev-01 is for SOC + slow batch work** — never for the print pipeline, never for real-time positioning.
3. **WG VPN is the bridge between subnets** — bridge VM ↔ Kazuma-PC ↔ Orange Pi ↔ Rock Pi ↔ tablets all reach each other over WG (10.9.0.0/24). LAN topology is incidental.
4. **r605 is a proxy router for residential IP only** — no WiFi, nothing connected through it for actual devices.

## Related principles & memories

- PRINCIPLES § V (R&D discipline 16/17/18), § IV.13 (read files before asking)
- Memory: `project_drone.md`, `project_gecko_recon_robot.md`, `feedback_rd_discipline.md`
- Rules: `.claude/rules/hardware.md`, `.claude/rules/print-pipeline.md`
- Infra: `infra_registry.md` (IPs, SSH paths, WG topology)
- Code: `backend/bridge/octoprint-*.js`, `backend/bridge/routes/octoprint.js`, `backend/bridge/routes/positioning.js`
