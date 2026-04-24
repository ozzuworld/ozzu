# OZZU VM MIGRATION — Recurring Free-Trial Rotation Protocol

**Why this exists:** Ozzu operates on rotating fresh GCP free-trial accounts (~90 days / $300 credit per account). When credits run out, we migrate to a new account. This document is the protocol + runbook + accumulated lessons so each cycle is faster and cheaper than the last.

**Canonical source of truth:** this file. If something contradicts this, fix this.

---

## Design philosophy

> **No persistent state lives inside the GCP account.** The VM is cattle, not pets. Anything important must survive account decommission.

| State | Where it lives across migrations |
|---|---|
| DNS (`ozzu.world`) | Cloudflare ✅ (outside GCP) |
| Source code | GitHub ✅ (outside GCP) |
| Qdrant face DB | **Rsynced between VMs during migration window** (both VMs alive simultaneously — no external storage needed) |
| Postgres | Same — rsync during migration |
| Secrets (`.env`, OpenVPN certs) | Rsynced during migration |
| GCP-specific resources (disk, VM, firewall, IPs) | Disposable — rebuilt every cycle |

**Zero external-storage cost.** VM-to-VM direct transfer works because both VMs have remaining credit during the migration window.

---

## Cycle roster (accumulated history)

| Cycle | Date | Source project | Target project | Total wall-clock | Manual steps | Failures |
|---|---|---|---|---|---|---|
| 1 | 2026-04-24 | project-14e4bf6c | project-80de6b4a | *in progress* | — | — |

See `migrations/<date>/metrics.json` for per-cycle details.

---

## Pre-flight — BEFORE starting a migration

**Owner: King Kazuma. Duration: ~5-10 min. Must be human (Google requires it).**

1. Create a new Google account (or reuse one that hasn't used GCP free trial)
2. Sign in at console.cloud.google.com
3. Create new GCP project
4. Activate free trial ($300 credit, 90 days) — requires payment method
5. Note the **project ID** (format: `project-XXXXXXXX-XXXX-XXXX-XXX`) — this is the only piece Cipher needs

---

## VM Spec (locked as of cycle 1)

| Resource | Value | Justification |
|---|---|---|
| Machine type | `e2-standard-4` | 4 vCPU / 16 GB — handles 1 redroid + all services + headroom. 8 vCPU busts budget. |
| Disk | 250 GB pd-balanced | 113 GB qdrant + ~70 GB misc + buffer. pd-ssd busts budget. |
| Zone | `us-central1-a` | Cheapest tier, matches historical region |
| Image | `ubuntu-2404-lts-amd64` (or `ubuntu-2204-lts` fallback) | LTS, matches current |
| Static IP | Reserve first, attach to VM | Needed for Cloudflare DNS target |

**90-day cost estimate:** ~$288. Fits $300 free credit with ~$12 safety margin.

**Right-sizing reference (from cycle 1 measurements on old VM, 6 vCPU / 22 GB):**
- CPU: load avg 15.77 with 2 redroids (way over 6 cores). With 1 redroid: ~3 cores steady, so 4 vCPU is sufficient with moderate headroom.
- RAM: 8 GB active, 5 GB cache. 16 GB new provides 2× headroom.
- Disk: 183 GB used (76%). 250 GB new = ~30% headroom.

---

## Phase 0 — Provision new VM

**Owner: King Kazuma (pastes commands in Cloud Shell). Duration: target ~3 min. Cycle 1 actual: ~20 min due to paste issues + OS Login.**

Open **Cloud Shell** (`>_` icon, top-right of console.cloud.google.com), ensure project selector shows the new project, then paste these ONE AT A TIME (Cloud Shell's web terminal mangles multi-line backslash continuations):

```bash
gcloud config set project "<PROJECT_ID>"
```

```bash
gcloud services enable compute.googleapis.com
```

```bash
gcloud compute addresses create ozzu-static-ip --region=us-central1
```

```bash
IP=$(gcloud compute addresses describe ozzu-static-ip --region=us-central1 --format='value(address)')
```

```bash
gcloud compute instances create ozzu-vm --zone=us-central1-a --machine-type=e2-standard-4 --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud --boot-disk-size=250GB --boot-disk-type=pd-balanced --address=$IP --tags=ozzu-vm,http-server,https-server --metadata=enable-oslogin=FALSE
```

**CRITICAL: `--metadata=enable-oslogin=FALSE` on create** — this avoids the OS Login trap that cost cycle 1 ~15 min. Don't skip it.

Then disable OS Login at **project level** too (belt + suspenders):

```bash
gcloud compute project-info add-metadata --metadata=enable-oslogin=FALSE
```

Grant Cipher SSH access via OS Login (easier than fighting metadata SSH keys):

```bash
gcloud compute ssh ozzu-vm --zone=us-central1-a --command="echo '<CIPHER_PUBKEY>' >> ~/.ssh/authorized_keys && whoami"
```

(Replace `<CIPHER_PUBKEY>` with `cat /root/.ssh/ozzu_migration.pub` output from the old VM.)

The `whoami` output tells Cipher the user to SSH as (typically `jokoozzu` or similar, the Google account-derived username).

**Checkpoint:** Cipher should be able to `ssh -i /root/.ssh/ozzu_migration <USER>@<STATIC_IP> "echo OK"` from the old VM. If not, stop and debug before proceeding.

---

## Phase 1 — Bootstrap new VM (Docker + tooling)

**Owner: Cipher. Duration: ~45 sec.**

From old VM, SSH in and install:

```bash
ssh -i /root/.ssh/ozzu_migration <USER>@<STATIC_IP> "bash -s" <<'REMOTE'
set -e
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -yq ca-certificates curl gnupg rsync git htop tmux jq openssl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
sudo systemctl enable --now docker
sudo apt-get install -yq docker-compose-plugin
docker --version && docker compose version
REMOTE
```

**Checkpoint:** `docker --version` and `docker compose version` both print on new VM.

---

## Phase 2 — Code + memory + cron

**Owner: Cipher. Duration: ~2 min. Transfers ~6 GB.**

Pre-create dirs + fix ownership on new VM:

```bash
ssh -i /root/.ssh/ozzu_migration <USER>@<STATIC_IP> "sudo mkdir -p /home/gcp /root/.claude && sudo chown -R $USER:$USER /home/gcp && sudo chmod 755 /root"
```

Rsync /home/gcp/ozzu (excluding heavy rebuildables):

```bash
sudo rsync -az --info=stats2 \
  --exclude='**/node_modules' \
  --exclude='data/redroid' \
  --exclude='artifacts' \
  --exclude='backend/mirror' \
  --exclude='CLAUDE.local.md' \
  --exclude='migrations' \
  -e "ssh -i /root/.ssh/ozzu_migration -o StrictHostKeyChecking=accept-new" \
  /home/gcp/ozzu/ <USER>@<STATIC_IP>:/home/gcp/ozzu/
```

Rsync Cipher memory (root-owned on dest):

```bash
sudo rsync -az --rsync-path="sudo rsync" \
  -e "ssh -i /root/.ssh/ozzu_migration -o StrictHostKeyChecking=accept-new" \
  /root/.claude/ <USER>@<STATIC_IP>:/root/.claude/
```

Crontabs:

```bash
sudo crontab -u root -l > /tmp/mig-cron-root.txt
sudo crontab -u gcp -l > /tmp/mig-cron-gcp.txt 2>/dev/null
scp -i /root/.ssh/ozzu_migration /tmp/mig-cron-*.txt <USER>@<STATIC_IP>:/tmp/
```

Ownership fixup on dest (everything under /home/gcp/ozzu was owned by root on old VM):

```bash
ssh -i /root/.ssh/ozzu_migration <USER>@<STATIC_IP> "sudo chown -R root:root /home/gcp/ozzu"
```

**Checkpoint:** `ls /home/gcp/ozzu/backend/.env` on new VM succeeds (has the real plaintext .env with BRIDGE_API_KEY etc).

---

## Phase 3 — Bulk data sync (docker volumes, LIVE)

**Owner: Cipher. Duration: ~25-40 min (most of it qdrant). Transfers ~117 GB.**

Run **while old services are still up** — takes most of the data across without downtime. A delta sync in Phase 5 catches changes.

Postgres + redis + face-models + letsencrypt (all small):

```bash
for V in backend_postgres-data backend_redis-data backend_face-models backend_letsencrypt; do
  sudo rsync -az --rsync-path="sudo rsync" \
    -e "ssh -i /root/.ssh/ozzu_migration -o StrictHostKeyChecking=accept-new" \
    /var/lib/docker/volumes/$V/_data/ \
    <USER>@<STATIC_IP>:/var/lib/docker/volumes/$V/_data/
done
```

**Note:** the new VM won't have `backend_*` volumes yet — need to pre-create them. Either:
- Run `docker compose -f backend/docker-compose.yml create` on new VM first (creates empty volumes without starting containers), OR
- `docker volume create backend_postgres-data backend_redis-data ...` manually

Qdrant (the big one, 113 GB):

```bash
sudo rsync -az --rsync-path="sudo rsync" \
  -e "ssh -i /root/.ssh/ozzu_migration -o StrictHostKeyChecking=accept-new" \
  /var/lib/docker/volumes/backend_qdrant-data/_data/ \
  <USER>@<STATIC_IP>:/var/lib/docker/volumes/backend_qdrant-data/_data/
```

**Rate:** ~50-100 MB/s over GCP internal. 113 GB = 20-40 min.

**Checkpoint:** `sudo du -sh /var/lib/docker/volumes/*/_data` on new VM shows matching sizes (within ~1% of source).

---

## Phase 4 — Freeze old VM

**Owner: Cipher (execution) + King Kazuma (approval for downtime). Duration: ~2 min.**

**⚠️ Downtime begins here. Users lose access to bridge, WhatsApp agent stops, app cannot connect.**

On old VM:

```bash
cd /home/gcp/ozzu/backend
docker compose stop
```

Take final consistent dumps:

```bash
docker exec ozzu-postgres pg_dump -U ozzu -d ozzu -Fc > /tmp/final-pg.dump
docker exec ozzu-redis redis-cli BGSAVE && sleep 2 && docker cp ozzu-redis:/data/dump.rdb /tmp/final-redis.rdb
```

Scp them over:

```bash
scp -i /root/.ssh/ozzu_migration /tmp/final-pg.dump /tmp/final-redis.rdb <USER>@<STATIC_IP>:/tmp/
```

---

## Phase 5 — Delta sync (final)

**Owner: Cipher. Duration: ~2-5 min. Transfers <2 GB of changed bytes.**

Re-run all the rsyncs from Phase 3. Rsync's delta-transfer only moves changed data:

```bash
# Same rsync commands as Phase 3 — rsync figures out what's new
```

On new VM, import the final dumps INTO the volumes we just synced (postgres dump is authoritative if qdrant/postgres data rsync missed something during freeze):

```bash
ssh -i /root/.ssh/ozzu_migration <USER>@<STATIC_IP> "docker compose -f /home/gcp/ozzu/backend/docker-compose.yml up -d postgres && sleep 5 && docker exec -i ozzu-postgres pg_restore -U ozzu -d ozzu --clean --if-exists < /tmp/final-pg.dump"
```

---

## Phase 6 — Bring up new VM

**Owner: Cipher. Duration: ~5-10 min first time (pulls all docker images).**

```bash
ssh -i /root/.ssh/ozzu_migration <USER>@<STATIC_IP> "cd /home/gcp/ozzu/backend && docker compose up -d"
```

Wait for services to come up, then verify:

```bash
ssh -i /root/.ssh/ozzu_migration <USER>@<STATIC_IP> "docker ps; curl -s http://localhost:3333/business/projects | jq '. | length'; curl -s http://localhost:6333/collections/faces | jq '.result.points_count'"
```

**Checkpoint:** venture count = 6 (or whatever matches source) AND face count = 52M+.

---

## Phase 7 — DNS cutover (Cloudflare)

**Owner: Cipher. Duration: ~1 min + DNS TTL (5 min default).**

Requires **Cloudflare API token** with `Zone.DNS:Edit` for `ozzu.world`. Get the zone ID:

```bash
curl -s -H "Authorization: Bearer $CF_TOKEN" https://api.cloudflare.com/client/v4/zones?name=ozzu.world | jq '.result[0].id'
```

Get the record ID for `home.ozzu.world`:

```bash
curl -s -H "Authorization: Bearer $CF_TOKEN" https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?name=home.ozzu.world | jq '.result[0].id'
```

Update A record to new static IP:

```bash
curl -sX PATCH -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$RECORD_ID \
  -d '{"type":"A","name":"home.ozzu.world","content":"<NEW_IP>","ttl":300,"proxied":false}'
```

**Checkpoint:** `dig home.ozzu.world +short` returns new IP within 5 min. App on phone reconnects.

---

## Phase 8 — Soak

**Owner: King Kazuma. Duration: 30-60 min.**

Check from phone:
- Open Ozzu app → ventures tab → see all 6 ventures (AMD, Coffee, Gov AI, Funding, AutoJoint, Gecko)
- Check directives list
- Send a test message to trigger a bridge round-trip

If anything's broken, **roll back** by flipping Cloudflare DNS back to old IP (old VM is still up).

---

## Phase 9 — Decommission old VM

**Owner: King Kazuma. Duration: 30 sec.**

Only after Phase 8 soak is clean for at least 30 min:

```bash
# Switch to OLD project context
gcloud config set project <OLD_PROJECT_ID>
gcloud compute instances delete ozzu-vm --zone=us-central1-a --quiet
gcloud compute addresses delete <OLD_STATIC_IP_NAME> --region=us-central1 --quiet
```

Old snapshot `ozzu-migration-snapshot` (if still around from Mar 10) can stay — cheap archive.

---

## Accumulated lessons (update after every cycle)

### Cycle 1 (2026-04-24)

1. **OS Login is enabled by default on new GCP projects in 2026.** Instance metadata SSH keys are ignored until `enable-oslogin=FALSE` is set at both **instance** and **project** level. Fix baked into Phase 0 above. **Cost of this lesson: ~15 min.**
2. **Cloud Shell's web terminal mangles multi-line backslash-continuation paste.** Give single-line commands or short variable assignments. Never multi-line `\` continuations. **Cost: ~5 min.**
3. **`delete-access-config` access-config name is `external-nat` (lowercase)**, not `"External NAT"` as older docs suggest. **Cost: ~1 min.**
4. **DO NOT PASTE PRIVATE KEYS IN CHAT.** User pasted `~/.ssh/google_compute_engine` private key — now in transcripts forever. Rotate. Use `gcloud compute ssh --command` to inject Cipher's public key to user's `authorized_keys` instead.
5. **Use `gcloud compute ssh` as the auth bootstrap path**, not metadata SSH keys. It works regardless of OS Login state because it uses Google's signed SSH flow.

---

## Metrics schema

Each cycle writes `migrations/<YYYY-MM-DD>/metrics.json`:

```json
{
  "cycle": "YYYY-MM-DD",
  "source": { "project": "...", "vm": "...", "zone": "...", "external_ip": "...", "machine_type": "...", "disk_gb": N },
  "target": { /* same shape */ },
  "phases": [
    {
      "phase": "XX-name",
      "status": "done|running|failed",
      "duration_s": N,
      "estimated_s": N,
      "variance": "+/- X%",
      "manual_steps": N,
      "failures": [ {"step": "...", "cause": "...", "resolution": "..."} ],
      "notes": "..."
    }
  ]
}
```

After each cycle:
1. Total wall-clock → append to cycle roster table above.
2. Total manual steps → lower is better (automation KPI).
3. Unique failure causes → become candidates for Phase 0 prevention in next cycle.

---

## Current cycle state (LIVE — update as phases complete)

**Cycle: 2026-04-24**

- **Directive:** `dir_1777067209669`
- **Source:** `project-14e4bf6c-437a-42ed-87d` / `ozzu-vm` / `34.135.158.92` / `e2-custom-6-22528`
- **Target:** `project-80de6b4a-6079-4dcd-a34` / `ozzu-vm` / `35.222.38.140` / `e2-standard-4`
- **SSH user on target:** `jokoozzu` (OS Login-derived)
- **SSH key:** `/root/.ssh/ozzu_migration` on old VM (private), pubkey in new VM's `/home/jokoozzu/.ssh/authorized_keys`

**Phase status:**
- [x] 0 — Provision (~20 min, 6 manual steps, 3 failures)
- [x] 0x — OS Login bypass (~15 min, 5 manual steps)
- [x] 1 — Bootstrap (45 s, 0 manual)
- [ ] 2 — Code + memory + cron (running, task ID varies)
- [ ] 3 — Bulk data sync (qdrant 113 GB + 4 small volumes)
- [ ] 4 — Freeze (BLOCKED on King Kazuma approval for downtime)
- [ ] 5 — Delta sync
- [ ] 6 — Bring up
- [ ] 7 — DNS cutover (BLOCKED on Cloudflare API token)
- [ ] 8 — Soak
- [ ] 9 — Decommission old VM (BLOCKED on King Kazuma confirmation after soak)

**If session compacts during this migration:**
1. Read this section first
2. Check `migrations/2026-04-24/metrics.json` for phase-by-phase actuals
3. SSH test: `ssh -i /root/.ssh/ozzu_migration jokoozzu@35.222.38.140 "hostname"` should work
4. Resume from the next unchecked phase above
