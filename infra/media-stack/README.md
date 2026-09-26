# Ozzu Media Stack — self-hosted Netflix broker (bridge-01)

**Directive:** dir_1790443814736 · **Research:** `private/media-stack/RESEARCH-internal-netflix-2026-09-26.md` (§9 = this architecture)
**Model:** fully self-hosted broker — bridge-01 is the household's stream engine ("household debrid"). Media bytes never live outside our infra; watch history/markers/catalog stay in local postgres/Jellyfin DBs. $0/mo. Rotation, not collection: quota-based eviction, re-grab on demand (KK-ratified).

## Components (deployed at `/srv/media-stack`, dirs `/srv/media` + `/srv/downloads`)

| Service | Port | Role |
|---|---|---|
| jellyfin | 8096 | Playback server, QuickSync VAAPI (`/dev/dri`), rotation library |
| **stremio-server** | 11470 | **Broker engine**: magnet → sequential HTTP with Range seek → marker-resume without storage. Clients play `http://192.168.1.9:11470/<infoHash>/<fileIdx>` — **NO `/stream/` prefix** (this image mounts routes at root; `/stream/…` → "Cannot parse path" 500). Ops: `GET /<infoHash>/remove`, `GET /removeAll`, `GET /<infoHash>/<idx>/stats.json`. No torrent engine on any device |
| jellyseerr (container name; image = **seerr v3**) | 5055 | Netflix-style browse/request/approve UI. **Already configured headlessly — no wizard.** Login: `hadmin` + Jellyfin password |
| prowlarr + flaresolverr | 9696 / 8191 | Indexers (1337x, eztv, TPB, YTS) + CF bypass — queries never leave the house |
| sonarr / radarr | 8989 / 7878 | TV / movie automation (root `/tv`, `/movies`; qBit client; BR-DISK+Remux banned in profiles) |
| bazarr | 6767 | Subtitles |
| qbittorrent | 8080 | Download engine (ratio 1.0 → pause; categories tv/movies) |
| maintainerr | 6246 | Rotation rules UI. **Already configured headlessly** (Jellyfin+Seerr+Radarr+Sonarr+qbit linked, 2 collections live). No login in v3.29 — LAN trust |
| recyclarr (profile `tools`) | — | `docker compose run --rm recyclarr sync` — TRaSH profile sync (P3 polish) |

## Operations

| Task | Command |
|---|---|
| Deploy / update | `scripts/media-stack-deploy.sh` (idempotent) |
| API wiring | `scripts/media-stack-configure.sh` (idempotent, re-run after config wipe) |
| Watchdog install | `scripts/media-stack-watchdog-install.sh` |
| Quota watchdog | `/usr/local/bin/ozzu-media-watchdog`, cron `*/5` — **absolute GB quota** (HIGH_GB=90 → evict to LOW_GB=70; protects active sessions AND resumable/unfinished-marker items; stage-0 purges stale downloads >14d; emergency blind-eviction at HIGH+15G if Jellyfin is down). Log: `/var/log/ozzu-media-watchdog.log` |
| Secrets | `/root/.ozzu-secrets` → `JELLYFIN_ADMIN_PASS` (user `hadmin`), `MEDIA_QBIT_PASS` (user `admin`). Never in repo/chat |

## Request stack — configured headlessly (2026-09-26, no manual wizards left)

**⚠️ Both request/rotation apps were RENAMED upstream and their old images are frozen — the compose file uses the new slugs:**

| Old (frozen, broken w/ Jellyfin 12) | New (in compose) | Why |
|---|---|---|
| `fallenbagel/jellyseerr` (Docker Hub **and** `ghcr.io/fallenbagel/...`, both v2.7.3, 2025-08-14) | `ghcr.io/seerr-team/seerr:latest` (v3.4.1) | v2.7.3 sends `X-Emby-Authorization` → Jellyfin 12 rejects with **400**; v3 sends `Authorization` ✓. Runs as UID 1000 → config dir needs `chown 1000:1000` |
| `ghcr.io/jorenn92/maintainerr` (v2.19.0, 2025-08) | `ghcr.io/maintainerr/maintainerr:latest` (v3.29.0) | v2.19 has **no Jellyfin support at all** (Plex-only client); Jellyfin landed via official `@jellyfin/sdk` (MediaBrowser auth → Jellyfin-12-safe). Runs as UID 1000 |

**Seerr state** (`/srv/media-stack/config/jellyseerr/settings.json`): Jellyfin `http://jellyfin:8096` (service name — Docker hairpin NAT is blocked, the LAN IP times out from containers), libraries **Movies** + **TV Shows** enabled, brand "Ozzu", locale es / region CO, Radarr+Sonarr registered (HD 720p/1080p profile, `/movies` `/tv`), admin `hadmin` logs in with the Jellyfin password. Setup API (no wizard): bootstrap `POST /api/v1/auth/jellyfin` `{username,password,hostname,port,useSsl:false,urlBase:"",serverType:2}` → enable libraries via **`GET /settings/jellyfin/library?sync=1&enable=<id1>,<id2>`** (POST body is readOnly; ⚠️ `sync=1` WITHOUT `enable=` resets all flags to false) → services `POST /settings/{radarr,sonarr}` (strict openapi validator: requires `useSsl`, `activeProfileId`, `activeProfileName`, `activeDirectory`, `isDefault`, `is4k`, sonarr also `enableSeasonFolders`) → `POST /settings/main` (minimal body — full echo 400s) → `POST /settings/initialize`.

**Maintainerr state**: Jellyfin connected (API key from `/etc/ozzu/jellyfin-token`, admin user auto-detected), Seerr + Radarr + Sonarr + qBittorrent (delete-data, fallback ratio 1.0) linked, app title "Ozzu", locale es. No auth in v3.29 (open API on LAN). Two rotation collections live (cron 04:00, 3-day grace in collection before action, `UNMONITOR_DELETE_ALL`, no list-exclusions so Seerr re-requests re-grab):
- **Vistas >30d (no favoritas)** — movies: watched ∧ last viewed >30d ∧ not favorited by hadmin
- **Series terminadas >14d (no favoritas)** — shows: watched ∧ newest episode viewed >14d ∧ not favorited (incl. parents)
- Rule sources: `maintainerr-rules/*.yaml` (import via `POST /api/rules/yaml/decode` `{yaml, mediaType:"movie"|"show"}` — YAML `mediaType: MOVIES/SHOWS`, field ids like `Jellyfin.isWatched` come from `GET /api/rules/constants`).

**Jellyfin libraries**: `Movies` (`/media/movies`) + `TV Shows` (`/media/tv`, id `767bffe4f11c93ef34b805451a696a4e`). The original "Shows" library was created without `collectionType` — see runbook #12.

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
10. **Frozen upstream slugs** — jellyseerr→`seerr-team/seerr`, maintainerr→`maintainerr/maintainerr` (details above). If a request-stack app "doesn't work with Jellyfin 12", check the image slug/age FIRST (`docker images --format '{{.CreatedAt}}'`): the old images are 13 months stale.
11. **Docker hairpin NAT is blocked on bridge-01**: containers CANNOT reach `192.168.1.9:<port>` (timeout) — always use compose service names (`jellyfin:8096`, `radarr:7878`, …) for inter-container config. Host→container via localhost works fine.
12. **Jellyfin library `collectionType` trap**: a library created without `collectionType` shows `CollectionType: null` in `/Library/MediaFolders` FOREVER — recreating with the SAME name reuses the internal item (same ItemId) and doesn't fix it (`/Library/VirtualFolders` may even display the right type while MediaFolders says null). Downstream apps (Maintainerr) filter by MediaFolders → library invisible. Fix: delete + recreate under a NEW name (that's why it's "TV Shows", not "Shows"). Then re-enable in Seerr — the library id changed.

## Remote access

WG mesh only: phone/laptop on WireGuard → `http://10.9.0.5:{8096,11470,...}`. **Never** port-forward these through the ISP router; the public nginx edge stays out of the media path.

## P2 (next): Ozzu-native broker client

TV/iPhone app (base: dir_1781645332787 client, APK v3 live) plays broker HTTP URLs from stremio-server; markers in ozzu-postgres; delete-after-watched as client rule; offline = plain HTTP background download. No third-party app in the flow.
