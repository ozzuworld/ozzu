// infra-monitor.js — Live infrastructure state monitor
// Periodically probes all devices, services, and network state
// Serves cached results via getState() for MCP consumption

"use strict";

const { execSync, exec } = require("child_process");
const http = require("http");

// ── Device & service definitions ──

const DEVICES = {
  "rockpi": {
    name: "Rock Pi 4B",
    hostname: "ozzu-rockpi-lroom-01",
    ip: "172.168.0.55",
    role: "Positioning hub, WiFi AP (ozzu-nodes), OTA server",
    ssh: { user: "root", timeout: 5 },
    services: ["hostapd", "dnsmasq", "ozzu-positioning"],
    checks: [
      { name: "ota-server", type: "port", port: 5501 },
    ],
  },
  "dev-01": {
    name: "dev-01 (local Linux)",
    hostname: "dev-01",
    ip: "172.168.0.57",
    role: "Local compute, GCP extension, Docker host",
    ssh: { user: "hadmin", key: "~/.ssh/dev01_key", timeout: 5 },
    services: [],
    checks: [],
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
  } catch (e) {
    return null;
  }
}

function sshCmd(device, remoteCmd) {
  const d = DEVICES[device];
  if (!d) return null;
  const keyFlag = d.ssh.key ? `-i ${d.ssh.key}` : "";
  // Use single quotes to prevent local shell expansion of $() etc.
  const escaped = remoteCmd.replace(/'/g, "'\\''");
  return `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=${d.ssh.timeout} -o BatchMode=yes ${keyFlag} ${d.ssh.user}@${d.ip} '${escaped}'`;
}

function sshExec(device, remoteCmd, timeoutMs = 15000) {
  const cmd = sshCmd(device, remoteCmd);
  if (!cmd) return null;
  return execQuiet(cmd, timeoutMs);
}

// ── Probe functions ──

function probeNetwork() {
  const network = {
    vpn: { status: "unknown", localIp: null, peerIp: null },
    routes: [],
    lan: { subnet: null, gateway: null },
  };

  // VPN status
  const tun0 = execQuiet("ip addr show tun0 2>/dev/null");
  if (tun0) {
    const ipMatch = tun0.match(/inet (\d+\.\d+\.\d+\.\d+)\/(\d+)/);
    network.vpn.status = tun0.includes("UP") ? "up" : "down";
    if (ipMatch) network.vpn.localIp = ipMatch[1];
  } else {
    network.vpn.status = "no_interface";
  }

  // Routes to LAN
  const routes = execQuiet("ip route");
  if (routes) {
    for (const line of routes.split("\n")) {
      if (line.includes("172.168.") || line.includes("192.168.") || line.includes("10.0.50")) {
        network.routes.push(line.trim());
        if (line.includes("172.168.0.0")) {
          const via = line.match(/via (\S+)/);
          if (via) network.vpn.peerIp = via[1];
          network.lan.subnet = "172.168.0.0/24";
        }
      }
    }
  }

  // GCP local info
  const gcpIp = execQuiet("hostname -I 2>/dev/null");
  if (gcpIp) network.gcpIps = gcpIp.trim().split(/\s+/);

  return network;
}

function probeDevice(deviceKey) {
  const def = DEVICES[deviceKey];
  const result = {
    name: def.name,
    ip: def.ip,
    role: def.role,
    reachable: false,
    latencyMs: null,
    hostname: null,
    uptime: null,
    resources: null,
    services: {},
  };

  // Ping
  const ping = execQuiet(`ping -c 1 -W 3 ${def.ip} 2>/dev/null`);
  if (ping) {
    const timeMatch = ping.match(/time=(\d+\.?\d*)/);
    result.reachable = ping.includes("1 received");
    if (timeMatch) result.latencyMs = parseFloat(timeMatch[1]);
  }

  if (!result.reachable) return result;

  // SSH probe — hostname, uptime, disk, memory, load in one call
  const probe = sshExec(deviceKey,
    "echo HOSTNAME=$(hostname); echo UPTIME=$(uptime -p); echo DISK=$(df -h / | tail -1); echo MEM=$(free -m | grep Mem); echo LOAD=$(cat /proc/loadavg)");
  if (probe) {
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
  }

  // Check systemd services
  for (const svc of def.services) {
    const status = sshExec(deviceKey, `systemctl is-active ${svc} 2>/dev/null`);
    result.services[svc] = status || "unreachable";
  }

  // Additional port checks
  for (const check of def.checks) {
    if (check.type === "port") {
      const nc = sshExec(deviceKey, `ss -tln | grep :${check.port} | head -1`);
      result.services[check.name] = nc ? "listening" : "not_listening";
    }
  }

  return result;
}

function probeEsp32Nodes() {
  // Query nodes via Rock Pi (only Rock Pi can reach 10.0.50.x)
  const rockpi = DEVICES["rockpi"];
  const nodes = ESP32_NODES.map(n => ({ ...n, reachable: false, status: "unknown" }));

  // Batch ping all deployed nodes from Rock Pi
  for (const node of nodes) {
    if (node.deployed === false) {
      node.status = "not_deployed";
      continue;
    }
    const ping = sshExec("rockpi",
      `ping -c 1 -W 2 ${node.ip} 2>/dev/null | grep -c '1 received'`);
    node.reachable = ping === "1";
    node.status = node.reachable ? "online" : "offline";
  }

  // Check hub's view of connected nodes
  const hubLog = sshExec("rockpi",
    "journalctl -u ozzu-positioning --no-pager -n 20 --output=short-iso 2>/dev/null | tail -20");
  if (hubLog) {
    for (const node of nodes) {
      if (hubLog.includes(node.ip)) {
        node.lastSeenInHub = true;
      }
    }
  }

  return nodes;
}

function probeGcpLocal() {
  const gcp = {
    hostname: execQuiet("hostname") || "unknown",
    uptime: execQuiet("uptime -p") || "unknown",
    resources: {},
    docker: [],
  };

  // Disk
  const disk = execQuiet("df -h / | tail -1");
  if (disk) {
    const parts = disk.split(/\s+/);
    gcp.resources.disk = { size: parts[1], used: parts[2], avail: parts[3], pct: parts[4] };
  }

  // Memory
  const mem = execQuiet("free -m | grep Mem | awk '{print $2,$3,$4}'");
  if (mem) {
    const [total, used, free] = mem.split(" ").map(Number);
    gcp.resources.memory = { totalMb: total, usedMb: used, freeMb: free };
  }

  // CPU load
  const load = execQuiet("cat /proc/loadavg");
  if (load) {
    const parts = load.split(" ");
    gcp.resources.cpu = { load1m: parts[0], load5m: parts[1], load15m: parts[2] };
  }

  // Docker containers
  const docker = execQuiet("docker ps --format '{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null");
  if (docker) {
    gcp.docker = docker.split("\n").filter(Boolean).map(line => {
      const [name, status, ports] = line.split("|");
      return { name, status, ports: ports || "" };
    });
  }

  return gcp;
}

function probePositioningHub() {
  // Get hub-specific state from Rock Pi
  const hub = {
    service: "unknown",
    config: null,
    lastOutput: null,
    irkStore: null,
  };

  // Service status
  hub.service = sshExec("rockpi", "systemctl is-active ozzu-positioning 2>/dev/null") || "unreachable";

  // Hub config
  const config = sshExec("rockpi", "cat /opt/ozzu-positioning/hub.yaml 2>/dev/null | head -30");
  if (config) hub.config = config;

  // Recent hub output
  const output = sshExec("rockpi",
    "journalctl -u ozzu-positioning --no-pager -n 5 --output=short-iso 2>/dev/null");
  if (output) hub.lastOutput = output;

  // IRK store
  const irk = sshExec("rockpi", "cat /opt/ozzu-positioning/irk_store.json 2>/dev/null");
  hub.irkStore = irk ? "exists" : "not_found";

  // OTA firmware
  const ota = sshExec("rockpi", "ls -la /opt/ozzu-ota/firmware.bin 2>/dev/null");
  hub.otaFirmware = ota || "not_found";

  // hostapd — AP status
  const hostapd = sshExec("rockpi", "hostapd_cli status 2>/dev/null | head -10");
  hub.wifiAp = hostapd || sshExec("rockpi", "systemctl status hostapd --no-pager 2>/dev/null | head -5") || "unknown";

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
      status: "unknown_rockpi_down",
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
  if (!_state) {
    // First call — do a synchronous update
    updateState();
  }
  return _state;
}

function getQuickState() {
  // Return cached state without re-probing
  return _state || { timestamp: null, error: "No state yet — monitor not started" };
}

function start() {
  if (_timer) return;
  console.log("[infra-monitor] Starting — probing every 60s");
  // Initial probe
  try { updateState(); } catch (e) { console.error("[infra-monitor] Initial probe error:", e.message); }
  // Schedule recurring
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
