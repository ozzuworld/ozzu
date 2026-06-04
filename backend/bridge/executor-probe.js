"use strict";
// executor-probe.js — Step 1 of OFFENSE-AGENT-DESIGN.md (dir_1780588077262)
//
// Replace hand-seeded pentest_engagements.executor_tools with what's ACTUALLY
// installed on the engagement's executor. Today the model trusts the seed and
// proposes commands that fail at runtime (e.g. `curl` on a stock-Android root
// tablet that doesn't have curl). This module runs a non-offensive discovery
// command via the same SSH-to-dev-01 + adb-wrap path as queue items, parses
// the +installed/-missing list, and writes the truth back.
//
// Membrane discipline: the probe is a generic `command -v <tool>` loop. It
// reveals no offensive content. Output is parsed server-side; only the
// installed list crosses any boundary.

const { spawn } = require("child_process");
const db = require("./db");

// Candidate list — broad enough to cover both kali (dev-01) and stock-Android-root
// (tablet) executors. Stays under shell-arg/length limits. To extend, append here
// and re-probe with force:true.
const CANDIDATE_TOOLS = [
  // shells / multitool
  "sh", "bash", "busybox", "toybox",
  // posix basics
  "cat", "echo", "grep", "awk", "sed", "head", "tail", "base64", "xxd",
  // network basics
  "curl", "wget", "nc", "ncat", "ping", "traceroute", "dig", "host",
  // recon / pentest (kali)
  "nmap", "masscan", "rustscan", "gobuster", "nikto", "searchsploit",
  // exploitation
  "msfconsole", "msfvenom", "hydra", "sqlmap", "john", "hashcat",
  // shells / forwarding
  "ssh", "sshpass", "socat", "tcpdump", "openssl",
  // languages
  "python3", "python", "perl", "ruby",
  // android-specific
  "ip", "iptables", "ip6tables", "getprop", "logcat", "settings",
];

// Build the probe shell command. One line per candidate; sentinel at the end so
// we can detect a complete run (vs a truncated one).
function buildProbeCommand() {
  const checks = CANDIDATE_TOOLS
    .map((t) => `command -v ${t} >/dev/null 2>&1 && echo +${t} || echo -${t}`)
    .join("; ");
  return `${checks}; echo PROBE_DONE`;
}

function parseProbeOutput(out) {
  const lines = String(out).split(/[\r\n]+/);
  const installed = [];
  for (const line of lines) {
    const m = line.match(/^\+([A-Za-z0-9_-]+)$/);
    if (m) installed.push(m[1]);
  }
  return installed;
}

// Same wrapping logic as offense-engine.wrapForExecutor — kept here so this
// module is self-contained (callable without loading offense-engine).
function wrapForExecutor(command, engagement) {
  const host = engagement && engagement.executor_host;
  if (!host || host === "dev-01" || !engagement.executor_adb_target) return command;
  const b64 = Buffer.from(String(command), "utf8").toString("base64");
  return `adb -s ${engagement.executor_adb_target} shell "echo ${b64} | base64 -d | sh" </dev/null`;
}

// Run the probe via dev-01 (matches the SOC executor contract — ssh stdin pipe
// to `bash -s`). For tablet executors, the wrapping routes the probe through
// adb so it runs ON the tablet (not on dev-01).
function runProbe(engagement) {
  return new Promise((resolve, reject) => {
    const probeCmd = wrapForExecutor(buildProbeCommand(), engagement);
    const proc = spawn(
      "ssh",
      [
        "-o", "StrictHostKeyChecking=no",
        "-o", "ConnectTimeout=15",
        "-o", "ServerAliveInterval=8",
        "-o", "ServerAliveCountMax=2",
        "-o", "BatchMode=yes",
        "dev-01",
        "bash", "-s",
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch (_) {}
      reject(new Error("probe timeout (60s)"));
    }, 60000);
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (!stdout.includes("PROBE_DONE")) {
        return reject(new Error(
          `probe did not complete (exit ${code}): ${(stderr || stdout).slice(-300)}`
        ));
      }
      resolve(parseProbeOutput(stdout));
    });
    proc.stdin.write(probeCmd);
    proc.stdin.end();
  });
}

const PROBE_CACHE_MS = 24 * 60 * 60 * 1000; // 24h — re-probe daily unless force

// Probe one engagement's executor; update its executor_tools column to ground truth.
// No-op if probed_at is recent (<24h) unless force=true. Returns a diff so the
// operator can see what changed.
async function probeExecutor(engagementId, force = false) {
  const er = await db.query(
    `SELECT id, executor_host, executor_adb_target, executor_tools, executor_tools_probed_at
       FROM pentest_engagements WHERE id = $1`,
    [engagementId]
  );
  if (er.rows.length === 0) throw new Error(`engagement ${engagementId} not found`);
  const eng = er.rows[0];

  if (!force && eng.executor_tools_probed_at) {
    const ageMs = Date.now() - new Date(eng.executor_tools_probed_at).getTime();
    if (ageMs < PROBE_CACHE_MS) {
      return {
        engagement_id: engagementId,
        probed: false,
        executor: eng.executor_host,
        cached_age_min: Math.round(ageMs / 60000),
        current_tools: eng.executor_tools || [],
      };
    }
  }

  const installed = await runProbe(eng);
  const declared = Array.isArray(eng.executor_tools) ? eng.executor_tools : [];
  const removed = declared.filter((t) => !installed.includes(t));
  const added = installed.filter((t) => !declared.includes(t));

  await db.query(
    `UPDATE pentest_engagements
        SET executor_tools = $1::jsonb, executor_tools_probed_at = NOW()
      WHERE id = $2`,
    [JSON.stringify(installed), engagementId]
  );

  return {
    engagement_id: engagementId,
    probed: true,
    executor: eng.executor_host,
    installed_count: installed.length,
    installed,
    added,
    removed,
  };
}

module.exports = { probeExecutor, CANDIDATE_TOOLS };
