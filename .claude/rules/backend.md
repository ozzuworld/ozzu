---
paths:
  - "backend/**"
---

# Backend Architecture

## WhatsApp
- Baileys runs on physical Android phone (CAT S41, 10.8.0.3) — NOT on GCP
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
| Service | Port |
|---------|------|
| bridge | 3333 |
| postgres | 5432 |
| qdrant | 6333/6334 |
| redis | 6379 |
| face-recognition | 5555 |
| nginx | 80/443 |
| openvpn | 1194 |
| browser | 9222 |
| osint-tools | 8080 |
| anisette | 6969 |

## Android Agent
- Physical CAT S41 phone, connected via VPN (10.8.0.3)
- ADB: 10.8.0.3:5555
- Runs Baileys + agent services
- Deploy: `./scripts/deploy.sh [device-names]`

## Verification
- Syntax check: `node -c <file>`
- Docker: `docker compose config -q`
