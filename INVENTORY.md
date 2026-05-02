# OZZU PROJECT INVENTORY
# CHECK THIS BEFORE BUILDING ANYTHING. If it exists here, USE IT. Do NOT rebuild.
# Last updated: 2026-05-02

> **Canonical infra source:** `~/.claude/projects/-home-gcp-ozzu/memory/infra_registry.md`
> All device IPs, SSH paths, VPN topology, DNS, and credentials live there.
> This file lists what *exists in the repo/deployments* (containers, scripts, modules) — not network facts.
> If you need an IP, hostname, key, or VPN endpoint, READ THE REGISTRY.

---

## Active Infrastructure

### GCP VM
Primary compute — always on. All services run here via Docker. See registry §1 (GCP VM) for IPs/hostname/scopes.

| Container | Port | Purpose | Status |
|-----------|------|---------|--------|
| bridge | 3333 | Command bridge (API, directives, Cipher, MCP) | ✅ running |
| postgres | 5432 | Main DB (memories, conversations, directives, finance) | ✅ running |
| redis | 6379 | Session cache, ephemeral state | ✅ running |
| qdrant | 6333 | Vector DB — 51M+ face embeddings | ✅ running |
| nginx | 80/443 | SSL proxy (home.ozzu.world) | ✅ running |
| anisette | 6969 | Apple auth for iOS sideloading | ✅ running |
| face-recognition | 5555 | Face embedding + search API | ✅ running |
| osint-tools | internal | OSINT scan engine | ✅ running |
| browser | 3334 | Headless browser for web tasks | ✅ running |
| whatsapp-bridge | 8180 | WhatsApp MCP — whatsmeow Go bridge (41 tools) | ✅ running |
| whatsapp-mcp | 8081 | WhatsApp MCP — Python MCP server (SSE) | ✅ running |
| whatsapp-web-ui | 8090 | WhatsApp MCP — QR pairing + webhook UI | ✅ running |

WireGuard runs on the host (kernel `wg0`, udp/51820), not as a container. OpenVPN was decommissioned 2026-05-02 — see registry §4.

### VPN clients
**See registry §4 (WireGuard Configuration) for the authoritative peer list.** Briefly: dev-01 / kazuma-pc / orangepi5 active on WG 10.9.0.0/24; ozzu-android config exists but not yet installed.

### Android Phone — WhatsApp Agent
| Item | Value |
|------|-------|
| Number | 3226033350 |
| Device | CAT S41 (always on) |
| Stack | Termux → Node.js → Baileys → WA Web |
| SSH access | `ssh -p 8023 localhost` (via reverse tunnel GCP:8023→phone:8022) |
| WA API | GCP:8766 → phone:8765 (reverse tunnel) |
| Auto-start | Termux:Boot → `~/.termux/boot/start.sh` |
| Auth | Saved to `~/wa-auth/` — survives restarts |

### iPhone (King Kazuma)
- Ozzu app installed via AltStore (sideload from Windows laptop)
- **NEVER receives OTA** — all iOS changes require native build + sideload
- Push notifications: APNs via bridge `push-notifications.js`

---

## Scripts (/home/gcp/ozzu/scripts/)

| Script | Purpose | Key flags/notes |
|--------|---------|-----------------|
| **embed-pipeline-v2.py** | Face embedding — 85K/min on RTX 3090 | `--local-qdrant` (MANDATORY), `--all`, `--benchmark` |
| **setup-vast-gpu.sh** | One-shot vast.ai GPU instance setup | `<host> <port> [--start]` — MUST include --local-qdrant |
| embed-glint360k.py | Glint360K dataset (17.1M faces) | `[start_shard] [end_shard]` |
| embed-hf-dataset.py | Any HuggingFace WebDataset → Qdrant | `<dataset_name> [start] [end]` |
| embed-parquet-dataset.py | Parquet format datasets → Qdrant | |
| face-clusterer.py | Identity clustering (Union-Find) | `--incremental`, `--stats` |
| deploy.sh | Android APK deploy from CI | `[device-names]`, `--local` |
| ota-deploy.sh | OTA JS update (Android ONLY) | `--restart` |
| ota-deploy-tv.sh | OTA JS update (TV app) | Separate runtimeVersion `tv-1.0.0` |
| deploy-ios.sh | iOS IPA via AltStore on Windows laptop | `--local /path`, `--check` |
| cipher.sh | Launch Cipher with memory context | Loads from bridge /cipher/context |
| cipher-guard.sh | PreToolUse hook — enforce pipeline | Blocks edits without directive |
| cipher-session-save.sh | SessionEnd hook — save to postgres | |
| inject-last-conversation.sh | UserPromptSubmit hook — inject context | Pre-flight checklist on first msg |
| backup.sh | Encrypted backup of all data | `--no-encrypt` |
| gpu-orchestrator.sh | Unattended multi-dataset GPU runner | Auto-recovery, heartbeat |
| start-gmail-mcp.sh | Launch Gmail MCP servers (both accounts) | Requires `backend/.env.gmail` OAuth creds |

---

## GPU Pipeline — Proven Optimizations (DO NOT REDO)

These took 1 week to build and tune on embed-pipeline-v2.py:

1. **`--local-qdrant`** (MANDATORY): Downloads Qdrant binary, runs localhost. 15K → 85K/min. NEVER launch without it.
2. **Shared memory decode**: Zero pickle IPC. Workers write to pre-allocated shared numpy arrays.
3. **IOBinding**: Pre-allocated GPU memory, avoids CPU↔GPU copies. +4% throughput.
4. **Double-buffer**: Extract+decode next shard while GPU processes current. +12%.
5. **`QDRANT_BATCH=2000`**: NOT 5000. 5000 exceeds 32MB JSON payload limit.
6. **`GPU_BATCH=512`**: Saturates 3090 cores.
7. **tmux required on vast.ai**: nohup doesn't survive SSH disconnect.
8. **PCIe 24+ preferred**: PCIe Gen 1 = 4 GB/s = severe bottleneck.

---

## Face DB

- **Live count**: always `curl -s http://localhost:6333/collections/faces` — NEVER guess
- **Completed datasets**: Glint360K (17.1M), MS1MV3, WebFace4M, VGGFace2, MS1MV2, CASIA, CelebA
- **Current**: ~51M vectors, HNSW indexed (m=16, ef_construct=100, on_disk=true)

---

## Deploy Workflow

| Change type | Command |
|-------------|---------|
| Android OTA (JS only) | `./scripts/ota-deploy.sh --restart` |
| Android APK (native) | CI auto-triggers after merge |
| iOS | `gh workflow run build-ios.yml` → King Kazuma installs via AltStore |
| TV OTA (JS only) | `./scripts/ota-deploy-tv.sh` |
| TV APK (native) | CI auto-triggers on `tv/` push to main → self-installs via Device Owner |
| Bridge restart | `docker compose restart bridge` (in `/home/gcp/ozzu/backend/`) |
| Full redeploy | `POST /directives/{id}/merge-and-deploy` via MCP |

smartDeploy auto-triggers after every merge — **NEVER manually trigger builds**.

---

## Backup Locations

**Two independent backup systems exist — check BOTH when recovering data.**

### 1. App-triggered backups (encrypted)
- **Path:** `/home/gcp/ozzu/backups/`
- **Format:** `ozzu-backup-YYYYMMDD_HHMMSS.tar.gz.enc`
- **Encryption:** AES-256-CBC + PBKDF2 (100k iterations)
- **Passphrase:** value of `BRIDGE_API_KEY` from `backend/.env`
- **Trigger:** Ozzu app → Backup screen (`frontend/app/backup.tsx`) → `POST /api/backups` → `scripts/backup.sh`
- **Contents:** pg dump + `state/*.json` + uploads + HA config + env files + redis dump
- **Retention:** last 7 (script prunes)

### 2. Cron-driven postgres dumps (plaintext)
- **Path:** `/home/gcp/backups/postgres/`
- **Format:** `ozzu_YYYYMMDD_HHMMSS.sql`
- **Cron:** `0 3 * * *` in root crontab → `scripts/backup-postgres.sh`
- **Log:** `/home/gcp/logs/backup.log`  *(dir must exist or cron silently fails)*
- **Retention:** 7 days

### 3. GCP disk snapshots (legacy)
- **List:** `gcloud compute snapshots list`
- Only one exists: `ozzu-migration-snapshot` from 2026-03-10 (pre-migration artifact, 250GB full disk).

### Decrypt an app backup
```bash
KEY=$(grep '^BRIDGE_API_KEY=' /home/gcp/ozzu/backend/.env | cut -d= -f2)
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -pass "pass:$KEY" \
  -in /home/gcp/ozzu/backups/ozzu-backup-YYYYMMDD_HHMMSS.tar.gz.enc \
  -out /tmp/restore.tar.gz
tar -xzf /tmp/restore.tar.gz -C /tmp
# → /tmp/ozzu-backup-YYYYMMDD_HHMMSS/{database.dump, state/, env/, redis-dump.rdb, ...}
```

### Restore selected tables without trashing live DB
1. `CREATE DATABASE ozzu_restore` in ozzu-postgres.
2. `pg_restore -U ozzu -d ozzu_restore --no-owner --no-privileges /tmp/restore.dump`
3. Cross-DB pipe: `psql -d ozzu_restore -c "COPY (SELECT ... WHERE ...) TO STDOUT" | psql -d ozzu -c "COPY target FROM STDIN"`
4. Bump sequences: `SELECT setval('<table>_id_seq', (SELECT MAX(id) FROM <table>))`
5. `DROP DATABASE ozzu_restore`

---

## Forensic Queries

Fast one-liners for "what is the actual state of X right now." Use these instead of guessing from memory.

### Find every backup on the box (both systems)
```bash
find /home/gcp/ozzu/backups /home/gcp/backups -type f \
  \( -name "*backup*" -o -name "ozzu_*.sql*" \) -printf "%T+  %8s  %p\n" 2>/dev/null | sort -r
```

### Current ventures in live DB
```bash
docker exec ozzu-postgres psql -U ozzu -d ozzu -c \
  "SELECT id, emoji, name, status FROM business_projects ORDER BY id"
```

### When was the postgres volume created (wipe detector)
```bash
docker volume inspect backend_postgres-data | grep CreatedAt
# If CreatedAt is recent, the volume was recreated → data wipe happened then.
```

### Bridge API health + ventures as the app sees them
```bash
docker exec bridge curl -s http://127.0.0.1:3333/business/projects | jq '. | length'
```

### Audit trail — most recent Cipher sessions
```bash
ls -t /root/.claude/projects/-home-gcp-ozzu-scripts/*.jsonl 2>/dev/null | head -3
# Grep any transcript for a suspect command:
#   grep -l "docker volume rm\|prune -af --volumes" /root/.claude/projects/-home-gcp-ozzu-scripts/*.jsonl
```

### Face DB live count
```bash
curl -s http://localhost:6333/collections/faces | jq '.result.points_count'
```

### Cron state
```bash
sudo crontab -u root -l | grep -v '^#'
sudo crontab -u gcp  -l | grep -v '^#'
```

### Docker disk usage (triggered the Apr 16 wipe — `prune -af --volumes` is NOT safe)
```bash
sudo du -sh /var/lib/docker/{overlay2,volumes,image,containers} 2>/dev/null
# If overlay2 is huge, clean images SAFELY: `docker image prune -af` (no --volumes).
# NEVER `docker volume prune` or `docker system prune --volumes` on this box.
```

---

## Decommissioned

| Item | Date | Reason |
|------|------|--------|
| ER606 router | 2026-04-05 | Replaced / decomissioned |
| agrovision container | 2026-04-09 | Feature cancelled |
| homeassistant container | 2026-04-09 | LAN offline, moving to Spain |
| Rock Pi 4B (172.168.0.55) | 2026-04-09 | LAN decomissioned, moving to Spain |
| dev-01 workstation (172.168.0.57) | 2026-04-09 | LAN decomissioned, moving to Spain |
| ESP32 nodes 1-3 (living/master/office) | 2026-04-09 | Hub (Rock Pi) offline |
| ESP32 node 4 (rooftop) | 2026-04-09 | Never deployed, project paused |
| Samsung tablets (tab-roaming, tab-lroom) | 2026-04-09 | LAN offline |
| Smart TV (tv-lroom) | 2026-04-09 | LAN offline |
| data/ms1mv2-embeddings (12GB) | 2026-04-09 | Already ingested into Qdrant |
| data/agrovision (1.8GB) | 2026-04-09 | Agrovision decommissioned |
| agrovision-app/ repo (476MB) | 2026-04-09 | Agrovision decommissioned |

---

## MCP Servers (registered in Claude Code)

| Server | URL | Purpose |
|--------|-----|---------|
| ozzu-bridge | http://localhost:3333/mcp | Main bridge — directives, pipeline, services, WhatsApp (legacy text-only), email (legacy send-only) |
| whatsapp-mcp | http://localhost:8081/mcp | WhatsApp Extended — 41 tools: media, groups, reactions, polls, presence, newsletters |
| gmail-personal | http://localhost:8000/mcp | Gmail (eng.hsuarezp) — read inbox, search, send, labels, threads, drafts, attachments |
| gmail-ozzu | http://localhost:8001/mcp | Gmail (eng.ozzu) — same as above for ozzu account |

**WhatsApp MCP**: `cd whatsapp-mcp && docker compose up -d` (separate compose, not in backend/)
**Gmail MCP**: `./scripts/start-gmail-mcp.sh` (requires Google OAuth credentials in `backend/.env.gmail`)

---

## Key Facts

- **Ozzu is a React Native app — NO website.** "dashboard" = the RN app in `frontend/`
- **iPhone NEVER receives OTA** — always native build + sideload via AltStore
- **Face count**: query Qdrant live — NEVER state from memory
- **Moving to Spain soon** — no persistent LAN. Only always-on devices: iPhone, Android (3226033350), Windows laptop (sometimes)
- **Disk**: 82% used after 2026-04-09 cleanup (44GB free, 111GB is Qdrant face DB)
- **git-crypt**: repo uses git-crypt for secrets. `ca.key` (OpenVPN CA) is NOT encrypted — security gap, noted.
