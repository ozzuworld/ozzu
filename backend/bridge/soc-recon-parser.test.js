// Fixtures (sample nmap/nc output) live in ./__fixtures__/soc-recon-samples.js — NOT inline.
// Anti-trip (dir_1780531985209): keep scan-shaped text out of files that get casually read.
// Add new parser cases' samples to that fixtures file, not here.
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
const { NMAP_SN, NMAP_SV, NC_OPENBSD, NC_GNU, NMAP_OG, NC_8443, NMAP_COMBINED } = require("./__fixtures__/soc-recon-samples");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── nmap -sn host discovery ───────────────────────────────────────────────────

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

check("parseNmap combined: same IP across discovery+service scan merges to one row", () => {
  const r = parseNmap(NMAP_COMBINED);
  const h1 = r.filter((x) => x.ip === "192.168.56.1");
  assert.strictEqual(h1.length, 1, "host .1 must appear exactly once after merge");
  assert.strictEqual(h1[0].vendor, "Tp-link Technologies", "vendor from -sn preserved");
  assert.ok(h1[0].ports.length >= 6, "ports from -sV merged in");
});

// ── nc OpenBSD-style sweep ─────────────────────────────────────────────────────

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

check("parseNcSweep GNU: bracketed + bare forms", () => {
  const r = parseNcSweep(NC_GNU);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].ip, "192.168.56.11");
  assert.deepStrictEqual(r[0].ports.map((p) => p.port), [22, 25, 443]);
});

// ── nmap greppable -oG ─────────────────────────────────────────────────────────

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
  const mixed = NMAP_SV + "\n" + NC_8443;
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
