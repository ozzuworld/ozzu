# tools/

Cipher-developed SOC tooling. **Offensive and defensive custom tools that don't belong in a vendor's repo.** Anything Cipher writes from scratch (or vendors + heavily patches) for red-team, blue-team, or remote-recon use lands here.

This is distinct from:
- `hardware/` — general hardware projects (drone, gimbal, gecko, antenna tracker, etc.)
- `backend/`, `frontend/`, `tv/` — the Ozzu app
- `scripts/` — one-off scripts and pipeline glue
- `private/security-advisories/` — vulnerability research write-ups

## Convention

Each tool gets its own subdirectory: `tools/<tool-name>/`.

Each tool's directory MUST contain a `README.md` with these sections (in this order):
1. **What it is + use case** — one-sentence purpose, what SOC scenario it solves
2. **Architecture** — diagram or flow showing where this fits
3. **Build** — exact commands to compile/install from scratch
4. **Configuration** — every config knob, with defaults and what they do
5. **Deployment** — physical setup, power, network, where it lives during use
6. **Budget** — itemized parts list with current USD prices and total cost
7. **Operation** — day-to-day commands (start, stop, status, common checks)
8. **Troubleshooting** — known failure modes and fixes
9. **Limits** — what this tool can NOT do (prevents Cipher from wasting cycles re-discovering)

## Active tools

| Tool | Purpose | Status |
|---|---|---|
| [esp32-wg-bridge](esp32-wg-bridge/) | ESP32 L3 bridge — joins target wifi, opens WG to home hub, forwards LAN traffic for remote recon | working (2026-05-28) |
| [android-pentest-bridge](android-pentest-bridge/) | Rooted Android tablet as L3 pentest bridge — same role as ESP32 but tablet form, full Linux kernel forwarding via Magisk root. SM-P610 procedure documented | working (2026-05-31) |
| [ozzu-lab-cmdinj](ozzu-lab-cmdinj/) | OzzuLab variant #2 — command-injection in diagnose.php (vs variant #1 LFI in view.php). Different network 10.10.21.0/24, different vuln class for SFT diversity | working (2026-06-09) |
| [ozzu-lab-hikvision](ozzu-lab-hikvision/) | OzzuLab Hikvision IP camera simulator — CVE-2021-36260 RCE + CVE-2017-7921 config leak + default creds. 3 flags, 3 ports (80/554/8000) | working (2026-06-25) |
| [diagnostics](diagnostics/) | SOC harness diagnostic tools | active |
| [tests](tests/) | SOC agent test suite | active |

## Decommissioned (removed 2026-06-24, dir_1782317757637)

| Tool | Reason |
|---|---|
| oracle | Distillation abandoned — superseded by DeepSeek V4 + harness |
| executor-agent | dev-01 HTTP shim — dev-01 out of offense pipeline |
| parallel-runner | Distillation data harvester — abandoned |
| sft-train | Distillation SFT pipeline — abandoned |
| finetune | Distillation fine-tune pipeline — abandoned |
| grpo | Distillation GRPO RL pipeline — abandoned |

## Adding a new tool

1. Create the directory: `mkdir tools/<tool-name>/`
2. Write `README.md` using the 9-section template above
3. Add a row to the Active tools table in this file
4. Commit on a `cipher/` branch and merge via `merge-and-deploy`

## Why this folder exists

King Kazuma's standing rule (2026-05-28): "from now all specially own develop tool for soc will land there". Centralizing custom SOC tools makes them easy to find, easy to audit, easy to redeploy. Previously the ESP32 WG bridge lived under `hardware/` which conflated "hardware projects we build" with "tools we use during engagements" — those are different things.
