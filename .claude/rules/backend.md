---
paths:
  - "backend/**"
---

# Backend Architecture

> **Infra facts (device IPs, SSH paths, VPN topology, ports, credentials) live in `~/.claude/projects/-home-gcp-ozzu/memory/infra_registry.md` — read it before assuming any address. This file describes code architecture only.**

## WhatsApp
- Baileys runs on physical Android phone (CAT S41 — see registry §1 "Ozzu Android" for current WG IP / install state). Not on GCP.
- Bridge proxies via SSH reverse tunnel: GCP:8766 → Android:8765
- Text only currently, no media support
- Send: `POST /whatsapp/send` → bridge → SSH tunnel → Android Baileys
- Read: `POST /whatsapp/read` → same path, reverse

## Email
- nodemailer v8 for SMTP (Gmail OAuth2)
- IMAP available (imap@0.8.19 + mailparser) but NOT exposed via routes
- Two accounts: eng.hsuarezp@gmail.com (personal), eng.ozzu@gmail.com (ozzu)
- iCloud: eng.ozzu@icloud.com (forwarding only)

## Bridge MCP
- Custom JSON-RPC over HTTP at POST /mcp (NOT stdio)
- 30+ tools registered — check bridge/mcp-tools/ for current list
- Bridge server: localhost:3333

## Docker Services
See registry §3 (Services) for the canonical container list and ports. WireGuard server is on the host kernel (not a container); OpenVPN is decommissioned (2026-05-02).

## Android Agent
- Physical CAT S41 phone — see registry §1 for current network state (WG install pending as of 2026-05-02).
- ADB: connect to the phone's current WG IP on port 5555 once installed.
- Runs Baileys + agent services
- Deploy: `./scripts/deploy.sh [device-names]`

## Verification
- Syntax check: `node -c <file>`
- Docker: `docker compose config -q`
