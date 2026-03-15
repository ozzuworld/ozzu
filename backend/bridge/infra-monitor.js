// infra-monitor.js — Live infrastructure state monitor
// Periodically probes all devices, services, and network state
// Serves cached results via getState() for MCP consumption
// NOTE: Runs inside Docker container (host network) — no ip/ping commands available
//       Uses /proc, /sys, SSH, and curl for all probes

"use strict";

const { execSync } = require("child_process");
const fs = require("fs");

// ── Device & service definitions ──

const DEVICES = {
  "rockpi": {
    name: "Rock Pi 4B",
    hostname: "ozzu-rockpi-lroom-01",
    ip: "172.168.0.55",
    role: "Positioning hub, WiFi AP (ozzu-nodes), OTA server",
    ssh: { user: "root", timeout: 5 },
    services: ["hostapd", "dnsmasq", "ozzu-positioning"],
    portChecks: [{ name: "ota-server", port: 5501 }],
  },
  "dev-01": {
    name: "dev-01 (local Linux)",
    hostname: "dev-01",
    ip: "172.168.0.57",
    role: "Local compute, GCP extension, Docker host",
    ssh: { user: "hadmin", key: "~/.ssh/dev01_key", timeout: 5 },
    services: [],
    portChecks: [],
  },
};

const ESP32_NODES = [
  { id: 1, room: "living",  ip: "10.0.50.21", mac: "ac:15:18:d7:bd:38" },
  { id: 2, room: "master",  ip: "10.0.50.23", mac: "88:13:bf:62:d9:8c" },
  { id: 3, room: "office",  ip: "10.0.50.22", mac: "88:13:bf:63:2f:28" },
  { id: 4, room: "rooftop", ip: "10.0.50.24", mac: null, deployed: false },
];

// ── State ──

let _state = null;
let _lastUpdate = 0;
let _timer = null;
const UPDATE_INTERVAL = 60000; // 1 minute

// ── Helpers ──

function execQuiet(cmd, timeoutMs = 10000) {
  try {
    return execSync(cmd, { timeout: timeoutMs, stdio: "pipe", encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function sshExec(deviceKey, remoteCmd, timeoutMs = 15000) {
  const d = DEVICES[deviceKey];
  if (!d) return null;
  const keyFlag = d.ssh.key ? `-i ${d.ssh.key}` : "";
  const escaped = remoteCmd.replace(/'/g, "'\\''");
  const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=${d.ssh.timeout} -o BatchMode=yes ${keyFlag} ${d.ssh.user}@${d.ip} '${escaped}'`;
  return execQuiet(cmd, timeoutMs);
}

// ── Probe functions ──

function probeNetwork() {
  const network = {
    vpn: { status: "unknown", localIp: null, peerIp: null },
    routes: [],
    lan: { subnet: null },
  };

  // VPN — check /sys/class/net/tun0
  try {
    const operstate = fs.readFileSync("/sys/class/net/tun0/operstate", "utf8").trim();
    network.vpn.status = (operstate === "unknown" || operstate === "up") ? "up" : "down";
  } catch {
    network.vpn.status = "no_interface";
  }

  // Parse /proc/net/route for routing table (works without ip command)
  try {
    const routeTable = fs.readFileSync("/proc/net/route", "utf8");
    for (const line of routeTable.split("\n").slice(1)) {
      const parts = line.split("\t");
      if (parts.length < 8) continue;
      const [iface, destHex, gwHex, , , , , maskHex] = parts;
      const dest = hexToIp(destHex);
      const gw = hexToIp(gwHex);
      const mask = hexToMask(maskHex);

      if (iface === "tun0" && dest !== "0.0.0.0") {
        network.routes.push(`${dest}/${mask} via ${gw} dev tun0`);
        if (dest === "172.168.0.0") {
          network.lan.subnet = `${dest}/${mask}`;
          network.vpn.peerIp = gw;
        }
      }
    }
  } catch { /* ignore */ }

  // Get local tun0 IP from /proc/net/fib_trie or ifconfig
  const ifconfig = execQuiet("cat /proc/net/if_inet6 2>/dev/null; cat /proc/net/fib_trie 2>/dev/null | grep -A1 'tun0' | head -5");
  // Simpler: read from /sys
  try {
    const addrs = fs.readFileSync("/proc/net/fib_trie", "utf8");
    const tun0Section = addrs.split("tun0");
    if (tun0Section.length > 1) {
      const localMatch = tun0Section[1].match(/\|--\s+(\d+\.\d+\.\d+\.\d+)\s*\n\s+\/32 host LOCAL/);
      if (localMatch) network.vpn.localIp = localMatch[1];
    }
  } catch { /* ignore */ }

  // GCP IPs
  const hostIps = execQuiet("hostname -I 2>/dev/null");
  if (hostIps) network.gcpIps = hostIps.trim().split(/\s+/);

  return network;
}

function hexToIp(hex) {
  if (!hex || hex.length !== 8) return "0.0.0.0";
  const b = Buffer.from(hex, "hex");
  return `${b[3]}.${b[2]}.${b[1]}.${b[0]}`;
}

function hexToMask(hex) {
  if (!hex || hex.length !== 8) return 0;
  const b = Buffer.from(hex, "hex");
  const mask = (b[3] << 24 | b[2] << 16 | b[1] << 8 | b[0]) >>> 0;
  return mask.toString(2).split("1").length - 1; // count set bits
}

function probeDevice(deviceKey) {
  const def = DEVICES[deviceKey];
  const result = {
    name: def.name,
    ip: def.ip,
    role: def.role,
    reachable: false,
    hostname: null,
    uptime: null,
    resources: null,
    services: {},
  };

  // Use SSH as both reachability test AND data probe (no ping available in container)
  const start = Date.now();
  const probe = sshExec(deviceKey,
    "echo HOSTNAME=$(hostname); echo UPTIME=$(uptime -p); echo DISK=$(df -h / | tail -1); echo MEM=$(free -m | grep Mem); echo LOAD=$(cat /proc/loadavg)");

  if (!probe) return result;

  result.reachable = true;
  result.latencyMs = Date.now() - start;

  for (const line of probe.split("\n")) {
    if (line.startsWith("HOSTNAME=")) result.hostname = line.slice(9);
    if (line.startsWith("UPTIME=")) result.uptime = line.slice(7);
    if (line.startsWith("DISK=")) {
      const parts = line.slice(5).split(/\s+/);
      result.resources = result.resources || {};
      result.resources.disk = { size: parts[1], used: parts[2], avail: parts[3], pct: parts[4] };
    }
    if (line.startsWith("MEM=")) {
      const parts = line.slice(4).split(/\s+/);
      result.resources = result.resources || {};
      result.resources.memory = { totalMb: +parts[1], usedMb: +parts[2], freeMb: +parts[3] };
    }
    if (line.startsWith("LOAD=")) {
      const parts = line.slice(5).split(" ");
      result.resources = result.resources || {};
      result.resources.cpu = { load1m: parts[0], load5m: parts[1], load15m: parts[2] };
    }
  }

  // Check systemd services via SSH
  if (def.services.length > 0) {
    const svcCmd = def.services.map(s => `echo SVC_${s}=$(systemctl is-active ${s} 2>/dev/null)`).join("; ");
    const svcResult = sshExec(deviceKey, svcCmd);
    if (svcResult) {
      for (const line of svcResult.split("\n")) {
        const match = line.match(/^SVC_(.+)=(.+)$/);
        if (match) result.services[match[1]] = match[2];
      }
    }
  }

  // Port checks via SSH
  for (const check of (def.portChecks || [])) {
    const nc = sshExec(deviceKey, `ss -tln 2>/dev/null | grep :${check.port} | head -1`);
    result.services[check.name] = nc ? "listening" : "not_listening";
  }

  return result;
}

function probeEsp32Nodes() {
  const nodes = ESP32_NODES.map(n => ({ ...n, reachable: false, status: "unknown" }));

  // Batch ping all deployed nodes from Rock Pi in one SSH call
  const deployed = nodes.filter(n => n.deployed !== false);
  if (deployed.length === 0) return nodes;

  const pingCmds = deployed.map(n =>
    `echo NODE_${n.id}=$(ping -c 1 -W 2 ${n.ip} 2>/dev/null | grep -c "1 received")`
  ).join("; ");

  const result = sshExec("rockpi", pingCmds);
  if (result) {
    for (const line of result.split("\n")) {
      const match = line.match(/^NODE_(\d+)=(\d+)$/);
      if (match) {
        const node = nodes.find(n => n.id === +match[1]);
        if (node) {
          node.reachable = match[2] === "1";
          node.status = node.reachable ? "online" : "offline";
        }
      }
    }
  }

  // Mark undeployed
  for (const n of nodes) {
    if (n.deployed === false) n.status = "not_deployed";
  }

  // Check hub's view of connected nodes
  const hubLog = sshExec("rockpi",
    "journalctl -u ozzu-positioning --no-pager -n 20 --output=short-iso 2>/dev/null | tail -20");
  if (hubLog) {
    for (const node of nodes) {
      if (hubLog.includes(node.ip)) node.lastSeenInHub = true;
    }
  }

  return nodes;
}

function probeGcpLocal() {
  const gcp = {
    hostname: "unknown",
    uptime: "unknown",
    resources: {},
    docker: [],
  };

  // Use /proc for everything (no external commands needed)
  try { gcp.hostname = fs.readFileSync("/proc/sys/kernel/hostname", "utf8").trim(); } catch { /* ignore */ }
  try { gcp.uptime = execQuiet("uptime -p") || "unknown"; } catch { /* ignore */ }

  // Disk
  const disk = execQuiet("df -h / | tail -1");
  if (disk) {
    const parts = disk.split(/\s+/);
    gcp.resources.disk = { size: parts[1], used: parts[2], avail: parts[3], pct: parts[4] };
  }

  // Memory from /proc/meminfo
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
    const total = meminfo.match(/MemTotal:\s+(\d+)/);
    const free = meminfo.match(/MemAvailable:\s+(\d+)/);
    if (total && free) {
      const totalMb = Math.round(+total[1] / 1024);
      const freeMb = Math.round(+free[1] / 1024);
      gcp.resources.memory = { totalMb, usedMb: totalMb - freeMb, freeMb };
    }
  } catch { /* ignore */ }

  // CPU load from /proc/loadavg
  try {
    const loadavg = fs.readFileSync("/proc/loadavg", "utf8").trim().split(" ");
    gcp.resources.cpu = { load1m: loadavg[0], load5m: loadavg[1], load15m: loadavg[2] };
  } catch { /* ignore */ }

  // Docker — use curl to docker socket (more reliable than docker CLI in container)
  const dockerPs = execQuiet("curl -sf --unix-socket /var/run/docker.sock http://localhost/containers/json 2>/dev/null");
  if (dockerPs) {
    try {
      const containers = JSON.parse(dockerPs);
      gcp.docker = containers.map(c => ({
        name: (c.Names?.[0] || "").replace(/^\//, ""),
        status: c.Status,
        state: c.State,
        image: (c.Image || "").split(":")[0].split("/").pop(),
      }));
    } catch { /* ignore */ }
  } else {
    // Fallback: docker CLI
    const ps = execQuiet("docker ps --format '{{.Names}}|{{.Status}}|{{.State}}' 2>/dev/null");
    if (ps) {
      gcp.docker = ps.split("\n").filter(Boolean).map(line => {
        const [name, status, state] = line.split("|");
        return { name, status, state };
      });
    }
  }

  return gcp;
}

function probePositioningHub() {
  const hub = {
    service: "unknown",
    config: null,
    lastOutput: null,
    irkStore: null,
    otaFirmware: null,
    wifiAp: null,
  };

  // All data from Rock Pi via SSH — batch multiple queries to minimize connections
  const batchCmd = [
    "echo SVC=$(systemctl is-active ozzu-positioning 2>/dev/null)",
    "echo IRK=$(test -f /opt/ozzu-positioning/irk_store.json && echo exists || echo not_found)",
    "echo OTA=$(ls -la /opt/ozzu-ota/firmware.bin 2>/dev/null || echo not_found)",
    "echo AP=$(systemctl is-active hostapd 2>/dev/null)",
    "echo ---HUB_LOG_START---",
    "journalctl -u ozzu-positioning --no-pager -n 5 --output=short-iso 2>/dev/null",
    "echo ---HUB_LOG_END---",
  ].join("; ");

  const result = sshExec("rockpi", batchCmd);
  if (!result) return hub;

  for (const line of result.split("\n")) {
    if (line.startsWith("SVC=")) hub.service = line.slice(4);
    if (line.startsWith("IRK=")) hub.irkStore = line.slice(4);
    if (line.startsWith("OTA=")) hub.otaFirmware = line.slice(4);
    if (line.startsWith("AP=")) hub.wifiAp = line.slice(3);
  }

  // Extract hub log between markers
  const logStart = result.indexOf("---HUB_LOG_START---");
  const logEnd = result.indexOf("---HUB_LOG_END---");
  if (logStart !== -1 && logEnd !== -1) {
    hub.lastOutput = result.slice(logStart + 20, logEnd).trim();
  }

  return hub;
}

// ── Main update ──

function updateState() {
  const start = Date.now();
  const state = {
    timestamp: new Date().toISOString(),
    network: probeNetwork(),
    devices: {},
    esp32Nodes: [],
    gcp: probeGcpLocal(),
    positioningHub: null,
  };

  // Probe each device
  for (const key of Object.keys(DEVICES)) {
    state.devices[key] = probeDevice(key);
  }

  // ESP32 nodes (only if Rock Pi reachable)
  if (state.devices.rockpi?.reachable) {
    state.esp32Nodes = probeEsp32Nodes();
    state.positioningHub = probePositioningHub();
  } else {
    state.esp32Nodes = ESP32_NODES.map(n => ({
      ...n,
      status: n.deployed === false ? "not_deployed" : "unknown_rockpi_down",
      reachable: false,
    }));
    state.positioningHub = { service: "unknown_rockpi_down" };
  }

  state.probeTimeMs = Date.now() - start;
  _state = state;
  _lastUpdate = Date.now();

  return state;
}

// ── Public API ──

function getState() {
  if (!_state) updateState();
  return _state;
}

function getQuickState() {
  return _state || { timestamp: null, error: "No state yet — monitor not started" };
}

function start() {
  if (_timer) return;
  console.log("[infra-monitor] Starting — probing every 60s");
  try { updateState(); } catch (e) { console.error("[infra-monitor] Initial probe error:", e.message); }
  _timer = setInterval(() => {
    try { updateState(); } catch (e) { console.error("[infra-monitor] Probe error:", e.message); }
  }, UPDATE_INTERVAL);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

function refresh() {
  return updateState();
}

module.exports = { getState, getQuickState, start, stop, refresh, DEVICES, ESP32_NODES };
