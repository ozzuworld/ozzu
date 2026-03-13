# OZZU PROJECT INVENTORY
# CHECK THIS BEFORE BUILDING ANYTHING. If it exists here, USE IT. Do NOT rebuild.

## Scripts (/home/gcp/ozzu/scripts/)

| Script | Purpose | Key flags/notes |
|--------|---------|-----------------|
| **embed-pipeline-v2.py** | Face embedding pipeline — 85K/min on 3090 | `--local-qdrant` (MANDATORY), `--all`, `--benchmark`, `--no-sync` |
| **setup-vast-gpu.sh** | One-shot vast.ai GPU instance setup | `<host> <port> [--start]` — MUST include --local-qdrant |
| embed-glint360k.py | Glint360K dataset (17.1M faces) | `[start_shard] [end_shard]` |
| embed-hf-dataset.py | Any HuggingFace WebDataset → Qdrant | `<dataset_name> [start] [end]` |
| embed-parquet-dataset.py | Parquet format datasets → Qdrant | |
| face-clusterer.py | Identity clustering (Union-Find) | `--incremental`, `--stats` |
| deploy.sh | Android APK deploy from CI | `[device-names]`, `--local` |
| ota-deploy.sh | OTA JS update (Android ONLY) | `--restart` |
| deploy-ios.sh | iOS IPA via dev-01 + AltServer | `--local /path`, `--check` |
| cipher.sh | Launch Cipher with memory context | Loads from bridge /cipher/context |
| cipher-guard.sh | PreToolUse hook — enforce pipeline | Blocks edits without directive |
| cipher-session-save.sh | SessionEnd hook — save to postgres | |
| inject-last-conversation.sh | UserPromptSubmit hook — inject context | Pre-flight checklist on first msg |
| backup.sh | Encrypted backup of all data | `--no-encrypt` |
| adb-discover.sh | Find ADB wireless debug ports | Scans 30000-50000 |
| gpu-orchestrator.sh | Unattended multi-dataset GPU runner | Auto-recovery, heartbeat |

## PROVEN OPTIMIZATIONS — DO NOT REDO

### embed-pipeline-v2.py (took 1 week to build and tune)
1. **Local Qdrant** (`--local-qdrant`): 15K → 85K/min. Downloads Qdrant binary, runs on localhost. NEVER launch without it.
2. **Shared memory decode**: Zero pickle IPC. Workers write to pre-allocated shared numpy arrays.
3. **IOBinding**: Pre-allocated GPU memory, avoids CPU↔GPU copies. +4% throughput.
4. **Double-buffer**: Extract+decode next shard while GPU processes current. +12%.
5. **QDRANT_BATCH=2000**: NOT 5000. 5000 exceeds 32MB JSON payload limit.
6. **GPU_BATCH=512**: Saturates 3090 cores.

### setup-vast-gpu.sh
1. **CUDA 12/13 compat**: Installs libcufft-12-8, libcurand-12-8, etc. for onnxruntime.
2. **tmux required**: nohup doesn't survive vast.ai SSH disconnect.
3. **PCIe 24+ preferred**: PCIe Gen 1 = 4 GB/s = severe bottleneck.

## Services (Docker, network_mode: host)

| Service | Port | Purpose |
|---------|------|---------|
| bridge | 3333 | Command bridge (API, directives, Cipher) |
| postgres | 5432 | Main DB (memories, conversations, directives) |
| redis | 6379 | Session cache, ephemeral state |
| qdrant | 6333 | Vector DB (48M+ faces) |
| nginx | 80/443 | SSL proxy (home.ozzu.world) |
| openvpn | 1194 | VPN tunnel to home LAN |
| anisette | 6969 | Apple auth for iOS sideloading |

## Devices

| Name | IP | Type |
|------|-----|------|
| tab-roaming | 172.168.0.53 | Samsung tablet |
| tab-lroom | 172.168.0.57 | Samsung tablet |
| tv-lroom | 172.168.0.56 | 4K Smart TV |
| dev-01 | 172.168.0.61 | Ubuntu Server (SSH: hadmin) |
| iPhone | via dev-01 USB | iOS (AltStore sideload) |

## Facts (verified)
- Face count: query `curl -s http://localhost:6333/collections/faces` — NEVER guess
- Completed datasets: Glint360K, MS1MV3, WebFace4M, VGGFace2
- iPhone NEVER receives OTA — always native build + sideload
- App is React Native — NO website. "dashboard" = the RN app
- smartDeploy auto-triggers builds after merge — NEVER manually trigger
