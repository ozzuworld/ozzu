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
| Secrets (`.env*`, OpenVPN certs, `/root/.ssh`, `/root/.config/gh`, etc.) | Rsynced during migration |
| GCP-specific resources (disk, VM, firewall, IPs) | Disposable — rebuilt every cycle |

**Zero external-storage cost.** VM-to-VM rsync works because both VMs have remaining credit during the migration window.

---

## Cycle roster (accumulated history — append a row per cycle)

| Cycle | Date | Source project | Target project | Wall-clock | Downtime | Manual steps | New failures discovered |
|---|---|---|---|---|---|---|---|
| 1 | 2026-04-24 | project-14e4bf6c | project-80de6b4a | ~3h | ~50 min* | ~25 | 9 (see below) |

*Downtime was inflated by qdrant slow-load + firewall-rules-not-created-at-create-time + bridge Dockerfile OSINT pip failure. Cycle 2 should hit the ~5-10 min target.

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
| Machine type | `e2-standard-4` | 4 vCPU / 16 GB. Handles 1 redroid + all services. e2-standard-8 busts $300/90d budget. |
| Disk | 250 GB pd-balanced | Holds 113 GB qdrant + ~70 GB misc + 30% buffer. pd-ssd busts budget. |
| Zone | `us-central1-a` | Cheapest tier ($0.134/h for e2-standard-4) + matches historical region |
| Image | `ubuntu-2404-lts-amd64` | LTS, current. Fallback: `ubuntu-2204-lts`. |
| Static IP | Reserve first, attach to VM | Keeps Cloudflare DNS target stable. |

**90-day cost:** ~$288, fits $300 free credit with ~$12 safety margin.

**One redroid only** (running). The second redroid container exists but `docker compose stop redroid01` by default. Start it only when doing social media work. Sustained 2 redroids needs e2-standard-8 = busts budget.

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
gcloud compute instances create ozzu-vm --zone=us-central1-a --machine-type=e2-standard-4 --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud --boot-disk-size=250GB --boot-disk-type=pd-balanced --address="$IP" --tags=ozzu-vm,http-server,https-server --metadata=enable-oslogin=FALSE

# Open ALL the ports Ozzu needs (single rule — match the old project)
gcloud compute firewall-rules create allow-ozzu-public --allow=tcp:80,tcp:443,tcp:3333,tcp:6333,tcp:6969,udp:1194 --source-ranges=0.0.0.0/0 --target-tags=ozzu-vm

# Inject Cipher's pubkey via gcloud compute ssh (works regardless of OS Login state — uses Google's signed-SSH path)
gcloud compute ssh ozzu-vm --zone=us-central1-a --command="echo '$CIPHER_PUBKEY' >> ~/.ssh/authorized_keys && echo NEW_VM_USER=\$(whoami) NEW_VM_IP=$IP"
```

**Output:** the last line prints `NEW_VM_USER=<google-derived-username> NEW_VM_IP=<static-ip>`. Paste those two values to Cipher.

**Why each piece matters (lessons from cycle 1):**

- `enable-oslogin=FALSE` at **project level** — without this, instance-level metadata is ignored and metadata SSH keys silently don't work. Cycle 1 cost: 15 min debugging.
- **Single firewall rule with all ports** — new GCP projects in 2026 don't auto-create `default-allow-http`/`default-allow-https` rules even with `http-server`/`https-server` tags. Cycle 1 cost: 20 min of "why is everything timing out".
- **`gcloud compute ssh --command` to inject pubkey** — bypasses the metadata-SSH-keys vs OS-Login fight entirely. Works first try every time.
- **Single-line VM create command** — Cloud Shell's web terminal turns backslash-continuation pastes into separate commands.

**Checkpoint:** From Cipher's old VM, this should work:
```bash
ssh -i /root/.ssh/ozzu_migration <NEW_VM_USER>@<NEW_VM_IP> "echo OK"
```

---

## Phase 1 — Bootstrap (Docker + tooling on new VM)

**Owner: Cipher. Duration: ~45 sec.**

```bash
SSH="ssh -i /root/.ssh/ozzu_migration -o StrictHostKeyChecking=accept-new <NEW_VM_USER>@<NEW_VM_IP>"

$SSH "bash -s" <<'REMOTE'
set -e
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -yq \
  ca-certificates curl gnupg rsync git htop tmux jq openssl \
  android-tools-adb gh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
sudo systemctl enable --now docker
sudo apt-get install -yq docker-compose-plugin
docker --version && docker compose version && adb --version | head -1 && gh --version | head -1
REMOTE
```

**`android-tools-adb` is critical** — bridge container bind-mounts `/usr/bin/adb`. Without it, docker auto-creates an empty directory at the mount source, then container start fails with "not a directory". Cycle 1 cost: 5 min.

**`gh` CLI** is mounted into bridge container too (`/usr/bin/gh`).

---

## Phase 2 — Code + memory + cron + bridge bind-mounts

**Owner: Cipher. Duration: ~3 min. Transfers ~7 GB.**

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
for p in /root/.claude.json /root/.gitconfig /root/.bashrc; do
  sudo rsync -az --rsync-path="sudo rsync" -e "ssh $SSH_OPTS" "$p" "$DEST:$p"
done
for d in /root/.local /root/.config/gh /root/.ssh; do
  sudo rsync -az --rsync-path="sudo rsync" -e "ssh $SSH_OPTS" "$d/" "$DEST:$d/"
done

# 2e — crontabs
sudo crontab -u root -l > /tmp/mig-cron-root.txt
sudo crontab -u gcp -l > /tmp/mig-cron-gcp.txt 2>/dev/null
scp $SSH_OPTS /tmp/mig-cron-*.txt $DEST:/tmp/

# 2f — ownership fix (everything under /home/gcp/ozzu was root-owned on old VM)
ssh $SSH_OPTS $DEST "sudo chown -R root:root /home/gcp/ozzu"
```

**Checkpoint:** On new VM, `sudo ls /root/.claude.json /root/.gitconfig /root/.local/bin/claude /usr/bin/adb /usr/bin/gh` all exist.

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

```bash
cd /home/gcp/ozzu/backend
sudo docker compose stop
```

**That's it. Don't try `pg_dump` or `redis BGSAVE` after stop** — containers are stopped, those commands fail. The volume rsync from Phase 3 + Phase 5 delta is the authoritative copy. Cycle 1 wasted ~3 min trying to dump on stopped containers.

---

## Phase 5 — Delta sync (final, fast)

**Owner: Cipher. Duration: ~10 sec to ~5 min. Transfers <2 GB.**

Re-run Phase 3's rsyncs. Source is now stopped → consistent state → rsync transfers only what changed. Cycle 1: 9 seconds for everything.

```bash
for V in backend_postgres-data backend_redis-data backend_face-models backend_letsencrypt backend_qdrant-data; do
  sudo rsync -a --delete --rsync-path="sudo rsync" -e "ssh $SSH_OPTS" \
    /var/lib/docker/volumes/$V/_data/ $DEST:/var/lib/docker/volumes/$V/_data/
done
```

**Phase 5b — pull/build images on new VM (now that qdrant rsync is done).** This is also during downtime; fits in parallel with Phase 6 prep:

```bash
ssh $SSH_OPTS $DEST "cd /home/gcp/ozzu/backend && sudo docker compose pull postgres qdrant redis nginx"
```

For local-built images (`backend-bridge` etc.), see Phase 6 below — they require a Dockerfile patch first.

---

## Phase 6 — Bring up on new VM

**Owner: Cipher. Duration: ~10 min wall-clock, ~5 min until app responsive (qdrant load is the long pole).**

### 6a — Patch bridge Dockerfile (drop OSINT pip install)

OSINT Python tools (maigret/holehe/h8mail) are now run on dev-01 (Kali x86), not bundled into the bridge image. The pip install of those tools fails inside Ubuntu base image (pycairo build needs C compiler not in image, or version conflicts). **Drop it.**

```bash
ssh $SSH_OPTS $DEST "sudo sed -i.bak '10,12s|^|#OSINT-MOVED-TO-DEV01# |' /home/gcp/ozzu/backend/bridge/Dockerfile"
```

Verify the comment landed on lines 10-12 (the `RUN python3 -m venv /opt/osint-venv` block):

```bash
ssh $SSH_OPTS $DEST "grep -n OSINT-MOVED-TO-DEV01 /home/gcp/ozzu/backend/bridge/Dockerfile"
```

### 6b — Build local images

```bash
ssh $SSH_OPTS $DEST "cd /home/gcp/ozzu/backend && sudo docker compose build --parallel bridge browser face-recognition openvpn"
```

Skip `osint-tools` — its Dockerfile has the same broken pip install and we don't need it on the new VM.

### 6c — Bring up — explicit service list (excludes osint-tools)

```bash
ssh $SSH_OPTS $DEST "cd /home/gcp/ozzu/backend && sudo docker compose up -d postgres redis qdrant nginx bridge browser face-recognition openvpn"
```

### 6d — Verify services

```bash
ssh $SSH_OPTS $DEST "sudo docker ps --format 'table {{.Names}}\t{{.Status}}'"
```

All 8 should be `Up`. If any restart loop, `sudo docker logs <name> --tail 30` to debug.

### 6e — Wait for qdrant + bridge

Bridge waits on qdrant on first connection. Qdrant takes 5-30 min to load 113 GB / ~200 segments depending on VM disk speed. Poll:

```bash
ssh $SSH_OPTS $DEST 'until curl -sf http://localhost:6333/collections/faces -o /dev/null && curl -sf http://localhost:3333/business/projects -o /dev/null; do echo "[$(date +%T)] waiting..."; sleep 30; done; echo "BOTH UP"'
```

**Optional optimization:** flip DNS (Phase 7) once **bridge** alone responds — accept ~30 min of broken face features rather than ~30 min of full-app downtime. Cycle 1 chose this path.

---

## Phase 7 — DNS cutover (Cloudflare)

**Owner: Cipher. Duration: ~5 sec API + 1-5 min TTL propagation.**

Token saved at `/root/.ssh/cloudflare_token` (600 perms). Zone + record IDs:

| FQDN | Record ID | Purpose | TTL |
|---|---|---|---|
| `home.ozzu.world` | `5069d0fef3212f43446bf4c6b096d71d` | Bridge HTTPS (TV, dashboard) | 60 |
| `vpn.ozzu.world` | `80075d173aee86202ad2838a65ab1848` | OpenVPN — `.ovpn` files reference this | 60 |
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

All three should print the new IP. Until they do, your phone may still be on old IP and OVPN clients (laptop, dev-01, ozzu-android) won't reconnect.

**If Cloudflare token has changed:** generate new at cloudflare.com → My Profile → API Tokens → "Edit zone DNS" template → zone `ozzu.world` → save.

### VPN configs use FQDN — do NOT regenerate per cycle

`.ovpn` files in `artifacts/` reference `remote vpn.ozzu.world 1194 udp`, not the raw IP. After the DNS PATCH above, all clients reconnect on their own. **No client reissue is required during a normal migration cycle.**

If a client cert/key is ever rotated (security event), regenerate that one file with `scripts/regen-ovpn.sh <client>` and ship the new `.ovpn` to the device once.

**Pre-flight check before cycle ships:**
```bash
grep '^remote ' artifacts/*.ovpn   # should be vpn.ozzu.world on every line
```
If anything else appears, fix the `.ovpn` before cutover or that client will dial a dead IP.

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

7. **`bridge` Dockerfile contains a doomed OSINT pip install** (`maigret holehe h8mail` — pycairo C-compile fails). Same for `osint-tools` Dockerfile. Workload moved to dev-01 anyway. **Solution baked into Phase 6a:** sed-comment lines 10-12 in `backend/bridge/Dockerfile`; skip `osint-tools` service entirely. **Cost: 10 min.**

8. **Pre-pulling Docker images during qdrant rsync fails with TLS handshake timeouts** — qdrant saturates network bandwidth, Docker Hub registry can't respond fast enough. **Solution:** do pulls in Phase 5b (after Phase 3), not in parallel. **Cost: 3 min.**

9. **`docker compose stop` then `pg_dump`/`redis BGSAVE` fails** — containers are stopped, those commands need running containers. Volume rsync IS the authoritative consistent copy. **Solution baked into Phase 4:** skip the dumps entirely. **Cost: 3 min.**

### Cycle 1 follow-up (discovered 2026-04-26)

10. **OVPN client configs hardcoded the raw GCP IP, not an FQDN.** Two days post-cycle every VPN client (laptop, phone, dev-01) was looping on "connecting" — they were dialing 34.135.158.92, which now belongs to a different GCP customer. Root cause: `home.ozzu.world` got updated by Phase 7 but `.ovpn` files never used it. **Solution baked into Phase 7 (this commit):** `vpn.ozzu.world` added as separate Cloudflare record (TTL 60); `.ovpn` files regenerated via `scripts/regen-ovpn.sh` to use `remote vpn.ozzu.world 1194 udp`; phase doc adds explicit "PATCH all three records" loop and a pre-flight grep over `artifacts/*.ovpn`. **Cost: 1.5 days of nobody being able to reach dev-01 over VPN, +30 min to fix.**

11. **`ozzu.world` apex record drift.** Cycle 1 Phase 7 updated only `home.ozzu.world`; the apex still pointed at the old IP. No one hit it (apex isn't load-bearing for the app), but it was a latent bug. **Solution:** Phase 7's PATCH loop now hits all three records, including apex.

**Soft-fail observations** (didn't break the migration, worth noting):
- `qdrant` takes 5-30 min to load 113 GB / ~200 segments. No progress logging during shard recovery — looks "stuck" but isn't (look at `docker stats qdrant` Block I/O growth).
- Bridge first-startup runs `npm install --omit=dev` which adds ~30 sec to first-boot time. Subsequent restarts are fast.

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

**Cycle: 2026-04-24 — COMPLETE**

- **Directive:** `dir_1777067209669`
- **Source:** `project-14e4bf6c-437a-42ed-87d` / `ozzu-vm` / `34.135.158.92` / `e2-custom-6-22528`
- **Target:** `project-80de6b4a-6079-4dcd-a34` / `ozzu-vm` / `35.222.38.140` / `e2-standard-4`
- **SSH user on target:** `jokoozzu` (OS Login-derived)
- **SSH key:** `/root/.ssh/ozzu_migration` (private), pubkey in new VM's `/home/jokoozzu/.ssh/authorized_keys`
- **Cloudflare:** zone `0bd328c71ae1fe4255f837389fe8fb39` / record `5069d0fef3212f43446bf4c6b096d71d` / token at `/root/.ssh/cloudflare_token`

**Phase status (final):**
- [x] 0 — Provision (~20 min, 6 manual steps, 3 failures — fixes baked into Phase 0 above)
- [x] 1 — Bootstrap (45 s)
- [x] 2 — Code + memory (144 s)
- [x] 2b — Missing root files (375 s, parallel with Phase 3 — discovered mid-migration)
- [x] 3 — Bulk volumes (~50 min, qdrant dominated)
- [x] 4 — Freeze (20 s)
- [x] 5 — Delta sync (9 s)
- [x] 6 — Bring up (~30 min — qdrant slow + Dockerfile patch + missing adb)
- [x] 7 — DNS cutover (5 s + 5 min TTL)
- [ ] 8 — Soak (in progress — King Kazuma verifying on phone)
- [ ] 9 — Decommission old VM (King Kazuma's call after 30+ min soak)

**Open items:**
- Qdrant face-collection load may still be running — verify with `curl http://localhost:6333/collections/faces` (status `green` = ready).
- `osint-tools` container is not deployed; OSINT workload runs on dev-01.

**If session compacts during a future migration:**
1. Read this section first
2. Check `migrations/<date>/metrics.json` for phase-by-phase actuals
3. SSH test from old VM should succeed
4. Resume from the next unchecked phase
