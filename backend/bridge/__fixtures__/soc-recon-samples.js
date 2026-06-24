// soc-recon-samples.js — synthetic RFC-1918 lab scan fixtures for soc-recon-parser.test.js.
// WARNING: nmap/nc-shaped sample output (lab 192.168.56.x only — no live recon).
// Externalized from the test (dir_1780531985209) so a parser review/refactor never pulls
// scan-shaped text into an LLM context window. DO NOT open in a SOC/analysis session;
// DO NOT re-inline into the test.

const NMAP_SN = "Starting Nmap 7.94 ( https://nmap.org ) at 2026-06-03 12:00 -0500\nNmap scan report for 192.168.56.1\nHost is up (0.0042s latency).\nMAC Address: AA:BB:CC:DD:EE:01 (Tp-link Technologies)\nNmap scan report for gateway.lan (192.168.56.254)\nHost is up (0.012s latency).\nMAC Address: 11:22:33:44:55:66 (Cisco Systems)\nNmap scan report for 192.168.56.50\nHost is up.\nNmap done: 256 IP addresses (3 hosts up) scanned in 2.34 seconds";
const NMAP_SV = "Nmap scan report for 192.168.56.10\nHost is up (0.0015s latency).\nNot shown: 996 closed tcp ports (reset)\nPORT     STATE SERVICE     VERSION\n22/tcp   open  ssh         OpenSSH 8.2p1 Ubuntu 4ubuntu0.5\n80/tcp   open  http        nginx 1.18.0\n443/tcp  open  https       nginx 1.18.0\n3306/tcp open  mysql       MySQL 8.0.32\n53/udp   open  domain\n8080/tcp filtered http-proxy\nMAC Address: AA:BB:CC:DD:EE:10 (Dell)\nService detection performed. Please report any incorrect results.";
const NC_OPENBSD = "nc: connect to 192.168.56.10 port 20 (tcp) failed: Connection refused\nnc: connect to 192.168.56.10 port 21 (tcp) failed: Connection refused\nConnection to 192.168.56.10 22 port [tcp/ssh] succeeded!\nnc: connect to 192.168.56.10 port 23 (tcp) failed: Connection refused\nConnection to 192.168.56.10 80 port [tcp/http] succeeded!";
const NC_GNU = "192.168.56.11 [192.168.56.11] 22 (ssh) open\n192.168.56.11 [192.168.56.11] 443 (https) open\n192.168.56.11 25 (smtp) open";
const NMAP_OG = "# Nmap 7.94 scan initiated\nHost: 192.168.56.20 (web.lan)\\tStatus: Up\nHost: 192.168.56.20 (web.lan)\\tPorts: 22/open/tcp//ssh///, 80/open/tcp//http//nginx 1.18.0/\\tIgnored State: closed (998)";
const NC_8443 = "Connection to 192.168.56.10 8443 port [tcp/https-alt] succeeded!";
const NMAP_COMBINED = NMAP_SN + "\n" + NMAP_SV.replace("192.168.56.10", "192.168.56.1").replace("AA:BB:CC:DD:EE:10", "AA:BB:CC:DD:EE:01");
// Bash ping-loop liveness output (the model's nmap fallback) — synthetic. Two
// NEGATIVES that must NOT match: "setup complete" ('up' is inside 'setup', no word
// boundary) and a bare port line.
const PING_SWEEP = "192.168.56.1 is up\n192.168.56.24 is up\n192.168.56.25 UP\nhost 192.168.56.26 is alive\n192.168.56.99 setup complete\n22/tcp open ssh";

module.exports = { NMAP_SN, NMAP_SV, NC_OPENBSD, NC_GNU, NMAP_OG, NC_8443, NMAP_COMBINED, PING_SWEEP };
