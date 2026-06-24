---
paths:
  - "backend/**"
---

# Backend Architecture

> **Infra facts (device IPs, SSH paths, VPN topology, ports, credentials) live in `~/.claude/projects/-home-gcp-ozzu/memory/infra_registry.md` — read it before assuming any address. This file describes code architecture only.**

## WhatsApp
- whatsapp-mcp stack: whatsmeow Go bridge (41 tools) + Python MCP server (SSE) + QR pairing UI
- Supports text + media, groups, reactions, polls, presence, newsletters
- Containers: whatsapp-bridge (8180), whatsapp-mcp (8081), whatsapp-web-ui (8090) — separate compose in `whatsapp-mcp/`
- **NOTE:** Containers may be DOWN — check `docker ps` before assuming availability

## Email
- nodemailer v8 for SMTP (Gmail OAuth2)
- IMAP available (imap@0.8.19 + mailparser) but NOT exposed via routes
- Two accounts: eng.hsuarezp@gmail.com (personal), eng.ozzu@gmail.com (ozzu)
- iCloud: eng.ozzu@icloud.com (forwarding only)
- Gmail MCP servers are DOWN as of 2026-06-03 (creds wiped, parked)

## Bridge MCP
- Custom JSON-RPC over HTTP at POST /mcp (NOT stdio)
- 60+ tools registered — defined inline in `routes/mcp.js`
- Bridge server: localhost:3333

## Docker Services
See registry §3 (Services) for the canonical container list and ports. WireGuard server is on the host kernel (not a container); OpenVPN is decommissioned (2026-05-02).

## Verification
- Syntax check: `node -c <file>`
- Docker: `docker compose config -q`
