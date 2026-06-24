"use strict";
// recon-discovery-normalize.js — dir_1782311308515
//
// The EDIFICIO lab is reached over the wg0 → p610 tablet → LAN *L3* relay.
// VERIFIED 2026-06-24: the bridge can ICMP-ping lab hosts through that relay
// (6/7 of the hosts engagement 353 found answered). So ICMP CROSSES the relay.
// What does NOT work:
//   - ARP host-discovery (nmap's default for an "on-link" subnet) is link-local
//     and cannot cross the L3 WireGuard tunnel → nmap reports 0 hosts up.
//   - `-Pn` (which the harness was force-injecting on the false belief that ICMP
//     can't cross) SKIPS host discovery, so nmap scans all 254 addresses of the
//     /24 over the ~100-250ms relay → times out before recording any host.
// Both make recon return 0 hosts even though the hosts are up and reachable.
//
// FIX: normalize every nmap invocation for this executor to discover via ICMP:
//   - strip `-Pn`  → re-enable host discovery
//   - add `--disable-arp-ping` → force ICMP/L3 discovery instead of ARP
//   - ensure a connect scan (`-sT`, L3-safe) when no scan type is present
//   - never mangle a `-sn` ICMP ping-sweep
//
// PURE: string in, string out. No DB, no IO — host-requireable for unit tests.

const SEP_RE = /([|;&\n]+)/; // split compound commands, keep separators

// Does nmap lead this segment (after sudo/nice/timeout/stdbuf prefixes)?
function nmapLeads(seg) {
  const lead = String(seg).trimStart()
    .replace(/^(sudo\s+|nice\s+(-n\s+\S+\s+)?|timeout\s+\S+\s+|stdbuf\s+\S+\s+)*/i, "")
    .split(/\s+/)[0] || "";
  return lead === "nmap" || lead.endsWith("/nmap");
}

// Normalize a single command segment whose leading command is nmap.
function normalizeSegment(seg) {
  if (!nmapLeads(seg)) return seg;
  let s = seg;
  // 1. Re-enable host discovery (ICMP crosses the relay; -Pn forced an all-254 scan that timed out).
  s = s.replace(/\s-Pn\b/g, "");
  const isPingSweep = /\s-sn\b/.test(s);
  // dir_1782311308515 fix-2: -sn (ping scan, no ports) is INVALID combined with any
  // port-scan type. The tablet autorepair injects -sT, producing `-sT -sn` → nmap
  // "-sL and -sn ... not valid with any other scan types. QUITTING!" → 0 hosts.
  // When -sn is present, strip every -s<Capital> scan-type flag (lowercase -sn is kept).
  if (isPingSweep) s = s.replace(/\s-s[A-Z]\b/g, "");
  // 2/3. Build the flags to inject right after the leading `nmap`.
  const flags = [];
  if (!/--disable-arp-ping\b/.test(s)) flags.push("--disable-arp-ping"); // ICMP/L3 discovery, not ARP
  const hasScanType = /\s(-sT|-sS|-sU|-sV|-sA|-sW|-sn|--open)\b/.test(s);
  if (!isPingSweep && !hasScanType) flags.push("-sT"); // connect scan works over L3
  if (flags.length) s = s.replace(/\bnmap\b/, "nmap " + flags.join(" "));
  return s;
}

// Normalize every nmap invocation in a (possibly compound) command for the
// bridge → L3-relay executor. Returns the (possibly unchanged) command string.
function normalizeNmapDiscovery(cmd) {
  if (typeof cmd !== "string" || !/\bnmap\b/.test(cmd)) return cmd;
  return cmd.split(SEP_RE).map(normalizeSegment).join("");
}

module.exports = { normalizeNmapDiscovery, normalizeSegment, nmapLeads };
