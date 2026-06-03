// soc-recon-parser.test.js — runnable with `node soc-recon-parser.test.js`.
// No test framework: plain assertions, exits non-zero on first failure.
//
// All fixture data below is SYNTHETIC (made-up RFC-5737/RFC-1918 hosts, common
// ports) authored for this test — NOT output from any live engagement. The whole
// point of the parser is to keep real scan dumps out of context; the test honors
// that by never embedding real recon.
"use strict";

const assert = require("assert");
const { parseNmap, parseNcSweep, parseReconOutput } = require("./soc-recon-parser");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── nmap -sn host discovery ───────────────────────────────────────────────────
const NMAP_SN = `Starting Nmap 7.94 ( https://nmap.org ) at 2026-06-03 12:00 -0500
Nmap scan report for 192.168.56.1
Host is up (0.0042s latency).
MAC Address: AA:BB:CC:DD:EE:01 (Tp-link Technologies)
Nmap scan report for gateway.lan (192.168.56.254)
Host is up (0.012s latency).
MAC Address: 11:22:33:44:55:66 (Cisco Systems)
Nmap scan report for 192.168.56.50
Host is up.
Nmap done: 256 IP addresses (3 hosts up) scanned in 2.34 seconds`;

check("parseNmap -sn: 3 hosts, MAC+vendor, hostname-in-parens", () => {
  const r = parseNmap(NMAP_SN);
  assert.strictEqual(r.length, 3, "should find 3 hosts");
  const h1 = r.find((x) => x.ip === "192.168.56.1");
  assert.ok(h1, "host .1 present");
  assert.strictEqual(h1.status, "up");
  assert.strictEqual(h1.mac, "AA:BB:CC:DD:EE:01");
  assert.strictEqual(h1.vendor, "Tp-link Technologies");
  const gw = r.find((x) => x.ip === "192.168.56.254");
  assert.strictEqual(gw.hostname, "gateway.lan");
  assert.strictEqual(gw.vendor, "Cisco Systems");
  const h50 = r.find((x) => x.ip === "192.168.56.50");
  assert.strictEqual(h50.status, "up");
  assert.strictEqual(h50.mac, null);
});

// ── nmap -sV port + service + version ──────────────────────────────────────────
const NMAP_SV = `Nmap scan report for 192.168.56.10
Host is up (0.0015s latency).
Not shown: 996 closed tcp ports (reset)
PORT     STATE SERVICE     VERSION
22/tcp   open  ssh         OpenSSH 8.2p1 Ubuntu 4ubuntu0.5
80/tcp   open  http        nginx 1.18.0
443/tcp  open  https       nginx 1.18.0
3306/tcp open  mysql       MySQL 8.0.32
53/udp   open  domain
8080/tcp filtered http-proxy
MAC Address: AA:BB:CC:DD:EE:10 (Dell)
Service detection performed. Please report any incorrect results.`;

check("parseNmap -sV: ports, states, services, versions", () => {
  const r = parseNmap(NMAP_SV);
  assert.strictEqual(r.length, 1);
  const h = r[0];
  assert.strictEqual(h.ip, "192.168.56.10");
  assert.strictEqual(h.mac, "AA:BB:CC:DD:EE:10");
  assert.strictEqual(h.vendor, "Dell");
  assert.strictEqual(h.ports.length, 6, "6 listed ports");
  const ssh = h.ports.find((p) => p.port === 22);
  assert.strictEqual(ssh.proto, "tcp");
  assert.strictEqual(ssh.state, "open");
  assert.strictEqual(ssh.service, "ssh");
  assert.strictEqual(ssh.version, "OpenSSH 8.2p1 Ubuntu 4ubuntu0.5");
  const dns = h.ports.find((p) => p.port === 53);
  assert.strictEqual(dns.proto, "udp");
  assert.strictEqual(dns.version, null, "no-version port → null");
  const proxy = h.ports.find((p) => p.port === 8080);
  assert.strictEqual(proxy.state, "filtered");
  // ports sorted ascending
  assert.deepStrictEqual(h.ports.map((p) => p.port), [22, 53, 80, 443, 3306, 8080]);
});

// ── combined `nmap -sn && nmap -p- -sV` → same IP twice, must merge ────────────
const NMAP_COMBINED = NMAP_SN + "\n" + NMAP_SV.replace("192.168.56.10", "192.168.56.1").replace("AA:BB:CC:DD:EE:10", "AA:BB:CC:DD:EE:01");

check("parseNmap combined: same IP across discovery+service scan merges to one row", () => {
  const r = parseNmap(NMAP_COMBINED);
  const h1 = r.filter((x) => x.ip === "192.168.56.1");
  assert.strictEqual(h1.length, 1, "host .1 must appear exactly once after merge");
  assert.strictEqual(h1[0].vendor, "Tp-link Technologies", "vendor from -sn preserved");
  assert.ok(h1[0].ports.length >= 6, "ports from -sV merged in");
});

// ── nc OpenBSD-style sweep ─────────────────────────────────────────────────────
const NC_OPENBSD = `nc: connect to 192.168.56.10 port 20 (tcp) failed: Connection refused
nc: connect to 192.168.56.10 port 21 (tcp) failed: Connection refused
Connection to 192.168.56.10 22 port [tcp/ssh] succeeded!
nc: connect to 192.168.56.10 port 23 (tcp) failed: Connection refused
Connection to 192.168.56.10 80 port [tcp/http] succeeded!`;

check("parseNcSweep OpenBSD: succeeded→open ports, refused→host up", () => {
  const r = parseNcSweep(NC_OPENBSD);
  assert.strictEqual(r.length, 1);
  const h = r[0];
  assert.strictEqual(h.ip, "192.168.56.10");
  assert.strictEqual(h.status, "up");
  assert.strictEqual(h.ports.length, 2, "only succeeded ports counted");
  assert.deepStrictEqual(h.ports.map((p) => p.port).sort((a, b) => a - b), [22, 80]);
  assert.strictEqual(h.ports.find((p) => p.port === 22).service, "ssh");
});

// ── nc GNU/traditional-style "open" ────────────────────────────────────────────
const NC_GNU = `192.168.56.11 [192.168.56.11] 22 (ssh) open
192.168.56.11 [192.168.56.11] 443 (https) open
192.168.56.11 25 (smtp) open`;

check("parseNcSweep GNU: bracketed + bare forms", () => {
  const r = parseNcSweep(NC_GNU);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].ip, "192.168.56.11");
  assert.deepStrictEqual(r[0].ports.map((p) => p.port), [22, 25, 443]);
});

// ── nmap greppable -oG ─────────────────────────────────────────────────────────
const NMAP_OG = `# Nmap 7.94 scan initiated
Host: 192.168.56.20 (web.lan)\tStatus: Up
Host: 192.168.56.20 (web.lan)\tPorts: 22/open/tcp//ssh///, 80/open/tcp//http//nginx 1.18.0/\tIgnored State: closed (998)`;

check("parseNmap greppable -oG: status + ports", () => {
  const r = parseNmap(NMAP_OG);
  assert.strictEqual(r.length, 1);
  const h = r[0];
  assert.strictEqual(h.ip, "192.168.56.20");
  assert.strictEqual(h.hostname, "web.lan");
  assert.strictEqual(h.status, "up");
  assert.strictEqual(h.ports.length, 2);
  assert.strictEqual(h.ports.find((p) => p.port === 80).version, "nginx 1.18.0");
});

// ── dispatcher: mixed nmap + nc, merge by host ─────────────────────────────────
check("parseReconOutput: detects + merges nmap and nc for same host", () => {
  const mixed = NMAP_SV + "\n" + `Connection to 192.168.56.10 8443 port [tcp/https-alt] succeeded!`;
  const r = parseReconOutput(mixed);
  const h = r.find((x) => x.ip === "192.168.56.10");
  assert.ok(h, "host present");
  assert.ok(h.ports.find((p) => p.port === 8443), "nc-discovered port merged in");
  assert.ok(h.ports.find((p) => p.port === 22), "nmap-discovered port retained");
});

// ── robustness: empty / garbage / non-string → [] never throws ────────────────
check("parseReconOutput: empty + garbage + non-string → [] (no throw)", () => {
  assert.deepStrictEqual(parseReconOutput(""), []);
  assert.deepStrictEqual(parseReconOutput("hello world\nnothing to see"), []);
  assert.deepStrictEqual(parseReconOutput(null), []);
  assert.deepStrictEqual(parseReconOutput(undefined), []);
  assert.deepStrictEqual(parseNmap(12345), []);
  assert.deepStrictEqual(parseNcSweep({}), []);
});

console.log(`\n${passed} test(s) passed.`);
