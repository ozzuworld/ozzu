# esp32-wg-bridge

ESP32 firmware that turns a cheap dev board into a **remote LAN access node**: joins a target WiFi as a station, opens a WireGuard tunnel back to the home hub, and forwards all IP traffic between the WG side and the target LAN with SNAT. Drop one inside a target network and you scan / pivot from `dev-01` as if you were physically on that LAN.

Directive: dir_1779990913039 — first working build 2026-05-28.

## Architecture

```
[dev-01 10.9.0.5]
       │ wg0
       ▼
[Bridge VM (WG hub) 35.222.38.140:51820, 10.9.0.1]
       │ wg0  (peer XcWZRSG/...: allowed-ips 10.9.0.20/32, <TARGET_LAN>/24)
       ▼
        ~ internet ~
       │
[Target WiFi router] ←-- ESP32 joins as STA, gets DHCP'd address
       │
[ESP32 10.9.0.20 on WG side, DHCP on STA side]
       │ lwIP NAPT: WG netif = LAN side, STA netif = uplink
       ▼
[Target LAN — every host on the target's subnet is now scannable from dev-01]
```

## Build

Build host is `dev-01` (has ESP-IDF v5.3.1 installed). Source lives at both:
- This repo: `tools/esp32-wg-bridge/` (canonical)
- dev-01: `/home/hadmin/esp32-wg-bridge/` (build env — kept in sync manually)

```bash
ssh dev-01
source ~/esp/esp-idf/export.sh
cd ~/esp32-wg-bridge
idf.py set-target esp32        # once per checkout
idf.py menuconfig              # "ESP32 WG Bridge" submenu — set wifi creds + WG keys
idf.py build
idf.py -p /dev/ttyUSB0 flash monitor
```

## Configuration

All secrets in `sdkconfig` (gitignored — never committed). Set via `idf.py menuconfig` under "ESP32 WG Bridge", or edit `sdkconfig` directly:

| Key | What |
|---|---|
| `CONFIG_ESP_WG_TARGET_SSID` | Target WiFi SSID (e.g. "EDIFICIO LAURA") |
| `CONFIG_ESP_WG_TARGET_PASS` | Target WiFi WPA2 passphrase |
| `CONFIG_ESP_WG_LOCAL_IP` | ESP32's WG-side IP (default 10.9.0.20) |
| `CONFIG_ESP_WG_LOCAL_NETMASK` | WG-side netmask (default 255.255.255.0) |
| `CONFIG_ESP_WG_LOCAL_PRIVKEY` | ESP32 WG private key (base64, generated once with `wg genkey`) |
| `CONFIG_ESP_WG_PEER_PUBKEY` | Bridge VM's WG public key |
| `CONFIG_ESP_WG_PEER_ENDPOINT` | Bridge VM's public IP (35.222.38.140) |
| `CONFIG_ESP_WG_PEER_PORT` | Bridge VM's WG port (51820) |
| `CONFIG_ESP_WG_KEEPALIVE` | Persistent keepalive in seconds (default 25) |

### Hub-side WG config (on the GCP bridge VM)

Add the ESP32 as a peer in `/etc/wireguard/wg0.conf`:

```ini
[Peer]
# ESP32 (esp32-wg-bridge)
PublicKey = XcWZRSG/KNP3o/kL1lz74IWc6Xw1TI7f3KF5TKURIxE=
AllowedIPs = 10.9.0.20/32, 192.168.1.0/24   # add target LAN subnet here
PersistentKeepalive = 25
```

Then surgical reload (does NOT drop other WG peers — won't kill your SSH):
```bash
sudo wg syncconf wg0 <(sudo wg-quick strip wg0)
```

**Never** `wg-quick down wg0` to reload — it drops every peer including your own SSH session if you're connected from a WG IP. See `feedback_wg_bounce_kills_ssh.md` in memory.

### dev-01 side

Add target LAN to dev-01's WG `AllowedIPs` so routes flow through the tunnel:
```bash
sudo wg set wg0 peer <HUB-PUBKEY> allowed-ips 10.9.0.0/24,192.168.1.0/24
```

## Deployment

### Physical placement

The ESP32 needs to be:
1. Within WiFi range of the target SSID (aim for -75 dBm or better)
2. Powered continuously
3. Not too obvious (we usually want stealth)

For hiding among objects — see the section on RF attenuation below.

### Power options (ranked by reliability)

| Option | Cost | Runtime | Stealth | Caveat |
|---|---|---|---|---|
| **USB wall wart + long cable** | $5 | unlimited | medium | needs an outlet near placement |
| **USB powerbank with low-current mode** | $15-25 | ~9-14h on 10000 mAh | high | MUST have a "trickle mode" — most cheap banks auto-shutoff when current drops below 50-100 mA, and ESP32 idle (~95 mA) is right at the edge. Without trickle mode it cuts out within minutes. Anker PowerCore Essential has it (double-tap the button) |
| **Bare 18650 + TP4056 + MT3608 boost** | $5-10 | ~10h on 2200 mAh | highest (smallest form factor) | needs basic soldering; no auto-shutoff problem |
| **PoE splitter (5V output)** | $10 | unlimited | high if cable already runs there | only if target has PoE switch nearby |

### Battery math for 18650

| Cell capacity | Idle (95 mA avg) | Active scan (150 mA avg) |
|---|---|---|
| 2200 mAh | ~12 h | ~9 h |
| 3500 mAh (Samsung 35E) | ~18 h | ~14 h |

Boost converter efficiency ~82% baked in.

### RF and hiding considerations

ESP32 trace antenna is in the corner OPPOSITE the USB connector — that corner needs an unobstructed path toward the target AP.

| Surroundings | Extra path loss | Verdict |
|---|---|---|
| Empty glass bottle | 5-8 dB | works fine |
| Inside cardboard / plastic case | 2-4 dB | works fine |
| Surrounded by EMPTY bottles in a cabinet | 10-15 dB | works |
| Full water/beer bottle directly between antenna and AP | 15-20 dB | marginal |
| Surrounded by FULL liquid bottles | 25-40 dB | usually fails |
| Metal foil / tin / Faraday wrap | ∞ | dead |
| Smothered in clothing/foam | 5 dB + heat trap | bad idea (overheats) |

Best stealth placement: inside an empty glass bottle laid on its side, opening pointing toward the open part of the room. Glass is nearly transparent at 2.4 GHz, the bottle conceals the board, and there's no thermal issue.

### LED stealth

Firmware drives GPIO 2 (on-board blue/orange LED on most ESP32-DevKitC clones) low at boot. The on-board RED **power LED is hardwired to 3V3** — can't be disabled in firmware, must be physically covered (electrical tape, opaque heat-shrink over that corner). The CP2102 USB-to-serial chip also has tiny TX/RX activity LEDs that blink during boot — same fix.

## Budget

Total to build one ESP32 WG bridge from scratch:

| Item | Where | Cost (USD) | Notes |
|---|---|---|---|
| ESP32-DevKitC clone (DOIT V1 or HiLetgo) | AliExpress / Amazon | $5-12 | $5 on Aliexpress with patience, $10-12 on Amazon next-day |
| USB-A to micro-USB cable, 1m | anywhere | $2-5 | most people already have one |
| Power solution (pick one) | | | |
| — USB wall wart 5V/1A | anywhere | $5 | simplest |
| — Anker PowerCore Essential 10000 mAh | Amazon | $20-25 | wireless, has trickle mode |
| — 18650 + holder + TP4056 + MT3608 + cell | AliExpress | $8-12 | smallest, no auto-shutoff |
| Glass bottle / cardboard sleeve (enclosure) | recycling bin | $0 | use what's around |
| 3D-printed case (optional) | bridge PETG print | $0.30 | ~15 min print on Ender V3 SE |
| | | | |
| **Build total (min, wall wart)** | | **~$12** | |
| **Build total (typical, wireless w/ Anker)** | | **~$32** | recommended for most uses |
| **Build total (stealth, 18650 + 3D case)** | | **~$20** | best concealment |

Recurring cost: $0. The firmware is free, the bridge VM is already paid for as part of Ozzu infra.

## Operation

### Pre-flight checklist (before physical deployment)

1. WG peer added to hub-side `wg0.conf` with correct `AllowedIPs` (10.9.0.20/32 + target LAN/24)
2. `sudo wg syncconf wg0 <(sudo wg-quick strip wg0)` to apply
3. dev-01's WG config has target LAN in its `AllowedIPs` too
4. Firmware flashed with correct SSID + password for the target
5. Bench-test: power the ESP32 on your own wifi first, confirm `ping 10.9.0.20` works from bridge

### Deploy

1. Power off ESP32, carry to target location
2. Power on, wait ~30s for: WiFi associate → DHCP → WG handshake
3. From dev-01 (or any WG peer with target LAN in AllowedIPs): `ping <target-lan-ip>` to confirm

### Status checks

```bash
# From bridge VM
sudo wg show wg0 | grep -A5 XcWZRSG    # peer should show recent handshake
ping -c 3 10.9.0.20                    # the ESP32 itself
ping -c 3 192.168.1.1                  # something on the target LAN
```

### Recover from "tunnel up but no traffic"

This is the classic stale-state symptom (bridge has wrong endpoint pinned for the peer). Surgical fix:

```bash
sudo wg set wg0 peer XcWZRSG/KNP3o/kL1lz74IWc6Xw1TI7f3KF5TKURIxE= remove
sudo wg syncconf wg0 <(sudo wg-quick strip wg0)
# Wait ~30s for ESP32 to re-initiate handshake
```

Surgical means only the ESP32 peer is reset; every other WG peer (including your own SSH from kazuma-pc) stays connected.

## Troubleshooting

| Symptom | Probable cause | Fix |
|---|---|---|
| `wg show` shows no handshake, source port keeps changing every few seconds | Powerbank brownout — ESP32 keeps resetting | Use a powerbank with trickle/low-current mode, or wall power |
| `wg show` shows no handshake, ESP32 is silent (tcpdump shows zero inbound packets) | Power cut entirely OR ESP32 not in WiFi range OR target SSID/password wrong | Re-plug to USB on dev-01, monitor serial for `wifi_sta: disconnected reason=N` and check reason code |
| Boot loops with `wifi_sta: disconnected reason=201` | AP not in range (REASON_NO_AP_FOUND) | Move closer or check SSID exact match |
| Boot loops with `wifi_sta: disconnected reason=2` | Auth fail / wrong password | Re-flash with correct CONFIG_ESP_WG_TARGET_PASS |
| Bridge shows handshake but pings fail | NAPT not enabled or wrong direction | Check `CONFIG_LWIP_IPV4_NAPT=y` in sdkconfig.defaults; NAPT MUST be on the WG netif (LAN side), not STA |
| Bridge has handshake state but ESP32 has been rebooted | Stale bridge-side state (UDP source port shifted, bridge rejects new init) | Use surgical peer reset (above), NEVER `wg-quick down wg0` (kills every peer) |
| WG handshake works but throughput is awful | ESP32 wifi is half-duplex 2.4 GHz, NAT overhead | Cap expectations: ~1-2 MB/s sustained is the ceiling |
| Build fails: `driver/gpio.h: No such file or directory` | esp_driver_gpio not in REQUIRES | `main/CMakeLists.txt` REQUIRES list must include `esp_driver_gpio` |
| Build fails: WG netif crashes on `netif_add` | esp_wireguard issue #59 (DHCPC ext_callback) | Patch already applied in vendored `components/esp_wireguard` — do NOT regenerate from upstream without re-applying |

## Limits

- **TCP, UDP, ICMP forward fine.** No raw L2 access — no ARP poisoning, no deauth, no monitor-mode sniffing. For L2 attacks use a Pi with a USB Realtek adapter instead.
- **Single WG peer (hub-only).** This ESP32 doesn't accept inbound WG handshakes from arbitrary peers; it only opens an outbound tunnel to the configured hub.
- **Throughput ceiling ~1-2 MB/s** — fine for nmap, ssh, light data exfil. Not for streaming or large dumps.
- **No fast roaming.** If the target wifi has multiple APs and the ESP32 needs to roam, it'll reconnect from scratch each time (small latency hit).
- **2.4 GHz only.** No 5 GHz support on the WROOM-32. If the target hides their IoT network on 5 GHz, this won't see it.
- **Single SSID at a time.** Change wifi = reflash. No runtime config UI.

## Files

- `main/main.c` — app entry, GPIO 2 disable, WG handshake kicker
- `main/wifi_sta.c` — STA event handler, connect/disconnect with reason logging
- `main/wg_client.c` — WireGuard tunnel setup
- `main/nat_forward.c` — lwIP NAPT enable
- `main/Kconfig.projbuild` — menuconfig schema
- `sdkconfig.defaults` — non-secret config baseline (NAPT, lwIP buffers, watchdog)
- `components/esp_wireguard/` — vendored esp_wireguard v0.9.0 + issue #59 patch (DO NOT regenerate from upstream)
