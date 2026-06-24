"use strict";
// dir_1782311308515 — recon-discovery-normalize unit tests.
// Imports the REAL exported function (the module is pure / host-requireable),
// so reverting a production line turns the corresponding test RED (mutation-proof).
const assert = require("assert");
const { normalizeNmapDiscovery } = require("../recon-discovery-normalize");

let pass = 0, fail = 0;
function check(desc, fn) {
  try { fn(); console.log(`  ✓ ${desc}`); pass++; }
  catch (e) { console.log(`  ✗ ${desc}\n    ${e.message}`); fail++; }
}

console.log("[recon-discovery-normalize] dir_1782311308515");

check("1. strips -Pn from a lab nmap (re-enable host discovery)", () => {
  const out = normalizeNmapDiscovery("nmap -Pn -sT 192.168.1.0/24");
  assert.ok(!/-Pn\b/.test(out), `-Pn not stripped: ${out}`);
});
check("2. forces ICMP discovery (--disable-arp-ping) + keeps -sT", () => {
  const out = normalizeNmapDiscovery("nmap -Pn -sT 192.168.1.0/24");
  assert.ok(/--disable-arp-ping\b/.test(out), `no --disable-arp-ping: ${out}`);
  assert.ok(/-sT\b/.test(out), `lost -sT: ${out}`);
});
check("3. ping-sweep (-sn) keeps -sn + gets --disable-arp-ping, NOT mangled with -sT", () => {
  const out = normalizeNmapDiscovery("nmap -sn 192.168.1.0/24");
  assert.ok(/-sn\b/.test(out), `lost -sn: ${out}`);
  assert.ok(/--disable-arp-ping\b/.test(out), `no --disable-arp-ping: ${out}`);
  assert.ok(!/-sT\b/.test(out), `-sT wrongly injected into ping-sweep: ${out}`);
});
check("4. untyped nmap gets -sT (connect scan) + --disable-arp-ping", () => {
  const out = normalizeNmapDiscovery("nmap 192.168.1.5");
  assert.ok(/-sT\b/.test(out), `no -sT on untyped scan: ${out}`);
  assert.ok(/--disable-arp-ping\b/.test(out), `no --disable-arp-ping: ${out}`);
});
check("5. typed scan (-sV) is NOT given a redundant -sT", () => {
  const out = normalizeNmapDiscovery("nmap -sV -p 80 192.168.1.5");
  assert.ok(/--disable-arp-ping\b/.test(out), `no --disable-arp-ping: ${out}`);
  assert.ok(!/-sT\b/.test(out), `redundant -sT injected: ${out}`);
});
check("6. compound: only the nmap segment normalized; 'echo nmap' untouched", () => {
  const out = normalizeNmapDiscovery("echo nmap | nmap -Pn -sT 192.168.1.5");
  assert.ok(/echo nmap \s*\|/.test(out), `echo segment mangled: ${out}`);
  assert.ok(!/-Pn\b/.test(out), `-Pn not stripped in nmap segment: ${out}`);
  assert.ok(/--disable-arp-ping\b/.test(out), `nmap segment not normalized: ${out}`);
});
check("7. idempotent — no doubled --disable-arp-ping", () => {
  const out = normalizeNmapDiscovery("nmap --disable-arp-ping -sT 192.168.1.5");
  assert.strictEqual((out.match(/--disable-arp-ping/g) || []).length, 1, `doubled flag: ${out}`);
});
check("8. non-nmap command unchanged", () => {
  const cmd = "curl -s http://192.168.1.5/";
  assert.strictEqual(normalizeNmapDiscovery(cmd), cmd);
});
check("9. REGRESSION: tablet-mangled '-Pn -sT -sn' → valid ICMP ping-sweep (no -sT, keeps -sn)", () => {
  // The exact command that produced nmap 'QUITTING!' on SKYLINE-SOC-2026-871 seq1.
  const out = normalizeNmapDiscovery("nmap -Pn -sT -sn 192.168.1.0/24");
  assert.ok(/\s-sn\b/.test(out), `lost -sn: ${out}`);
  assert.ok(!/\s-sT\b/.test(out), `-sT NOT stripped — nmap will QUITTING!: ${out}`);
  assert.ok(!/\s-Pn\b/.test(out), `-Pn not stripped: ${out}`);
  assert.ok(/--disable-arp-ping\b/.test(out), `no --disable-arp-ping: ${out}`);
});

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
