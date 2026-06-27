# OZZU PROJECT INVENTORY
# CHECK THIS BEFORE BUILDING ANYTHING. If it exists here, USE IT. Do NOT rebuild.
# Last updated: 2026-06-24

> **Canonical infra source:** `infra/devices.json` (machine-readable, scripts/code consume it via `scripts/lib/infra.sh` and `backend/bridge/lib/devices.js`) and `~/.claude/projects/-home-gcp-ozzu/memory/infra_registry.md` (prose context).
> All device IPs, SSH paths, VPN topology, DNS, ports, and credentials live there.
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
| browser | 3334 | Headless browser for web tasks | ✅ running |
| obico-server-web | 3334 | Obico (Spaghetti Detective) print failure detection | ✅ running |
| obico-server-ml_api | — | Obico ML inference | ✅ running |
| whatsapp-bridge | 8180 | WhatsApp MCP — whatsmeow Go bridge (41 tools) | ⚠️ check `docker ps` |
| whatsapp-mcp | 8081 | WhatsApp MCP — Python MCP server (SSE) | ⚠️ check `docker ps` |
| whatsapp-web-ui | 8090 | WhatsApp MCP — QR pairing + webhook UI | ⚠️ check `docker ps` |

WireGuard runs on the host kernel (interface `wg0`, udp/51820), not as a container. OpenVPN was decommissioned 2026-05-02 — see registry §4.

### VPN clients
**See registry §4 (WireGuard Configuration) for the authoritative peer list.** Briefly: dev-01 / kazuma-pc / orangepi5 / cat-s41 / tablet-p610 active on WG 10.9.0.0/24; ozzu-android config exists but not yet installed.

### CAT S41 (GSM Gateway + WhatsApp Agent)
| Item | Value |
|------|-------|
| Device | CAT S41 (Bullitt Group, rugged phone, always on) |
| ADB serial | S411951000454 (USB to dev-01) |
| OS | Android 8.0.0 (API 26), kernel 4.4.83+ (MediaTek) |
| Root | **Magisk v28.1** via mtkclient Kamakiri BROM exploit + `seccfg unlock` + `KEEPVERITY=true` |
| WG IP | **10.9.0.22** (WG app VpnService, tunnel name "cat") |
| WG config | `/data/data/com.wireguard.android/files/cat.conf` on device |
| LAN IP | 192.168.1.18 (FAMILIA SUAREZ WiFi) |
| ADB TCP | 5555 (set by boot script, reachable over WG at 10.9.0.22:5555) |
| Telemetry | `ozzu-telemetry-android.sh` → `POST /api/device-telemetry` (device_id `cat-s41`, 60s cycle) |
| Boot services | Magisk `service.d/02-ozzuwg-keepalive.sh` — clock fix, WG tunnel up, IP forwarding, telemetry reporter, 15s watchdog |
| Role | GSM gateway (Asterisk PBX call intelligence), WhatsApp bridge, L3 relay |
| **CRITICAL** | Kernel 4.4 silently blackholes root UDP sockets — `ozzuwg` daemon does NOT work. WG must use the app's VpnService driven by broadcast intents. No RTC battery — clock resets to 2009 on reboot; boot script fixes via NTP. |
| WhatsApp | Number 3226033350, Termux → Node.js → Baileys → WA Web. SSH via `ssh -p 8023 localhost` (reverse tunnel GCP:8023→phone:8022). WA API at GCP:8766→phone:8765. Auto-start via Termux:Boot. |

### iPhone (King Kazuma)
- Ozzu app installed via SideStore (self-service sideload, no PC needed for refresh)
- **JS changes deploy OTA** via expo-updates (~30s, no reinstall; download on launch N, apply on N+1)
- **Native changes** → iOS CI build → `artifacts/ozzu-latest.ipa` → SideStore one-tap update
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
| ota-deploy.sh | OTA JS update (iOS + Android bundle) | Exports both platforms; iPhone applies on next launch |
| ota-deploy-tv.sh | OTA JS update (TV app) | Separate runtimeVersion `tv-1.0.0` |
| cipher.sh | Launch Cipher with memory context | Loads from bridge /cipher/context |
| cipher-guard.sh | PreToolUse hook — enforce pipeline | Blocks edits without directive |
| cipher-session-save.sh | SessionEnd hook — save to postgres | |
| cipher-analyze.sh | Layer 1-3 codebase analysis | `{layer1\|layer2\|layer3\|all}` |
| backup.sh | Encrypted backup of all data | `--no-encrypt` |
| gpu-orchestrator.sh | Unattended multi-dataset GPU runner | Auto-recovery, heartbeat |
| monitor-eng.js | SOC engagement live monitor | Takes engagement ID as arg |
| heartbeat-reporter.sh | Device heartbeat to bridge | systemd timer |
| wg-state-poller.sh | WireGuard state to bridge | systemd timer |
| start-gmail-mcp.sh | Launch Gmail MCP servers (both accounts) | Requires `backend/.env.gmail` OAuth creds (DOWN) |

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

**The app is iOS-ONLY (dir_1782138428827) — no Android build/OTA/mirror for the app.**

| Change type | Command |
|-------------|---------|
| Ozzu app JS/TSX only | `merge-and-deploy` → **OTA** (~30s, no reinstall). expo-updates downloads on launch N, applies on N+1. |
| Ozzu app native change | `merge-and-deploy` → iOS CI build → `artifacts/ozzu-latest.ipa` → SideStore one-tap update |
| Ozzu app iOS rebuild (recovery) | `stage_ios` MCP tool |
| TV app OTA (JS only) | `./scripts/ota-deploy-tv.sh` (Android TV — SEPARATE from the app) |
| TV app APK (native) | CI auto-triggers on `tv/` push to main → self-installs via Device Owner |
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

### 2. Cron-driven postgres dumps (plaintext) — KNOWN BROKEN as of 2026-05-16
- **Path:** `/home/gcp/backups/postgres/` — directory does NOT exist on disk; the cron
  job has been silently failing because its log dir `/home/gcp/logs/` also doesn't exist.
- **Cron:** `0 3 * * *` in root crontab → `scripts/backup-postgres.sh`
- **App-backup cron:** `0 4 * * *` → `scripts/backup.sh` (encrypted at-rest) — also stale.
  Latest tar.gz.enc in `/home/gcp/ozzu/backups/` is from 2026-04-25.
- **Fix:** `sudo mkdir -p /home/gcp/logs /home/gcp/backups/postgres && sudo chown gcp:gcp /home/gcp/logs /home/gcp/backups/postgres`.
  Then check cron after next 03:00 run. Plaintext dumps should also be encrypted
  with the same BRIDGE_API_KEY passphrase pattern as app backups before re-enabling.

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
| ER606 router | 2026-04-05 | Replaced / decommissioned |
| agrovision container + app + scripts | 2026-04-09 | Feature cancelled. Code deleted 2026-06-24 (dir_1782317757637). |
| homeassistant container | 2026-04-09 | Colombia LAN offline |
| ESP32 positioning nodes 1-4 | 2026-04-09 | Hub offline, Colombia LAN decommissioned |
| Samsung tablets (tab-roaming, tab-lroom) | 2026-04-09 | Colombia LAN offline |
| Smart TV (tv-lroom) | 2026-04-09 | Colombia LAN offline |
| data/ms1mv2-embeddings (12GB) | 2026-04-09 | Already ingested into Qdrant |
| OpenVPN | 2026-05-02 | Replaced by WireGuard. Code deleted 2026-06-24. |
| Android app build/APK/mirror | 2026-06-22 | App is iOS-only. build-android.yml deleted 2026-06-24. |
| Distillation pipeline (oracle, finetune, grpo, sft-train) | 2026-06-24 | Abandoned — superseded by DeepSeek V4 + harness. Code + ~15GB artifacts deleted. |
| executor-agent (dev-01 HTTP shim) | 2026-06-24 | dev-01 out of offense pipeline |

**NOT decommissioned (corrected):**
- **Rock Pi 4B** — reactivated 2026-05-28 as WG bridge (10.9.0.21). Was wrongly listed as decommissioned.
- **dev-01** — out of the OFFENSE pipeline, but still a WG peer used for device pairing and SSH jump.

---

## MCP Servers (registered in Claude Code)

| Server | URL | Purpose |
|--------|-----|---------|
| ozzu-bridge | http://localhost:3333/mcp | Main bridge — directives, pipeline, SOC, services, infra |
| whatsapp-mcp | http://localhost:8081/mcp | WhatsApp Extended — 41 tools. **Containers DOWN — check `docker ps` before use.** |
| gmail-personal | http://localhost:8000/mcp | Gmail (eng.hsuarezp). **DOWN since 2026-06-03 — creds wiped, parked.** |
| gmail-ozzu | http://localhost:8001/mcp | Gmail (eng.ozzu). **DOWN since 2026-06-03 — same.** |
| codegraph | stdio (`codegraph serve --mcp`) | Code knowledge graph — AST + FTS5 + graph. Index at `.codegraph/`. |

**WhatsApp MCP**: `cd whatsapp-mcp && docker compose up -d` (separate compose, not in backend/)
**Gmail MCP**: `./scripts/start-gmail-mcp.sh` — **DOWN, requires re-setup of Google OAuth credentials**

---

## Key Facts

- **Ozzu is a React Native app — NO website.** "dashboard" = the RN app in `frontend/`
- **Ozzu app is iOS-ONLY** (dir_1782138428827). JS changes → OTA via expo-updates (~30s). Native changes → iOS CI build → IPA. No Android build/mirror.
- **Host Node = current LTS (20+)** — Metro needs Node 20+ for local/TV bundling; iOS CI uses its own cloud Node
- **Face count**: query Qdrant live — NEVER state from memory
- **Located in Spain** (EDIFICIO LAURA). Lab /24 reached via wg0 → tablet relay.
- **Disk**: check `df -h /` live — was 90% used as of 2026-06-24, ~26GB free (111GB is Qdrant face DB)
- **git-crypt**: repo uses git-crypt for secrets.

---

## Security Posture (last reviewed 2026-05-16, dir_1778953920389 + dir_1778954447412)

### SSH
- **dev-01**: `PasswordAuthentication no` enforced via `/etc/ssh/sshd_config.d/99-ozzu-key-only.conf`.
  Auth = ed25519 key (`~/.ssh/dev01_key` on bridge VM). Sudo prompts still require password
  (`$HADMIN_SUDO_PASS` from `~/.ozzu-secrets`).
- **Kazuma-PC**: `PasswordAuthentication no`, `PubkeyAuthentication yes` set in
  `C:\ProgramData\ssh\sshd_config`. Backup: `sshd_config.bak-20260516`.
- **orangepi5**: cloud-init seeded key, NOPASSWD sudo (unchanged).
- **GCP VM**: SSH restricted to IAP tunnel IPs only (`allow-iap-ssh`, tcp:22 from 35.235.240.0/20). `default-allow-ssh` was **deleted**.

### GCP firewall (updated 2026-06-24)
| Rule | Allowed | Source |
|---|---|---|
| allow-ozzu-public | tcp:80, 443 | 0.0.0.0/0 — nginx HTTPS (port 3333 removed from public) |
| allow-iap-ssh | tcp:22 | 35.235.240.0/20 — IAP tunnel only |
| wireguard | udp:51820 | 0.0.0.0/0 — VPN |
| default-allow-internal | all | 10.128.0.0/9 (GCP VPC) |
| default-allow-icmp | icmp | 0.0.0.0/0 |
- **Deleted rules**: `default-allow-ssh` (0.0.0.0/0), `default-allow-rdp` (no RDP service)
- **Removed from public**: tcp:3333 (bridge), tcp:6333 (qdrant), tcp:6969 (anisette). Reach via WG only.

### Secrets — what's where
- `/root/.ozzu-secrets` (chmod 600, root:root) — universal sudo, web admin passwords, Wyze creds, web-admin rotation key (`OZZU_WEB_ADMIN_PASS`).
- `backend/bridge/.env`, `backend/.env.gmail`, `backend/docker-compose.override.yml` — on disk, gitignored (matched by `backend/**/.env*`). **Values previously leaked in commit `5b74f1d5`; must be rotated.**
- `backend/wireguard/clients/*.conf` — WG private keys; gcp:gcp 0600; not in git.
- `private/` — gitignored as of 2026-05-16. Contains cucm creds, legal case, drone secrets.

### Known compromised → must rotate
- **6 Gmail app passwords ROTATED 2026-05-16** (hsuarezp, ozzu, floki, joko, mkazu, nat) — old values still readable in committed git history at `5b74f1d5` but no longer authenticate (King Kazuma revoked + regenerated, IMAP-verified 6/6).
- **Wyze account password ROTATED 2026-05-16** by King Kazuma.
- **`Pokemon123!` / `Onepiece123!` universal pattern** — still in use on dev-01 sudo, r605, Kazuma-PC SSH (now key-only since dir_1778954447412 — sudo prompts still use it). Web-admin services use the new `OZZU_WEB_ADMIN_PASS` value (rotate via each service UI when convenient).

---

## iOS Sideload Self-Service (dir_1778958643514, 2026-05-16)

**Goal:** iPhone refreshes its own apps without King Kazuma's PC every 7 days, and pulls new Ozzu builds OTA.

**Architecture:** SideStore on iPhone + dadoum/anisette-v3-server on GCP VM + AltStore Source manifest served by bridge.

### Server-side (already deployed)

| Component | Path | Purpose |
|---|---|---|
| `anisette` container | `127.0.0.1:6969`, nginx-proxied to `https://home.ozzu.world/anisette/` | Apple authentication for SideStore on cellular. No PII, safe to publish over TLS. |
| Bridge route | `GET /ozzu.json` → `https://home.ozzu.world/ozzu.json` | AltStore Source manifest. Reads `frontend/app.json` for version + `artifacts/ozzu-latest.ipa` for size/mtime. |
| Bridge route | `GET /ozzu-latest.ipa` → `https://home.ozzu.world/ozzu-latest.ipa` | IPA binary stream. Returns 404 if no cached IPA. |
| `jitterbugpair` + `idevicepair` | dev-01 `/usr/local/bin/` | One-time pairing-file generator. Run when iPhone is USB-connected to dev-01. |

### Phone-side — one-time bootstrap procedure

1. **Install SideStore on iPhone**:
   - On Kazuma-PC, install AltServer + AltStore as usual (last PC trip).
   - In AltStore, add source `https://provisional.sidestore.io/apps.json`.
   - Install SideStore from that source.
   - Open SideStore once on phone.

2. **Generate pairing file on dev-01**:
   - Connect iPhone to dev-01 via USB cable.
   - Tap "Trust" on iPhone when prompted.
   - On dev-01: `idevicepair pair` (or `jitterbugpair` for the alt format).
   - Output: pairing file at `/var/lib/lockdown/<UDID>.plist` (idevicepair) or `./*.mobiledevicepairing` (jitterbugpair).
   - AirDrop / email / cloud-transfer the `.mobiledevicepairing` file to the iPhone.
   - In SideStore, tap "Import pairing file" → select the file.

3. **Configure SideStore**:
   - Settings → Anisette Servers → add `https://home.ozzu.world/anisette/` → set as active.
   - Settings → Sources → add `https://home.ozzu.world/ozzu.json`.
   - Settings → enable StosVPN (it's a local-loopback VPN, won't affect cellular data).

4. **Test**:
   - Open Ozzu app source → install Ozzu (re-signs with King Kazuma Apple ID, ~30s).
   - From now on, every CI iOS build that caches to `artifacts/ozzu-latest.ipa` becomes available in SideStore for one-tap update.

### Maintenance

- **Every iOS major update**: regenerate pairing file (cable trip to dev-01). The old one stops working. Keep the generated file in `/root/.ozzu-secrets/iphone-pairing/` as backup.
- **Cert refresh**: open SideStore at least once per week so iOS BackgroundAppRefresh budget stays alive. SideStore + StosVPN re-sign all apps automatically. No PC.
- **New Ozzu build**: after CI completes + IPA caches to `artifacts/ozzu-latest.ipa`, SideStore detects the new version on next source-refresh and shows an Update button.
