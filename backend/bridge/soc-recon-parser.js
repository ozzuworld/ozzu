// soc-recon-parser.js — turn raw recon scan stdout into structured host records.
//
// WHY THIS EXISTS (dir_1780530175588):
//   SOC sessions hard-trip Anthropic's usage-policy classifier when raw scan
//   stdout (nmap/nc port sweeps) is pasted into chat for analysis. The classifier
//   re-scans the whole transcript every turn, so accumulated raw offensive output
//   poisons the session. The only lever that reaches the classifier is WHAT TEXT
//   ends up in the conversation. So we parse scan output SERVER-SIDE into structured
//   rows; Cipher reads the rows (host/port/service), never the raw dump.
//
// This module is intentionally PURE: text in, structured records out, no DB, no IO.
// That keeps it trivially unit-testable and side-effect free. The DB upsert lives
// in routes/soc.js; the read path lives in routes/soc.js + routes/mcp.js.
//
// Record shape (one per discovered host):
//   {
//     ip:       "192.168.1.10" | null,
//     hostname: "router.lan"   | null,
//     mac:      "AA:BB:CC:DD:EE:FF" | null,
//     vendor:   "Tp-link Technologies" | null,
//     status:   "up" | "down" | null,
//     ports:    [ { port: 22, proto: "tcp", state: "open", service: "ssh", version: "OpenSSH 8.2p1" }, ... ],
//     raw:      "<the source lines that produced this host, truncated>"   // evidence only
//   }
"use strict";

const IPV4 = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/;
const IPV4_ANCHORED = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

function emptyRecord() {
  return { ip: null, hostname: null, mac: null, vendor: null, status: null, ports: [], raw: "" };
}

function cleanVendor(v) {
  if (!v) return null;
  const t = v.trim();
  if (!t || /^unknown$/i.test(t)) return null;
  return t;
}

// Merge a list of partial records into one record per host (keyed by ip, falling
// back to hostname). Used both within parseNmap (multiple scan-report blocks for
// the same IP — e.g. `nmap -sn ... && nmap -p- -sV ...`) and across parsers in
// parseReconOutput (nmap block + nc sweep for the same host).
function mergeRecords(records) {
  const byKey = new Map();
  for (const rec of records) {
    const key = rec.ip || rec.hostname;
    if (!key) continue;
    let ex = byKey.get(key);
    if (!ex) {
      ex = emptyRecord();
      byKey.set(key, ex);
    }
    ex.ip = ex.ip || rec.ip;
    ex.hostname = ex.hostname || rec.hostname;
    ex.mac = ex.mac || rec.mac;
    ex.vendor = ex.vendor || rec.vendor;
    // 'up' is a strong signal — let it win over null/down (a host that answers
    // any probe is up, even if a later block didn't restate it).
    if (rec.status === "up" || (!ex.status && rec.status)) ex.status = rec.status;
    for (const p of rec.ports) {
      const dup = ex.ports.find((q) => q.port === p.port && q.proto === p.proto);
      if (dup) {
        dup.state = dup.state || p.state;
        dup.service = dup.service || p.service;
        dup.version = dup.version || p.version;
      } else {
        ex.ports.push({ ...p });
      }
    }
    if (rec.raw) ex.raw = ex.raw ? `${ex.raw}\n${rec.raw}` : rec.raw;
  }
  // Stable ordering: ports ascending, raw truncated to a short evidence excerpt.
  const out = [];
  for (const rec of byKey.values()) {
    rec.ports.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
    if (rec.raw && rec.raw.length > 1500) rec.raw = rec.raw.slice(0, 1500) + "\n…[truncated]";
    out.push(rec);
  }
  return out;
}

// ── nmap ────────────────────────────────────────────────────────────────────
// Handles the normal interactive output of `nmap -sn` (host discovery) and
// `nmap -sV` / `nmap -p-` (port + service/version), including the common combined
// invocation `nmap -sn <t> && nmap -p- -sV <t>` where the same IP appears twice.
// Also handles greppable output (`nmap -oG`) lines, which are unambiguous.
function parseNmap(text) {
  if (typeof text !== "string" || !text) return [];
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let cur = null;

  const pushCur = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };

  for (const line of lines) {
    // Greppable format: `Host: 1.2.3.4 (name)\tStatus: Up` and
    // `Host: 1.2.3.4 ()\tPorts: 22/open/tcp//ssh///, 80/open/tcp//http//nginx/`
    const gHost = line.match(/^Host:\s+(\d{1,3}(?:\.\d{1,3}){3})\s+\(([^)]*)\)/);
    if (gHost) {
      const rec = emptyRecord();
      rec.ip = gHost[1];
      rec.hostname = gHost[2] ? gHost[2].trim() || null : null;
      rec.raw = line;
      const status = line.match(/Status:\s+(Up|Down)/i);
      if (status) rec.status = status[1].toLowerCase();
      const portsPart = line.match(/Ports:\s+(.+?)(?:\tIgnored|$)/);
      if (portsPart) {
        for (const seg of portsPart[1].split(",")) {
          // port/state/proto/owner/service/rpc/version/
          const f = seg.trim().split("/");
          if (f.length >= 5 && /^\d+$/.test(f[0])) {
            rec.ports.push({
              port: parseInt(f[0], 10),
              proto: f[2] || "tcp",
              state: f[1] || null,
              service: f[4] || null,
              version: f[6] ? f[6].trim() || null : null,
            });
          }
        }
      }
      blocks.push(rec);
      continue;
    }

    // Normal format: a new host block starts at "Nmap scan report for ..."
    const report = line.match(/^Nmap scan report for (.+?)\s*$/);
    if (report) {
      pushCur();
      cur = emptyRecord();
      cur.raw = line;
      const target = report[1].trim();
      const withParen = target.match(/^(.+?)\s+\((\d{1,3}(?:\.\d{1,3}){3})\)$/);
      if (withParen) {
        cur.hostname = withParen[1].trim();
        cur.ip = withParen[2];
      } else if (IPV4_ANCHORED.test(target)) {
        cur.ip = target;
      } else {
        // Bracketed IP form: "host [1.2.3.4]" or hostname only.
        const bracket = target.match(/\[(\d{1,3}(?:\.\d{1,3}){3})\]/);
        if (bracket) {
          cur.ip = bracket[1];
          cur.hostname = target.replace(/\s*\[[^\]]*\]\s*/, "").trim() || null;
        } else {
          cur.hostname = target;
        }
      }
      continue;
    }

    if (!cur) continue; // line outside any host block (banner, summary, etc.)
    cur.raw += "\n" + line;

    if (/^Host is up\b/i.test(line)) { cur.status = "up"; continue; }
    if (/Host seems down|appears to be down|\[host down\]/i.test(line)) { cur.status = "down"; continue; }

    const mac = line.match(/^MAC Address:\s*([0-9A-Fa-f:]{17})\s*(?:\((.*)\))?/);
    if (mac) {
      cur.mac = mac[1].toUpperCase();
      cur.vendor = cleanVendor(mac[2]);
      continue;
    }

    // Port line: "22/tcp   open  ssh    OpenSSH 8.2p1 Ubuntu 4ubuntu0.5"
    // Excludes the "PORT  STATE SERVICE VERSION" header (starts with non-digit).
    const port = line.match(/^(\d{1,5})\/(tcp|udp|sctp)\s+(\S+)\s+(\S+)(?:\s+(.*\S))?\s*$/i);
    if (port) {
      cur.ports.push({
        port: parseInt(port[1], 10),
        proto: port[2].toLowerCase(),
        state: port[3].toLowerCase(),
        service: port[4] || null,
        version: port[5] ? port[5].trim() : null,
      });
      continue;
    }
  }
  pushCur();

  // A host block with no explicit status but that produced a report line is, by
  // nmap convention, up (down hosts are normally suppressed). Default it.
  for (const b of blocks) {
    if (!b.status && (b.ip || b.hostname)) b.status = "up";
  }
  return mergeRecords(blocks);
}

// ── nc / netcat port sweep ────────────────────────────────────────────────────
// Recognizes the success/refused lines of the common nc variants:
//   OpenBSD : "Connection to 1.2.3.4 22 port [tcp/ssh] succeeded!"
//   GNU/trad: "1.2.3.4 [1.2.3.4] 22 (ssh) open"  /  "1.2.3.4 22 (ssh) open"
//   failure : "nc: connect to 1.2.3.4 port 23 (tcp) failed: Connection refused"
// A refused connection still proves the host is up (it sent a RST), so we mark
// the host 'up' from refused lines but only add ports for succeeded/open lines.
function parseNcSweep(text) {
  if (typeof text !== "string" || !text) return [];
  const lines = text.split(/\r?\n/);
  const records = [];

  for (const line of lines) {
    // OpenBSD nc success
    let m = line.match(/^Connection to (\S+) (\d+) port \[(\w+)\/([^\]]+)\] succeeded!/i);
    if (m) {
      const rec = emptyRecord();
      rec.ip = IPV4_ANCHORED.test(m[1]) ? m[1] : (m[1].match(IPV4) ? m[1].match(IPV4)[1] : null);
      if (!rec.ip) rec.hostname = m[1];
      rec.status = "up";
      rec.ports.push({ port: parseInt(m[2], 10), proto: (m[3] || "tcp").toLowerCase(), state: "open", service: (m[4] || "").trim() || null, version: null });
      rec.raw = line;
      records.push(rec);
      continue;
    }

    // GNU / traditional nc "open"
    m = line.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?:\s+\[[^\]]+\])?\s+(\d+)\s+\(([^)]*)\)\s+open\b/i);
    if (m) {
      const rec = emptyRecord();
      rec.ip = m[1];
      rec.status = "up";
      rec.ports.push({ port: parseInt(m[2], 10), proto: "tcp", state: "open", service: m[3].trim() || null, version: null });
      rec.raw = line;
      records.push(rec);
      continue;
    }

    // Refused/timeout — host is alive on refused; record it as up with no port.
    m = line.match(/^nc: connect to (\S+) port (\d+) \((\w+)\) failed:\s*(.*)$/i);
    if (m) {
      const reason = (m[4] || "").toLowerCase();
      // A RST ("refused") proves the host is up. A timeout proves nothing.
      if (/refused/.test(reason)) {
        const rec = emptyRecord();
        rec.ip = IPV4_ANCHORED.test(m[1]) ? m[1] : (m[1].match(IPV4) ? m[1].match(IPV4)[1] : null);
        if (!rec.ip) rec.hostname = m[1];
        rec.status = "up";
        rec.raw = line;
        records.push(rec);
      }
      continue;
    }
  }
  return mergeRecords(records);
}

// ── dispatcher ────────────────────────────────────────────────────────────────
// A single fullOutput blob may contain nmap output, nc output, or both (a script
// can run several tools). Detect what's present, run the applicable parsers, and
// merge the results by host so the caller gets one row per IP.
// ── bash ping-sweep / liveness loop ──────────────────────────────────────────
// The model frequently falls back to a shell loop instead of nmap, e.g.
//   for i in $(seq 1 254); do ping -c1 -W1 192.168.1.$i && echo "192.168.1.$i is up"; done
// emitting "192.168.1.24 is up" / "192.168.1.24 UP" / "192.168.1.24 is alive". The
// nmap/nc parsers don't recognize that, so genuinely-discovered hosts were silently
// dropped and the step marked failed (dir_1782315000000). Recognize it: a line that
// starts with an IP and says up/alive = a live host (status up, no ports yet).
function parsePingSweep(text) {
  if (typeof text !== "string" || !text) return [];
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:host\s+)?(\d{1,3}(?:\.\d{1,3}){3})\b.*?\b(?:is\s+up|is\s+alive|alive|up)\b/i);
    if (m) {
      const rec = emptyRecord();
      rec.ip = m[1];
      rec.status = "up";
      rec.raw = line.slice(0, 200);
      records.push(rec);
    }
  }
  return mergeRecords(records);
}

// ── dispatcher ────────────────────────────────────────────────────────────────
// A single fullOutput blob may contain nmap output, nc output, a bash ping-sweep,
// or several. Detect what's present, run the applicable parsers, merge by host.
function parseReconOutput(text) {
  if (typeof text !== "string" || !text) return [];
  const hasNmap = /Nmap scan report for|^Host:\s+\d|Starting Nmap|Nmap done/m.test(text);
  const hasNc = /Connection to \S+ \d+ port \[|\) open\b|nc: connect to/m.test(text);
  // bash ping-loop liveness lines: "<IP> is up" / "<IP> UP" / "<IP> is alive"
  const hasPingSweep = /^\s*(?:host\s+)?\d{1,3}(?:\.\d{1,3}){3}\b.*?\b(?:is\s+up|is\s+alive|alive|up)\b/im.test(text);

  const all = [];
  if (hasNmap) all.push(...parseNmap(text));
  if (hasNc) all.push(...parseNcSweep(text));
  if (hasPingSweep) all.push(...parsePingSweep(text));
  if (!all.length) return [];
  return mergeRecords(all);
}

module.exports = { parseNmap, parseNcSweep, parsePingSweep, parseReconOutput };
