# OZZU VM MIGRATION — Recurring Free-Trial Rotation Protocol

**Why this exists:** Ozzu operates on rotating fresh GCP free-trial accounts (~90 days / $300 credit per account). When credits run out, we migrate to a new account. This document is the protocol + runbook + accumulated lessons so each cycle is faster and cheaper than the last.

**Canonical source of truth:** this file. If something contradicts this, fix this.

---

## TL;DR — what cycle N+1 looks like

Roughly **15 min of King Kazuma's hands-on time, ~60 min of Cipher background work, ~5 min of app downtime.**

1. **King Kazuma:** create new Google account + GCP project + activate free trial (~5 min, manual UI).
2. **King Kazuma:** open Cloud Shell, paste **`scripts/migrate-00-bootstrap.sh`** with one substitution. (~1 min). Output: new VM IP + my SSH key authorized.
3. **Cipher:** runs Phase 1-7 from old VM (~50 min wall clock, of which ~5-10 min is downtime).
4. **King Kazuma:** verify app on phone (~5 min).
5. **King Kazuma:** delete old VM with one `gcloud` command (~10 sec).

---

## Design philosophy

> **No persistent state lives inside the GCP account.** The VM is cattle, not pets. Anything important must survive account decommission.

| State | Where it lives across migrations |
|---|---|
| DNS (`ozzu.world`) | Cloudflare ✅ (outside GCP) |
| Source code | GitHub ✅ (outside GCP) |
| Qdrant face DB | **Rsynced between VMs during migration window** (both alive at the same time — no external storage needed) |
| Postgres | Same — rsync during migration |
| Secrets (`.env*`, `/root/.ssh`, `/root/.config/gh`, WireGuard keys, etc.) | Rsynced during migration |
| GCP-specific resources (disk, VM, firewall, IPs) | Disposable — rebuilt every cycle |

**Zero external-storage cost.** VM-to-VM rsync works because both VMs have remaining credit during the migration window.

---

## Cycle roster (accumulated history — append a row per cycle)

| Cycle | Date | Source project | Target project | Wall-clock | Downtime | Manual steps | New failures discovered |
|---|---|---|---|---|---|---|---|
| 1 | 2026-04-24 | project-14e4bf6c | project-80de6b4a | ~3h | ~50 min* | ~25 | 9 (see below) |
| 2 | 2026-06-26 | project-80de6b4a | project-2f3f9831 | ~3.5h | **~3 min** | 2 (IAM grant + soak) | 10 (WG era, SA scopes, host units, console quirks, **recovery-daemon split-brain**, image drift, qdrant 401, no-cron, root-perms, nginx-/) |

*Downtime was inflated by qdrant slow-load + firewall-rules-not-created-at-create-time. Cycle 2 should hit the ~5-10 min target.

Per-cycle details in `migrations/<date>/metrics.json`.

---

## Pre-flight — BEFORE starting a migration

**Owner: King Kazuma. Duration: ~5-10 min. Must be human (Google requires it).**

1. Create a new Google account (or reuse one that hasn't used GCP free trial). Different from previous cycles.
2. Sign in at https://console.cloud.google.com
3. Create new GCP project (auto-generated ID is fine).
4. Activate free trial — Billing → "Activate full account" → $300 credit, 90 days, requires payment method.
5. Note the **project ID** (format: `project-XXXXXXXX-XXXX-XXXX-XXX`) — Cipher needs this and nothing else from the GCP console.

---

## VM spec (locked, do not change without measurement)

| Resource | Value | Why |
|---|---|---|
| Machine type | `e2-standard-4` | 4 vCPU / 16 GB. Handles all services — live usage is only ~5 GB RAM, so don't be tempted to bump it. e2-standard-8 ~doubles compute and busts $300/90d (credit dry in ~7 wk). |
| Disk | 250 GB pd-balanced | Holds the ~125 GB qdrant + ~15 GB repo + misc + buffer. pd-ssd busts budget. |
| Zone | `us-central1-a` | Cheapest tier ($0.134/h for e2-standard-4) + matches historical region |
| Image | `ubuntu-2404-lts-amd64` | LTS, current. Fallback: `ubuntu-2204-lts`. |
| Static IP | Reserve first, attach to VM | Keeps Cloudflare DNS target stable. |

**90-day cost:** ~$288, fits $300 free credit with ~$12 safety margin.

Redroid is decommissioned (app is iOS-only, no Android mirror).

---

## Phase 0 — Provision new VM

**Owner: King Kazuma. Duration target: ~3 min.**

Open **Cloud Shell** at https://console.cloud.google.com (top-right `>_` icon). Make sure the project selector shows your **new** project. Then paste the bootstrap script (also at `scripts/migrate-00-bootstrap.sh` in this repo):

```bash
# === Edit these two lines ===
export PROJECT_ID="project-XXXXXXXX-XXXX-XXXX-XXX"   # ← your new project ID
export CIPHER_PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB01S/kr4/rCDO3hz6OM+7XUnpJRD7UmGfpgQEsDb8cC cipher-migration"

# === Don't edit below ===
set -e
gcloud config set project "$PROJECT_ID"
gcloud services enable compute.googleapis.com

# Disable OS Login at PROJECT level (instance-level alone isn't enough)
gcloud compute project-info add-metadata --metadata=enable-oslogin=FALSE

# Reserve static IP
gcloud compute addresses create ozzu-static-ip --region=us-central1
IP=$(gcloud compute addresses describe ozzu-static-ip --region=us-central1 --format='value(address)')

# Create VM (single line — Cloud Shell mangles backslash continuations)
# --scopes=cloud-platform is REQUIRED so Cipher can run gcloud (firewall/IP/snapshots)
# from inside the VM — without it every write fails "insufficient authentication scopes".
gcloud compute instances create ozzu-vm --zone=us-central1-a --machine-type=e2-standard-4 --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud --boot-disk-size=250GB --boot-disk-type=pd-balanced --address="$IP" --tags=ozzu-vm,http-server,https-server --scopes=https://www.googleapis.com/auth/cloud-platform --metadata=enable-oslogin=FALSE

# Ports: 80/443 public + WireGuard udp:51820. (Dead OpenVPN udp:1194 dropped; qdrant 6333 /
# anisette 6969 / bridge 3333 are NOT public — nginx-proxied or closed since 2026-05-17.)
gcloud compute firewall-rules create allow-ozzu-public --allow=tcp:80,tcp:443,udp:51820 --source-ranges=0.0.0.0/0 --target-tags=ozzu-vm

# Inject Cipher's pubkey via gcloud compute ssh (works regardless of OS Login state — uses Google's signed-SSH path)
gcloud compute ssh ozzu-vm --zone=us-central1-a --command="echo '$CIPHER_PUBKEY' >> ~/.ssh/authorized_keys && echo NEW_VM_USER=\$(whoami) NEW_VM_IP=$IP"
```

**Output:** the last line prints `NEW_VM_USER=<google-derived-username> NEW_VM_IP=<static-ip>`. Paste those two values to Cipher.

**Why each piece matters (lessons from cycle 1):**

- `enable-oslogin=FALSE` at **project level** — without this, instance-level metadata is ignored and metadata SSH keys silently don't work. Cycle 1 cost: 15 min debugging.
- **Firewall ports (updated 2026-06-26):** `tcp:80,tcp:443,udp:51820`. **WireGuard is udp:51820** — the OpenVPN-era doc opened the dead `udp:1194` and forgot WG entirely, which would cut off SSH + the whole SOC path at cutover. qdrant `6333` / anisette `6969` / bridge `3333` are NOT public (nginx-proxied or closed since 2026-05-17). New GCP projects still don't auto-create http/https rules even with the tags, so this explicit rule is required. Cycle 1 cost: 20 min of "why is everything timing out".
- **`--scopes=cloud-platform` on the VM (added 2026-06-26):** without it the VM's service account is read-only and *every* `gcloud compute` write from inside the VM fails "insufficient authentication scopes" — Cipher can't manage the project autonomously. Console equivalent: "Allow full access to all Cloud APIs". If you forget it on a console-created VM, see **Autonomy / GCP access** below for the no-restart fix.
- **`gcloud compute ssh --command` to inject pubkey** — bypasses the metadata-SSH-keys vs OS-Login fight entirely. Works first try every time.
- **Single-line VM create command** — Cloud Shell's web terminal turns backslash-continuation pastes into separate commands.

**Checkpoint:** From Cipher's old VM, this should work:
```bash
ssh -i /root/.ssh/ozzu_migration <NEW_VM_USER>@<NEW_VM_IP> "echo OK"
```

---

## Autonomy / GCP access — Cipher must be able to manage the new project

For Cipher to do the project-level work (firewall, static IP, snapshots, decommission)
**autonomously**, it needs an identity with both (a) the `cloud-platform` **scope** and (b) an
IAM **role** (editor) on the new project.

**The clean way (do this):** create the VM with `--scopes=cloud-platform` (baked into Phase 0 +
the bootstrap script). The fresh project's default compute SA already has `roles/editor`, so
Cipher runs `gcloud` from inside the new VM with full power. Zero extra steps.

**If the VM was created without it** (e.g. console without "Allow full access to all Cloud APIs"):
the VM's SA is read-only and every `gcloud compute` write fails *"insufficient authentication
scopes."* Two fixes:

- **No-restart fix (used in Cycle 2):** grant the **old** VM's SA editor on the new project — one
  Cloud Shell command, no VM restart, no interruption to the running transfer. Cipher already has
  `cloud-platform` scope on the old VM, so it then drives the new project from the old VM:
  ```bash
  # In the NEW project's Cloud Shell:
  gcloud projects add-iam-policy-binding <NEW_PROJECT_ID> \
    --member="serviceAccount:<OLD_VM_SA_EMAIL>" --role="roles/editor"
  # Then from the OLD VM:  gcloud --project=<NEW_PROJECT_ID> compute firewall-rules create ...
  ```
  (`<OLD_VM_SA_EMAIL>` = the old VM's `gcloud config get-value account`, e.g.
  `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`.)
- **Restart fix (for the new VM's *own* long-term autonomy):** once it's prod, do a one-time
  `stop → set-service-account --scopes=cloud-platform → start`. Reserve the static IP first so the
  IP survives the restart. Defer to a post-cutover window — it interrupts whatever's running.

---

## Phase 1 — Bootstrap (Docker + tooling on new VM)

**Owner: Cipher. Duration: ~45 sec.**

```bash
SSH="ssh -i /root/.ssh/ozzu_migration -o StrictHostKeyChecking=accept-new <NEW_VM_USER>@<NEW_VM_IP>"

$SSH "bash -s" <<'REMOTE'
set -e
sudo apt-get update -qq
# wireguard/wireguard-tools: REQUIRED — the bridge VM is the WireGuard server (host wg0).
# The OpenVPN-era doc omitted this; WG would be dead on the new VM without it.
sudo DEBIAN_FRONTEND=noninteractive apt-get install -yq \
  ca-certificates curl gnupg wget rsync git htop tmux jq openssl \
  android-tools-adb wireguard wireguard-tools
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
sudo systemctl enable --now docker
sudo apt-get install -yq docker-compose-plugin
# gh (GitHub CLI) is NOT in Ubuntu main — bare `apt install gh` fails. Use the official repo:
sudo mkdir -p -m 755 /etc/apt/keyrings
wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
sudo apt-get update -qq && sudo apt-get install -yq gh
docker --version && docker compose version && adb --version | head -1 && gh --version | head -1 && wg --version | head -1
REMOTE
```

**`android-tools-adb` is critical** — bridge container bind-mounts `/usr/bin/adb`. Without it, docker auto-creates an empty directory at the mount source, then container start fails with "not a directory". Cycle 1 cost: 5 min.

**`gh` CLI** is mounted into bridge container too (`/usr/bin/gh`). Installed from GitHub's official apt repo (above) — it is **not** in Ubuntu main, so bare `apt install gh` fails.

**`wireguard`/`wireguard-tools`** — the bridge VM is the WireGuard **server** (host `wg0`, `wg-quick@wg0`), not just a peer. Server config (`/etc/wireguard/`) is carried in Phase 2; the tunnel is enabled in Phase 6.

---

## Phase 2 — Code + memory + cron + bridge bind-mounts

**Owner: Cipher. Duration: ~5-15 min. Transfers ~15 GB** (the repo grew — `.git` + `private/` reference clones, many small files). **Run this BACKGROUNDED** — it exceeds the 10-min foreground command limit; rsync is resumable, so a re-run just finishes the delta.

Bridge container bind-mounts a bunch of host paths. Easy to miss them — if any are absent on the new VM, container fails to start.

```bash
DEST="<NEW_VM_USER>@<NEW_VM_IP>"
SSH_OPTS="-i /root/.ssh/ozzu_migration -o StrictHostKeyChecking=accept-new"

# 2a — pre-create target dirs (some are root-owned)
ssh $SSH_OPTS $DEST "sudo mkdir -p /home/gcp /root/.claude && sudo chown -R \$USER:\$USER /home/gcp && sudo chmod 755 /root"

# 2b — main repo (excludes heavy rebuildables)
sudo rsync -az \
  --exclude='**/node_modules' \
  --exclude='data/redroid' \
  --exclude='artifacts' \
  --exclude='backend/mirror' \
  --exclude='CLAUDE.local.md' \
  --exclude='migrations' \
  -e "ssh $SSH_OPTS" \
  /home/gcp/ozzu/ $DEST:/home/gcp/ozzu/

# 2c — Cipher memory + agent state
sudo rsync -az --rsync-path="sudo rsync" -e "ssh $SSH_OPTS" \
  /root/.claude/ $DEST:/root/.claude/

# 2d — bridge bind-mount paths (DON'T SKIP — bridge container fails without these)
for p in /root/.claude.json /root/.gitconfig /root/.bashrc /root/.wandb_key; do
  sudo rsync -az --rsync-path="sudo rsync" -e "ssh $SSH_OPTS" "$p" "$DEST:$p"
done
for d in /root/.local /root/.config/gh /root/.config/vastai /root/.ssh /root/.ozzu-hb /root/.android; do
  sudo rsync -az --rsync-path="sudo rsync" -e "ssh $SSH_OPTS" "$d/" "$DEST:$d/"
done
# /root/.ozzu-secrets is a FILE (infra secrets via lib/devices.js); /tmp/osint-data must pre-exist.
# /root/.ozzu-hb = heartbeat token + bridge keys; /root/.config/vastai = GPU rental; /root/.android = ADB keys.
sudo rsync -az --rsync-path="sudo rsync" -e "ssh $SSH_OPTS" /root/.ozzu-secrets $DEST:/root/.ozzu-secrets
ssh $SSH_OPTS $DEST "mkdir -p /tmp/osint-data"

# 2g — host WireGuard SERVER config (CRITICAL — host-level, NOT in repo, NOT under /root).
# Carries server.key / server.pub / wg0.conf. Without it WG is dead on the new VM → no SSH, no SOC path.
sudo rsync -az --rsync-path="sudo rsync" -e "ssh $SSH_OPTS" /etc/wireguard/ $DEST:/etc/wireguard/

# 2h — host systemd units (NOT in repo): the infra-state monitoring timers. Their ExecStart
# scripts live in /home/gcp/ozzu/scripts (carried by 2b); the unit files themselves are host-level.
for u in ozzu-heartbeat-reporter.service ozzu-heartbeat-reporter.timer wg-state-poller.service wg-state-poller.timer; do
  sudo rsync -az --rsync-path="sudo rsync" -e "ssh $SSH_OPTS" /etc/systemd/system/$u $DEST:/etc/systemd/system/$u
done

# 2e — crontabs
sudo crontab -u root -l > /tmp/mig-cron-root.txt
sudo crontab -u gcp -l > /tmp/mig-cron-gcp.txt 2>/dev/null
scp $SSH_OPTS /tmp/mig-cron-*.txt $DEST:/tmp/

# 2f — ownership fix (everything under /home/gcp/ozzu was root-owned on old VM)
ssh $SSH_OPTS $DEST "sudo chown -R root:root /home/gcp/ozzu"
```

**Checkpoint:** On new VM, `sudo ls /root/.claude.json /root/.gitconfig /root/.local/bin/claude /root/.ozzu-secrets /usr/bin/adb /usr/bin/gh /etc/wireguard/wg0.conf /home/gcp/ozzu/backend/docker-compose.override.yml` all exist.

---

## Phase 3 — Bulk volumes (LIVE — services on old VM still running)

**Owner: Cipher. Duration: ~45-60 min (qdrant dominates). Transfers ~117 GB.**

```bash
# 3a — pre-create empty volumes on new VM
ssh $SSH_OPTS $DEST "sudo docker volume create backend_postgres-data backend_redis-data backend_face-models backend_letsencrypt backend_qdrant-data"

# 3b — small volumes first (postgres / redis / face-models / letsencrypt)
for V in backend_postgres-data backend_redis-data backend_face-models backend_letsencrypt; do
  sudo rsync -a --rsync-path="sudo rsync" -e "ssh $SSH_OPTS" \
    /var/lib/docker/volumes/$V/_data/ $DEST:/var/lib/docker/volumes/$V/_data/
done

# 3c — bulk: qdrant 113 GB. Can take 30-60 min over GCP-internal bandwidth (~30-40 MB/s sustained).
# DO NOT run other rsyncs or docker pulls in parallel — Docker Hub TLS handshake fails when network is saturated.
sudo rsync -a --rsync-path="sudo rsync" -e "ssh $SSH_OPTS" \
  /var/lib/docker/volumes/backend_qdrant-data/_data/ \
  $DEST:/var/lib/docker/volumes/backend_qdrant-data/_data/
```

**Don't pre-pull / pre-build Docker images on the new VM during qdrant rsync.** Cycle 1 cost: failed pulls + retries. Wait until Phase 3 finishes, then do Phase 5b (below).

**Checkpoint:** `sudo du -sh /var/lib/docker/volumes/*/_data` on new VM matches source within ~1% (qdrant may be slightly larger because old qdrant kept writing during rsync — gets reconciled in Phase 5).

---

## Phase 4 — Freeze old VM

**Owner: Cipher (execution) + King Kazuma (downtime go/no-go). Duration: ~30 sec.**

⚠️ **Downtime starts here.**

**CRITICAL (Cycle 2): disable the bridge's self-healing FIRST, or it fights you for ~25 min.** The bridge runs a recovery engine + event daemon that, on seeing services down, **spawns autonomous Cipher agents** (`claude -p "URGENT: nginx is DOWN, restart it"`) which `docker compose up` the stack right back — split-brain that survives every plain `docker compose stop`. A `* * * * * sync-sessions-to-db.sh` cron also restarts the bridge. The reliable freeze stops the spawners, then **removes + renames the compose files** so nothing can recreate the stack:

```bash
cd /home/gcp/ozzu/backend
# 1. stop the spawners (cron restarts the bridge; telemetry/timers poke it)
sudo crontab -r 2>/dev/null
sudo systemctl disable --now ozzu-telemetry.service ozzu-heartbeat-reporter.timer wg-state-poller.timer 2>/dev/null
# 2. remove the stack (down, not just stop)
sudo docker compose down --remove-orphans
# 3. NEUTRALIZE: rename compose so the recovery agents' `docker compose up` fails ("no configuration file")
sudo mv docker-compose.yml docker-compose.yml.MIGRATED-$(date +%F)
sudo mv docker-compose.override.yml docker-compose.override.yml.MIGRATED-$(date +%F)
# 4. kill any in-flight recovery agents — claude with -p, NOT your interactive session
ps -eww -o pid=,comm=,args= | awk '$2=="claude" && / -p /{print $1}' | xargs -r sudo kill -9
```

**Don't try `pg_dump` / `redis BGSAVE` after** — containers are gone, those commands fail; the volume rsync (Phase 3 + Phase 5 delta) is the authoritative copy.

**Rollback:** rename the compose files back + `docker compose up -d` + flip DNS. Data volumes are untouched. (You can't stop the whole old *instance* if Cipher is running on it — stopping it kills the session.)

---

## Phase 5 — Delta sync (final, fast)

**Owner: Cipher. Duration: ~10 sec to ~5 min. Transfers <2 GB.**

Re-run Phase 3's rsyncs. Source is now stopped → consistent state → rsync transfers only what changed. Cycle 1: 9 seconds for everything.

```bash
for V in backend_postgres-data backend_redis-data backend_face-models backend_letsencrypt backend_qdrant-data; do
  sudo rsync -a --delete --rsync-path="sudo rsync" -e "ssh $SSH_OPTS" \
    /var/lib/docker/volumes/$V/_data/ $DEST:/var/lib/docker/volumes/$V/_data/
done

# CRITICAL (Cycle 2): also re-sync the Claude SESSION FILES — they live in NO docker volume.
# Phase 2's copy under-transfers the big live `-home-gcp-ozzu/` folder SILENTLY (reports "ok",
# lands empty) → `claude resume` / cipher.sh on the new VM show no chat history. Sessions are
# frozen now, so this is consistent. Then VERIFY the counts match.
sudo rsync -a --rsync-path="sudo rsync" -e "ssh $SSH_OPTS" /root/.claude/projects/ $DEST:/root/.claude/projects/
echo "old sessions: $(sudo find /root/.claude/projects -name '*.jsonl' | wc -l)"
ssh $SSH_OPTS $DEST "echo new sessions: \$(sudo find /root/.claude/projects -name '*.jsonl' | wc -l)"   # MUST match
```

**Phase 5b — get the images onto the new VM (now that qdrant rsync is done).** Stock images: pull.

```bash
ssh $SSH_OPTS $DEST 'sudo bash -c "cd /home/gcp/ozzu/backend && docker compose pull postgres qdrant redis nginx anisette"'
```

**Local images (`backend-bridge`, `backend-browser`, `backend-face-recognition`): TRANSFER them, do NOT rebuild.** Cycle 2: `docker compose build` failed because `node:22-slim` had drifted to a newer Debian base and an apt package no longer resolved (exit 100). The faithful migrate-the-artifact move is `docker save | load` (~7 GB, ~3 min):

```bash
sudo docker save backend-bridge backend-browser backend-face-recognition \
  | gzip -1 | sudo ssh $SSH_OPTS $DEST 'sudo docker load'
```

---

## Phase 6 — Bring up on new VM

**Owner: Cipher. Duration: ~10 min wall-clock, ~5 min until app responsive (qdrant load is the long pole).**

### 6a — Local images

Already transferred in Phase 5b via `docker save | load` (do NOT `docker compose build` — base-image drift breaks it). Confirm present:

```bash
ssh $SSH_OPTS $DEST "sudo docker images --format '{{.Repository}}' | grep -E 'backend-(bridge|browser|face-recognition)'"
```

### 6b — Bring up

The repo is root-owned (Phase 2f chown), so the login user can't `cd` in — run as root (Cycle 2: `cd: Permission denied`):
```bash
ssh $SSH_OPTS $DEST 'sudo bash -c "cd /home/gcp/ozzu/backend && docker compose up -d postgres redis qdrant nginx bridge browser face-recognition anisette"'
```

### 6c — Restore host services (WireGuard server, crons, infra timers, lab NETMAP)

Host-level (outside Docker) — the OpenVPN-era doc never covered these. **Skipping them silently breaks WireGuard, backups, and infra-state monitoring on the new VM.**

```bash
# WireGuard server: perms, enable the tunnel, ensure IP forwarding persists.
ssh $SSH_OPTS $DEST "sudo chmod 700 /etc/wireguard && sudo chmod 600 /etc/wireguard/* && \
  sudo systemctl enable --now wg-quick@wg0 && \
  sudo sysctl -w net.ipv4.ip_forward=1 && echo net.ipv4.ip_forward=1 | sudo tee /etc/sysctl.d/99-ozzu-fwd.conf && \
  sudo wg show wg0 | head"

# Root crontab (staged in Phase 2e). Fresh Ubuntu has NO `cron` package — install it FIRST
# (Cycle 2: `crontab: command not found`). Jobs: backup, session-sync, cipher-analyze, GPU rental, @reboot lab-NETMAP.
ssh $SSH_OPTS $DEST "sudo apt-get install -yq cron && sudo systemctl enable --now cron && sudo crontab /tmp/mig-cron-root.txt && sudo crontab -l | grep -cvE '^#'"

# Infra-state systemd timers (unit files carried in Phase 2h).
ssh $SSH_OPTS $DEST "sudo systemctl daemon-reload && \
  sudo systemctl enable --now ozzu-heartbeat-reporter.timer wg-state-poller.timer && \
  systemctl is-active ozzu-heartbeat-reporter.timer wg-state-poller.timer"

# Lab NETMAP alias (10.66.1.0/24 → 192.168.1.0/24 for the SOC lab over WG). The @reboot cron runs
# it on boot, but the new VM won't reboot mid-migration — run once now (needs wg0 up first).
ssh $SSH_OPTS $DEST "sudo /home/gcp/ozzu/scripts/lab-vpn-alias-nat.sh && echo NETMAP-applied"
```

**WireGuard clients keep working without re-keying** — the server private key moved with the host, so the server pubkey is unchanged. Only each client's `Endpoint` must reach the new IP: clients using `vpn.ozzu.world` auto-follow the Phase 7 DNS cutover; any client pinned to the raw IP needs its `.conf` updated.

### 6d — Verify services

```bash
ssh $SSH_OPTS $DEST "sudo docker ps --format 'table {{.Names}}\t{{.Status}}'"
```

All 7 should be `Up` (+ anisette if SideStore auth needed). If any restart loop, `sudo docker logs <name> --tail 30` to debug.

### 6e — Wait for qdrant + bridge

Bridge waits on qdrant on first connection. Qdrant takes 5-30 min to load 113 GB / ~200 segments depending on VM disk speed. Poll:

```bash
ssh $SSH_OPTS $DEST 'K=$(sudo docker inspect qdrant --format "{{range .Config.Env}}{{println .}}{{end}}" | grep ^QDRANT__SERVICE__API_KEY= | cut -d= -f2-); until curl -sf -H "api-key: $K" http://localhost:6333/collections/faces -o /dev/null && curl -sf http://localhost:3333/health -o /dev/null; do echo "[$(date +%T)] waiting (qdrant loading)..."; sleep 30; done; echo "BOTH UP"'
```

**qdrant requires its API key** (Phase 0.1 hardening) — an unauthenticated curl returns **401**, which is NOT "down" (Cycle 2 lost ~30 min misreading this; read the resolved key from the container env, as above). Check the bridge via `/health` or `/bridge/health` — **`/` proxies to the decommissioned Home Assistant (`:8123`) and 502s** (pre-existing, not a regression). **Pre-warm tip:** start qdrant during Phase 3/5 (before the freeze) so its ~30-min load isn't downtime — it's green by cutover.

**Optional optimization:** flip DNS (Phase 7) once **bridge** alone responds — accept ~30 min of broken face features rather than ~30 min of full-app downtime. Cycle 1 chose this path.

---

## Phase 7 — DNS cutover (Cloudflare)

**Owner: Cipher. Duration: ~5 sec API + 1-5 min TTL propagation.**

Token saved at `/root/.ssh/cloudflare_token` (600 perms). Zone + record IDs:

| FQDN | Record ID | Purpose | TTL |
|---|---|---|---|
| `home.ozzu.world` | `5069d0fef3212f43446bf4c6b096d71d` | Bridge HTTPS (TV, dashboard) | 60 |
| `vpn.ozzu.world` | `80075d173aee86202ad2838a65ab1848` | Legacy (was OpenVPN, decommissioned) | 60 |
| `ozzu.world` (apex) | `9d75b460201d9f1bfee9b9fefa8fe6e0` | Marketing root | 300 |

```bash
TOKEN=$(sudo cat /root/.ssh/cloudflare_token)
ZONE=0bd328c71ae1fe4255f837389fe8fb39
NEW_IP=<new VM static IP>

# Update ALL THREE — missing one will silently break a service.
for REC in 5069d0fef3212f43446bf4c6b096d71d 80075d173aee86202ad2838a65ab1848 9d75b460201d9f1bfee9b9fefa8fe6e0; do
  curl -sX PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records/$REC" \
    -d "{\"content\":\"$NEW_IP\"}" | jq '{success, name: .result.name, content: .result.content}'
done
```

Verify propagation (authoritative, skips resolver cache):

```bash
for h in home.ozzu.world vpn.ozzu.world ozzu.world; do
  printf "%-25s " "$h"
  dig +short "$h" @brynne.ns.cloudflare.com
done
```

All three should print the new IP. Until they do, your phone may still be on the old IP.

**If Cloudflare token has changed:** generate new at cloudflare.com → My Profile → API Tokens → "Edit zone DNS" template → zone `ozzu.world` → save.

**WireGuard clients** use static IP endpoints in their `.conf` files — update the `Endpoint` in each device's WG config to the new VM IP after DNS cutover.

---

## Phase 8 — Soak

**Owner: King Kazuma. Duration: 30+ min before Phase 9.**

Verify on phone:
- Open Ozzu app → Ventures tab → all ventures load (currently 6)
- Directives tab → recent directives present
- Conversations / inbox load
- Send a test message that triggers a bridge round-trip

If anything's broken, **rollback** by flipping Cloudflare DNS back to old IP and restarting old VM compose:

```bash
# Cipher on old VM:
cd /home/gcp/ozzu/backend && sudo docker compose start

# Cloudflare flip back via the same PATCH command, with old IP
```

Old VM stays alive for at least 24h post-cutover as safety net.

---

## Phase 9 — Decommission old VM

**Owner: King Kazuma. Duration: 10 sec. Only after 30+ min clean soak.**

```bash
gcloud config set project <OLD_PROJECT_ID>
gcloud compute instances delete ozzu-vm --zone=us-central1-a --quiet
gcloud compute addresses delete <OLD_STATIC_IP_NAME> --region=us-central1 --quiet
```

Old project sits idle until free credits expire (Google auto-suspends).

---

## Accumulated lessons (append per cycle)

### Cycle 1 (2026-04-24) — 9 issues, 25 manual steps

1. **Cloud Shell mangles multi-line backslash-continuation paste.** Solution: single-line commands or short `var=` assignments. `\`-continuation will silently break the command in two. **Cost: 5 min.**

2. **OS Login enabled by default on new GCP projects in 2026.** Metadata SSH keys are ignored. Setting `enable-oslogin=FALSE` at instance level alone isn't enough — also need it at project level, plus a reset for the guest agent to re-read. **Solution baked into Phase 0:** disable at project level + use `gcloud compute ssh --command` to inject pubkey directly (uses Google signed-SSH, bypasses the whole metadata-SSH-keys path). **Cost: 15 min.**

3. **Access config name is `external-nat` (lowercase + hyphen)**, not `"External NAT"` as older docs suggest. **Cost: 1 min.**

4. **GCP firewall rules `default-allow-http`/`default-allow-https` are NOT auto-created on new projects in 2026** even with `http-server`/`https-server` tags. **Solution baked into Phase 0:** explicit `allow-ozzu-public` rule with all ports. **Cost: 20 min — the worst time-burn of the cycle because services looked up but unreachable.**

5. **Bridge container bind-mounts ~7 host paths** (`/root/.claude.json`, `.local`, `.config/gh`, `.gitconfig`, `.ssh`, `/usr/bin/adb`, `/usr/bin/gh`). Easy to miss in Phase 2 rsync. **Solution baked into Phase 2.** **Cost: 8 min.**

6. **`/usr/bin/adb` mount fails with cryptic "not a directory" error** if host doesn't have it — docker auto-creates an empty dir at mount source, then mount-as-file fails. **Solution:** `apt install android-tools-adb` in Phase 1. **Cost: 5 min.**

7. ~~OSINT pip install in bridge Dockerfile~~ — **Resolved permanently (2026-06-24).** OSINT code deleted, Dockerfile clean. No action needed in future cycles.

8. **Pre-pulling Docker images during qdrant rsync fails with TLS handshake timeouts** — qdrant saturates network bandwidth, Docker Hub registry can't respond fast enough. **Solution:** do pulls in Phase 5b (after Phase 3), not in parallel. **Cost: 3 min.**

9. **`docker compose stop` then `pg_dump`/`redis BGSAVE` fails** — containers are stopped, those commands need running containers. Volume rsync IS the authoritative consistent copy. **Solution baked into Phase 4:** skip the dumps entirely. **Cost: 3 min.**

### Cycle 1 follow-up (discovered 2026-04-26)

10. ~~OVPN client configs hardcoded the raw GCP IP~~ — **OpenVPN decommissioned 2026-05-02, replaced by WireGuard.** WG configs use static `Endpoint` IPs — update each device's `.conf` after migration. No `.ovpn` files to manage anymore.

11. **`ozzu.world` apex record drift.** Cycle 1 Phase 7 updated only `home.ozzu.world`; the apex still pointed at the old IP. **Solution:** Phase 7's PATCH loop now hits all three records, including apex.

**Soft-fail observations** (didn't break the migration, worth noting):
- `qdrant` takes 5-30 min to load 113 GB / ~200 segments. No progress logging during shard recovery — looks "stuck" but isn't (look at `docker stats qdrant` Block I/O growth).
- Bridge first-startup runs `npm install --omit=dev` which adds ~30 sec to first-boot time. Subsequent restarts are fast.

### Cycle 2 (2026-06-26) — WireGuard era + autonomy

12. **The doc predated WireGuard** (OpenVPN was replaced 2026-05-02, *after* Cycle 1). Three host-level gaps would have broken cutover: (a) the Phase 0 firewall opened the dead `udp:1194` and omitted WG's `udp:51820`; (b) `/etc/wireguard/` (server keys + `wg0.conf`) is host-level, not in the repo, and wasn't rsynced; (c) `wg-quick@wg0` enable + `ip_forward` weren't in Phase 6. All fixed in Phases 0 / 1 / 2g / 6c. **Cost if missed: total loss of SSH + the SOC path at cutover.**

13. **New-VM service-account scopes.** A console-created VM (default API access) has a **read-only** SA → every `gcloud compute` write from inside the VM fails "insufficient authentication scopes," so Cipher can't manage the project. Fix forward: `--scopes=cloud-platform` at create (Phase 0 + bootstrap). Fix in-flight with **no restart**: grant the old VM's SA `roles/editor` on the new project — see **Autonomy / GCP access**. **In Cycle 2 this would have blocked all autonomous project-level work; the IAM-grant trick recovered it with zero downtime.**

14. **Host systemd units + extra `/root` paths the doc missed.** `ozzu-heartbeat-reporter.{service,timer}` and `wg-state-poller.{service,timer}` live in `/etc/systemd/system` (not the repo) — added to Phase 2h + enabled in 6c. Also un-migrated under `/root`: `.ozzu-hb` (heartbeat token + bridge keys), `.config/vastai` (GPU rental), `.android` (ADB keys), `.wandb_key` — added to Phase 2d. **Cost if missed: infra-state monitoring, heartbeats, and ADB device auth silently dead on the new VM.**

15. **Console-creation quirks + repo growth.** GCP's console SSH-keys field uses the **key comment as the username** (the login user became `cipher-migration-20260424`). The "Allow HTTPS" checkbox opens 443 but **not** 80. The repo is now ~15 GB (`.git` + `private/` reference clones, many small files) → Phase 2 **exceeds the 10-min foreground command limit; run it backgrounded** (rsync resumes the delta on re-run).

**Cycle 2 — cutover discoveries (freeze + bring-up):**

16. **The bridge's self-healing fights the freeze — the big one (~25 min lost).** Its recovery engine + event daemon detect "services down" and **spawn autonomous Cipher agents** (`claude -p "URGENT: nginx DOWN, fix it"`) that `docker compose up` the stack right back; a `* * * * * sync-sessions` cron also restarts the bridge. Plain `docker compose stop` loses the race every time. Fix baked into Phase 4: stop the spawners (`crontab -r` + disable telemetry/timers), `compose down`, **rename the compose files** so `compose up` fails, then kill the in-flight `claude -p` agents. (You can't just stop the *instance* — Cipher is running on it.)

17. **Don't rebuild local images — transfer them.** `docker compose build` failed (`node:22-slim` base drifted, apt exit 100). `docker save | gzip | ssh load` the working `backend-*` images instead — faithful + faster (~3 min). (Phase 5b/6a.)

18. **qdrant 401 ≠ down.** qdrant requires its API key (Phase 0.1) — read the **resolved** key from the running container's env (`docker inspect`), NOT the `${QDRANT_API_KEY}` placeholder in the override. An unauthenticated health check 401s and looks "stuck loading." Lost ~30 min. (Phase 6e.)

19. **Fresh Ubuntu has no `cron`.** `crontab` → "command not found" → the whole root crontab silently fails to install. `apt install cron` first. (Phase 6c.)

20. **The repo is root-owned on the new VM** (Phase 2f chown) → the login user gets `cd: Permission denied`; every `docker compose` must run as root (`sudo bash -c "cd … && …"`). Services run as root anyway. (Phase 6b.)

21. **nginx `/` 502 is pre-existing, not a regression** — `/` proxies to the decommissioned Home Assistant (`:8123`). Health-check `/bridge/health` or `/health`, never `/`. Same for the `osint-tools DOWN` recovery email.

22. **Claude session files (`/root/.claude/projects`) silently under-transfer — and weren't in the freeze re-sync.** Two compounding gaps: (a) Phase 2's `.claude` copy reported "ok" but landed the 5,680-file `-home-gcp-ozzu/` folder (109 MB of long sessions) **empty** on the new VM — rsync drops files from a live, constantly-written tree; (b) unlike the DB volumes, `/root/.claude` had no Phase-5 delta re-sync, so anything written after the Phase-2 snapshot was stranded regardless. Symptom: `claude resume` / `cipher.sh` on the new VM show **no chat history past the snapshot** (King Kazuma noticed his pre-migration chats missing). Fix baked into Phase 5: re-sync `/root/.claude/projects` after the freeze + **verify `find … -name '*.jsonl' | wc -l` matches old vs new**. Data was never lost — the old VM held the full copy.

**DON'T:**
- Don't paste private SSH keys in chat. Use `gcloud compute ssh --command` to inject pubkeys instead. (Cycle 1: King Kazuma pasted `~/.ssh/google_compute_engine` private key into transcript — rotated post-migration.)
- Don't commit secrets to git-tracked files. Cloudflare token lives in `/root/.ssh/cloudflare_token` (600 perms), never in MIGRATION.md.

---

## Metrics schema

Each cycle writes `migrations/<YYYY-MM-DD>/metrics.json`:

```json
{
  "cycle": "YYYY-MM-DD",
  "directive_id": "dir_...",
  "source": { "project": "...", "vm": "...", "zone": "...", "external_ip": "...", "machine_type": "...", "disk_gb": N },
  "target": { /* same shape */ },
  "cloudflare": { "zone_id": "...", "record_id": "...", "token_location": "..." },
  "phases": [
    {
      "phase": "XX-name",
      "status": "done|partial|failed",
      "duration_s": N,
      "manual_steps": N,
      "bytes_transferred": N,
      "failures": [ {"step": "...", "cause": "...", "resolution": "..."} ],
      "notes": "..."
    }
  ]
}
```

After each cycle, append a row to the **Cycle roster** table above and add lessons to **Accumulated lessons** so the protocol gets sharper.

---

## Current cycle state (LIVE — update as phases complete)

**Cycle: 2026-06-26 — COMPLETE** (cutover ~16:36 UTC, ~3 min downtime. Cycle 1 2026-04-24 details in git history)

- **Directive:** `dir_1782482471456`
- **Source:** `project-80de6b4a-6079-4dcd-a34` / `ozzu-vm` / `35.222.38.140` / `e2-standard-8`
- **Target:** `project-2f3f9831-d29d-4413-ba4` / `ozzu-vm` / `34.10.215.92` (static) / `e2-standard-4` / us-central1-b
- **SSH user on target:** `cipher-migration-20260424` (GCP used the key COMMENT as the username — console metadata add)
- **SSH key:** `/root/.ssh/ozzu_migration` (private); pubkey in target's `~cipher-migration-20260424/.ssh/authorized_keys`
- **GCP access:** old-VM SA `700980343543-compute@developer.gserviceaccount.com` granted `roles/editor` on the new project (no-restart fix; the new VM's own SA is still read-only — bump post-cutover)
- **Cloudflare:** zone `0bd328c71ae1fe4255f837389fe8fb39` / records home `5069d0fef3212f43446bf4c6b096d71d`, vpn `80075d173aee86202ad2838a65ab1848`, apex `9d75b460201d9f1bfee9b9fefa8fe6e0` / token at `/root/.ssh/cloudflare_token`

**Phase status:**
- [x] 0 — Provision (King Kazuma, console; firewall + scope corrected by Cipher post-create)
- [x] 1 — Bootstrap (docker + tooling + wireguard + gh-official-repo)
- [x] 2 — Code + memory + secrets + /etc/wireguard + host systemd units + /root paths (repo 15 GB, backgrounded)
- [x] Firewall (tcp:80,443,udp:51820) + static IP — done by Cipher via the IAM grant
- [x] 3 — Bulk volumes (qdrant 117 GB transferred + verified green: 52.4M vectors)
- [x] 3.5 — Pre-warm: started qdrant + `save|load` of backend-* images (zero downtime)
- [x] 4 — Freeze old VM (had to neutralize the recovery-daemon split-brain — lesson #16)
- [x] 5 — Delta sync (postgres + redis)
- [x] 6 — Bring up + WireGuard + crons + infra timers + lab NETMAP
- [x] 7 — DNS cutover (3 records → 34.10.215.92, propagated to 1.1.1.1 + 8.8.8.8)
- [ ] 8 — Soak (King Kazuma verifying on iPhone)
- [ ] 9 — Decommission old VM (King Kazuma's call; rollback = rename compose back + up + DNS flip)

**If session compacts during a future migration:**
1. Read this section first
2. Check `migrations/<date>/metrics.json` for phase-by-phase actuals
3. SSH test from old VM should succeed
4. Resume from the next unchecked phase
