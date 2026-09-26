# Ozzu Media Stack — self-hosted Netflix broker (bridge-01)

**Directive:** dir_1790443814736 · **Research:** `private/media-stack/RESEARCH-internal-netflix-2026-09-26.md` (§9 = this architecture)
**Model:** fully self-hosted broker — bridge-01 is the household's stream engine ("household debrid"). Media bytes never live outside our infra; watch history/markers/catalog stay in local postgres/Jellyfin DBs. $0/mo. Rotation, not collection: quota-based eviction, re-grab on demand (KK-ratified).

## Components (deployed at `/srv/media-stack`, dirs `/srv/media` + `/srv/downloads`)

| Service | Port | Role |
|---|---|---|
| jellyfin | 8096 | Playback server, QuickSync VAAPI (`/dev/dri`), rotation library |
| **stremio-server** | 11470 | **Broker engine**: magnet → sequential HTTP with Range seek → marker-resume without storage. Clients play `http://192.168.1.9:11470/<infoHash>/<fileIdx>` — **NO `/stream/` prefix** (this image mounts routes at root; `/stream/…` → "Cannot parse path" 500). Ops: `GET /<infoHash>/remove`, `GET /removeAll`, `GET /<infoHash>/<idx>/stats.json`. No torrent engine on any device |
| jellyseerr | 5055 | Netflix-style browse/request/approve UI |
| prowlarr + flaresolverr | 9696 / 8191 | Indexers (1337x, eztv, TPB, YTS) + CF bypass — queries never leave the house |
| sonarr / radarr | 8989 / 7878 | TV / movie automation (root `/tv`, `/movies`; qBit client; BR-DISK+Remux banned in profiles) |
| bazarr | 6767 | Subtitles |
| qbittorrent | 8080 | Download engine (ratio 1.0 → pause; categories tv/movies) |
| maintainerr | 6246 | Rotation rules UI |
| recyclarr (profile `tools`) | — | `docker compose run --rm recyclarr sync` — TRaSH profile sync (P3 polish) |

## Operations

| Task | Command |
|---|---|
| Deploy / update | `scripts/media-stack-deploy.sh` (idempotent) |
| API wiring | `scripts/media-stack-configure.sh` (idempotent, re-run after config wipe) |
| Watchdog install | `scripts/media-stack-watchdog-install.sh` |
| Quota watchdog | `/usr/local/bin/ozzu-media-watchdog`, cron `*/5` — **absolute GB quota** (HIGH_GB=90 → evict to LOW_GB=70; protects active sessions AND resumable/unfinished-marker items; stage-0 purges stale downloads >14d; emergency blind-eviction at HIGH+15G if Jellyfin is down). Log: `/var/log/ozzu-media-watchdog.log` |
| Secrets | `/root/.ozzu-secrets` → `JELLYFIN_ADMIN_PASS` (user `hadmin`), `MEDIA_QBIT_PASS` (user `admin`). Never in repo/chat |

## Runbook (from hard-won memory — `private/cipher-memory/reference_media_stack_dev01.md`)

1. **"Requests approved but nothing downloads" → `docker ps -a | grep qbit`.** If `Exited`: it was manually stopped and `restart: unless-stopped` won't revive it. `docker start qbittorrent`, then force Sonarr/Radarr to re-test the client (`POST /api/v3/downloadclient/test`).
2. **Slow 10-16h grabs** = a Remux/BR-DISK got through. Profiles are guarded by configure.sh §8; indexer seeder counts are inflated (claimed 224 → ~17 connectable). Swap an in-flight grab via Radarr queue DELETE (`removeFromClient=true&blocklist=true`) — leave exactly ONE queue item or it double-grabs.
3. **Stale queue items at 0%** ("qBittorrent is reporting missing files") = dead entries post-eviction → DELETE from queue with `removeFromClient=true`, then re-search.
4. **Don't touch logind/lid settings** — bridge-01 never-sleep hardening (2026-09-17) predates and outranks this stack.
5. **RAM**: caps set in compose (total ~4.5G of 14.8G shared with the entire Ozzu core stack). Don't remove the `mem_limit`s. Tdarr-style bulk jobs: never during work hours.
6. **Jellyfin IP**: `JELLYFIN_PublishedServerUrl` is pinned to `192.168.1.9` (home DHCP). If the lease changes, update compose + redeploy.
7. **Jellyfin is 12.x — API differs from every old runbook/guide** (verified 12.1.0, 2026-09-26):
   - **Auth**: `X-Emby-Token` / `Bearer` return **401 even for `/Auth/Keys` API keys**. ONLY `Authorization: MediaBrowser Token=<t>` works. (AuthenticateByName still needs the full `MediaBrowser Client=… DeviceId=…` header.)
   - **Startup wizard**: `POST /Startup/User` doesn't CREATE — it renames the existing first user + sets password (404 if none; `GET /Startup/User` triggers `InitializeAsync` which ensures one). Flow: GET /Startup/User → POST /Startup/User {Name,Password} → POST /Startup/Complete.
   - **Libraries**: body is `{LibraryOptions:{PathInfos:[{Path}]}}`; name/collectionType go in query params.
   - **Encoding**: `/System/Configuration/encoding` now routes via `/System/Configuration/{key}`; `EnableHardwareDecoding` is gone → `HardwareDecodingCodecs: []`.
   - OpenAPI spec is live at `GET /api-docs/openapi.json` — check it before trusting any pre-12 example.
8. **Quality-profile edits**: profiles are two-level (group entries have `quality:null` — guard against null names), and Radarr **400s if `cutoff` points at a disallowed quality** → when banning BR-DISK/Remux, relocate the cutoff (Ultra-HD: Remux-2160p → Bluray-2160p). configure.sh §8 does both.
9. **EZTV (`eztvx.to`) is Cloudflare-protected** → indexer MUST carry the `flaresolverr` tag in Prowlarr; direct fails. First FS-tested indexer add is slow (~140s cold browser) — don't retry-loop it into a 429.

## Remote access

WG mesh only: phone/laptop on WireGuard → `http://10.9.0.5:{8096,11470,...}`. **Never** port-forward these through the ISP router; the public nginx edge stays out of the media path.

## P2 (next): Ozzu-native broker client

TV/iPhone app (base: dir_1781645332787 client, APK v3 live) plays broker HTTP URLs from stremio-server; markers in ozzu-postgres; delete-after-watched as client rule; offline = plain HTTP background download. No third-party app in the flow.
