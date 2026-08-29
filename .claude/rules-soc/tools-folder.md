# tools/ — Cipher-developed SOC tooling

`tools/` is the home for **custom SOC tools that Cipher writes from scratch** (or vendors then heavily patches). Everything Cipher builds for offensive recon, defensive monitoring, or red/blue team use lands here.

## When to put something in tools/

- It's custom code Cipher wrote (firmware, scripts, agents, daemons, custom protocol implementations)
- Its primary use case is SOC work (pentesting, recon, defensive monitoring, evidence collection)
- It's reusable across engagements, not engagement-specific scratch

## When NOT to put something in tools/

- General hardware projects (drone, gimbal, gecko robot, antenna tracker) → `hardware/`
- Ozzu app code → `frontend/`, `backend/`, `tv/`
- One-off scripts and pipeline glue → `scripts/`
- Vulnerability research write-ups → `private/security-advisories/`
- Public-facing SOC platform code (the SOC tab, MCP tools) → already lives under `frontend/app/soc/` and `backend/bridge/routes/soc.js`
- Engagement-specific evidence → `private/<engagement-id>/`

## Convention for each tool

Every tool gets its own `tools/<tool-name>/` directory with a `README.md` containing the 9 standard sections (purpose, architecture, build, configuration, deployment, budget, operation, troubleshooting, limits). See `tools/README.md` for the template.

## Active tools

| Tool | Purpose |
|---|---|
| `tools/esp32-wg-bridge/` | ESP32 L3 bridge — drop inside a target WiFi to get remote LAN access via WireGuard |
| `tools/android-pentest-bridge/` | Rooted Android tablet as L3 pentest bridge — same role as ESP32 but tablet form. Magisk root + iptables + Android-routing fixes. SM-P610-tested. |
| `tools/ozzu-lab-cmdinj/` | OzzuLab variant #2 — command-injection training lab for offense model diversity |
| `tools/ozzu-lab-hikvision/` | OzzuLab Hikvision IP camera sim — CVE-2021-36260 RCE + CVE-2017-7921 + default creds, 3 flags |
| `tools/diagnostics/` | SOC harness diagnostic tools |
| `tools/tests/` | SOC agent test suite |

## When adding a new tool

1. `mkdir tools/<tool-name>/`
2. Write `README.md` using the 9-section template from `tools/README.md`
3. Add a row to the Active tools table in `tools/README.md` AND in this file
4. Work on a `cipher/` branch, commit, then merge via `merge-and-deploy`

## Why this exists

King Kazuma's standing rule (2026-05-28): centralize custom SOC dev tools so they're easy to find, audit, redeploy. Previously the ESP32 WG bridge lived under `hardware/` which conflated "hardware projects we build" with "tools we use during engagements." Those are different things.
