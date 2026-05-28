# esp32-wg-bridge

ESP32 (D0WD-V3) firmware that acts as a dumb L3 bridge: joins a target WiFi as STA, opens a WireGuard tunnel to the home hub, and forwards IP packets between the WG side and the target LAN with SNAT. Tools (nmap, dig, etc.) run on dev-01; this box is just plumbing.

Directive: dir_1779990913039

## Architecture

```
[dev-01 10.9.0.5]
       │ wg0
       ▼
[WG hub 35.222.38.140:51820, 10.9.0.1]
       │ wg0  (AllowedIPs for esp32 peer = 10.9.0.20/32, <TARGET_LAN>/24)
       ▼
[ESP32 10.9.0.20 (WG) + DHCP from target wifi (STA)]
       │ STA + SNAT
       ▼
[Target LAN — hosts the user wants to scan]
```

## Build

```
. ~/esp/esp-idf/export.sh
cd hardware/esp32-wg-bridge
idf.py set-target esp32
idf.py menuconfig    # set wifi creds + WG keys under "ESP32 WG Bridge"
idf.py build
idf.py -p /dev/ttyUSB0 flash monitor
```

## Configuration

All secrets live in `sdkconfig` (gitignored). Set via menuconfig:
- `ESP_WG_TARGET_SSID` — target wifi SSID
- `ESP_WG_TARGET_PASS` — target wifi password
- `ESP_WG_LOCAL_IP` — 10.9.0.20
- `ESP_WG_LOCAL_PRIVKEY` — base64 ESP32 private key
- `ESP_WG_PEER_PUBKEY` — base64 hub public key
- `ESP_WG_PEER_ENDPOINT` — 35.222.38.140
- `ESP_WG_PEER_PORT` — 51820

## Hub-side config (do this on the bridge VM)

```
sudo wg set wg0 peer <ESP32-PUBKEY> allowed-ips 10.9.0.20/32,<TARGET_LAN>/24
# persist to /etc/wireguard/wg0.conf
```

## dev-01 side

```
# Add target LAN to dev-01's WG AllowedIPs so it routes via wg0
sudo wg set wg0 peer <HUB-PUBKEY> allowed-ips 10.9.0.0/24,<TARGET_LAN>/24
```

## Limits

- TCP/UDP/ICMP all forward; no raw L2 access (no ARP poisoning, deauth, monitor mode)
- Throughput: ~1–2 MB/s sustained (ESP32 wifi limit, NAT overhead)
- Single WG peer (hub-only); ESP32 doesn't accept inbound WG handshakes from arbitrary peers
