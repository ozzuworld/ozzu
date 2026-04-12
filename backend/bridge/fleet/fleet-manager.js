/**
 * Fleet Manager — manages Redroid device fleet, proxies, and accounts
 * Handles device lifecycle, health checks, proxy routing, and account assignments.
 *
 * Directive: dir_1776018900117
 */
"use strict";

const { execSync, exec } = require("child_process");
const { Pool } = require("pg");

const pool = new Pool({
  host: "127.0.0.1", port: 5432, database: "ozzu",
  user: "ozzu", password: process.env.POSTGRES_PASSWORD || "ozzu",
});

// ADB binary — use /app/adb (Google platform-tools) if available, otherwise system adb
const ADB_BIN = require("fs").existsSync("/app/adb") ? "/app/adb" : "adb";

function adbExec(port, cmd, opts = {}) {
  const timeout = opts.timeout || 10000;
  const encoding = opts.encoding || "utf8";
  const maxBuffer = opts.maxBuffer || 10 * 1024 * 1024;
  return execSync(`${ADB_BIN} -s localhost:${port} ${cmd}`, { encoding, timeout, maxBuffer });
}
function adbExecRaw(port, cmd, opts = {}) {
  const timeout = opts.timeout || 10000;
  const maxBuffer = opts.maxBuffer || 10 * 1024 * 1024;
  return execSync(`${ADB_BIN} -s localhost:${port} ${cmd}`, { timeout, maxBuffer });
}
function hostExec(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", timeout: opts.timeout || 10000 });
}
const COMPOSE_FILE = __dirname + "/docker-compose.fleet.yml";

// ── Device Management ──

async function listDevices() {
  const res = await pool.query(`
    SELECT d.*, p.name as proxy_name, p.exit_ip as proxy_ip, p.status as proxy_status,
      (SELECT COUNT(*) FROM fleet_accounts a WHERE a.device_id = d.id) as account_count
    FROM fleet_devices d
    LEFT JOIN fleet_proxies p ON d.proxy_id = p.id
    ORDER BY d.id
  `);
  return res.rows;
}

async function getDevice(nameOrId) {
  const col = typeof nameOrId === "number" ? "id" : "name";
  const res = await pool.query(`SELECT * FROM fleet_devices WHERE ${col} = $1`, [nameOrId]);
  return res.rows[0] || null;
}

async function registerDevice(name, containerName, adbPort, fingerprint = {}) {
  const res = await pool.query(`
    INSERT INTO fleet_devices (name, container_name, adb_port, fingerprint)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (name) DO UPDATE SET
      container_name = $2, adb_port = $3, fingerprint = $4
    RETURNING *
  `, [name, containerName, adbPort, JSON.stringify(fingerprint)]);
  return res.rows[0];
}

async function startDevice(name) {
  const device = await getDevice(name);
  if (!device) throw new Error(`Device ${name} not found`);

  try {
    hostExec(`docker compose -f ${COMPOSE_FILE} up -d ${name}`, { timeout: 60000 });
    // Wait for ADB
    let ready = false;
    for (let i = 0; i < 15; i++) {
      try {
        adbExec(device.adb_port, "shell echo ok", { timeout: 5000 });
        ready = true;
        break;
      } catch { await new Promise(r => setTimeout(r, 3000)); }
    }
    const status = ready ? "running" : "booting";
    await pool.query(`UPDATE fleet_devices SET status = $2, last_health = NOW(), health_ok = $3 WHERE id = $1`,
      [device.id, status, ready]);
    return { ...device, status };
  } catch (err) {
    await pool.query(`UPDATE fleet_devices SET status = 'error' WHERE id = $1`, [device.id]);
    throw err;
  }
}

async function stopDevice(name) {
  const device = await getDevice(name);
  if (!device) throw new Error(`Device ${name} not found`);
  try {
    hostExec(`docker stop ${device.container_name}`, { timeout: 30000 });
  } catch {}
  await pool.query(`UPDATE fleet_devices SET status = 'stopped', health_ok = false WHERE id = $1`, [device.id]);
  return { ...device, status: "stopped" };
}

async function checkDeviceHealth(name) {
  const device = await getDevice(name);
  if (!device) throw new Error(`Device ${name} not found`);

  let adbOk = false, exitIp = null;
  try {
    adbExec(device.adb_port, "shell echo ok", { timeout: 5000 });
    adbOk = true;
  } catch {}

  // Check exit IP via the device itself
  if (adbOk) {
    try {
      exitIp = adbExec(device.adb_port, 'shell "curl -s --max-time 5 https://api.ipify.org"',
        { timeout: 15000 }).trim();
    } catch {}
  }

  const status = adbOk ? "running" : "error";
  await pool.query(`
    UPDATE fleet_devices SET status = $2, health_ok = $3, exit_ip = $4, last_health = NOW() WHERE id = $1
  `, [device.id, status, adbOk, exitIp]);

  // Log health check
  await pool.query(`
    INSERT INTO fleet_health_log (device_id, proxy_id, check_type, status, exit_ip, details)
    VALUES ($1, $2, 'device', $3, $4, $5)
  `, [device.id, device.proxy_id, adbOk ? "ok" : "error", exitIp, adbOk ? null : "ADB unreachable"]);

  return { name, status, adbOk, exitIp };
}

// ── Proxy Management ──

async function listProxies() {
  const res = await pool.query(`
    SELECT p.*,
      (SELECT COUNT(*) FROM fleet_devices d WHERE d.proxy_id = p.id) as device_count
    FROM fleet_proxies p ORDER BY p.id
  `);
  return res.rows;
}

async function addProxy(name, type, vpnPeer, owner, country = "CO", city = null) {
  const res = await pool.query(`
    INSERT INTO fleet_proxies (name, type, vpn_peer, owner, country, city)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (name) DO UPDATE SET
      type = $2, vpn_peer = $3, owner = $4, country = $5, city = $6
    RETURNING *
  `, [name, type, vpnPeer, owner, country, city]);
  return res.rows[0];
}

async function assignProxy(deviceName, proxyName) {
  const device = await getDevice(deviceName);
  const proxyRes = await pool.query(`SELECT * FROM fleet_proxies WHERE name = $1`, [proxyName]);
  const proxy = proxyRes.rows[0];
  if (!device) throw new Error(`Device ${deviceName} not found`);
  if (!proxy) throw new Error(`Proxy ${proxyName} not found`);

  await pool.query(`UPDATE fleet_devices SET proxy_id = $2 WHERE id = $1`, [device.id, proxy.id]);

  // Apply iptables routing for this device's container
  await applyProxyRouting(device, proxy);

  return { device: deviceName, proxy: proxyName, message: "assigned" };
}

async function checkProxyHealth(name) {
  const res = await pool.query(`SELECT * FROM fleet_proxies WHERE name = $1`, [name]);
  const proxy = res.rows[0];
  if (!proxy) throw new Error(`Proxy ${name} not found`);

  let status = "offline", exitIp = null;

  if (proxy.type === "vpn") {
    // Check if VPN peer is connected
    try {
      const vpnStatus = hostExec("cat /var/log/openvpn/status.log 2>/dev/null || echo ''",
        { timeout: 5000 });
      if (proxy.vpn_peer && vpnStatus.includes(proxy.vpn_peer)) {
        status = "online";
      }
    } catch {}
  }

  await pool.query(`UPDATE fleet_proxies SET status = $2, last_checked = NOW(), last_ip_check = $3 WHERE id = $1`,
    [proxy.id, status, exitIp]);

  await pool.query(`
    INSERT INTO fleet_health_log (proxy_id, check_type, status, exit_ip, details)
    VALUES ($1, 'proxy', $2, $3, $4)
  `, [proxy.id, status, exitIp, null]);

  return { name, status, exitIp };
}

// ── Proxy Routing (iptables) ──

async function applyProxyRouting(device, proxy) {
  if (!proxy || proxy.type !== "vpn" || !proxy.vpn_peer) return;

  // Get container IP
  let containerIp;
  try {
    containerIp = hostExec(
      `docker inspect ${device.container_name} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'`,
      { timeout: 5000 }
    ).trim();
  } catch { return; }

  if (!containerIp) return;

  // Find the VPN peer's tunnel IP from OpenVPN status
  // For now, we use the iroute — traffic from this container goes to the VPN peer
  // which then NATs it through their home internet
  //
  // This requires:
  // 1. A SOCKS proxy or transparent proxy on the friend's router
  // 2. OR: route the container traffic through a specific VPN tunnel interface
  //
  // Simplest approach: mark packets from this container's IP and route them
  // through a specific gateway

  const mark = device.id; // use device ID as fwmark
  const table = 100 + device.id;

  try {
    // Clean old rules for this device
    hostExec(`iptables -t mangle -D PREROUTING -s ${containerIp} -j MARK --set-mark ${mark} 2>/dev/null || true`);

    // Mark packets from this container
    hostExec(`iptables -t mangle -A PREROUTING -s ${containerIp} -j MARK --set-mark ${mark}`);

    // Add routing rule: marked packets use a specific routing table
    hostExec(`ip rule del fwmark ${mark} table ${table} 2>/dev/null || true`);
    hostExec(`ip rule add fwmark ${mark} table ${table}`);

    console.log(`[fleet] Routing ${device.name} (${containerIp}) via mark ${mark} table ${table}`);
  } catch (err) {
    console.error(`[fleet] Failed to apply routing for ${device.name}: ${err.message}`);
  }
}

// ── Account Management ──

async function listAccounts(deviceId = null, platform = null) {
  let query = `SELECT a.*, d.name as device_name FROM fleet_accounts a
    LEFT JOIN fleet_devices d ON a.device_id = d.id WHERE 1=1`;
  const params = [];
  if (deviceId) { params.push(deviceId); query += ` AND a.device_id = $${params.length}`; }
  if (platform) { params.push(platform); query += ` AND a.platform = $${params.length}`; }
  query += ` ORDER BY a.id`;
  const res = await pool.query(query, params);
  return res.rows;
}

async function addAccount({ deviceId, platform, username, email, phone, displayName, owner, notes }) {
  // Check device account limit
  if (deviceId) {
    const device = await pool.query(`SELECT * FROM fleet_devices WHERE id = $1`, [deviceId]);
    if (!device.rows[0]) throw new Error("Device not found");
    const countRes = await pool.query(`SELECT COUNT(*) as cnt FROM fleet_accounts WHERE device_id = $1`, [deviceId]);
    if (parseInt(countRes.rows[0].cnt) >= device.rows[0].max_accounts) {
      throw new Error(`Device has reached max accounts (${device.rows[0].max_accounts})`);
    }
  }

  const res = await pool.query(`
    INSERT INTO fleet_accounts (device_id, platform, username, email, phone, display_name, owner, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
  `, [deviceId, platform, username, email, phone, displayName, owner, notes]);
  return res.rows[0];
}

async function updateAccount(id, updates) {
  const fields = [];
  const values = [id];
  for (const [key, val] of Object.entries(updates)) {
    const allowed = ["device_id", "status", "login_verified", "username", "email", "notes", "last_active"];
    if (allowed.includes(key)) {
      values.push(val);
      fields.push(`${key} = $${values.length}`);
    }
  }
  if (fields.length === 0) return null;
  const res = await pool.query(`UPDATE fleet_accounts SET ${fields.join(", ")} WHERE id = $1 RETURNING *`, values);
  return res.rows[0];
}

// ── Fleet Health Check (cron) ──

async function healthCheckAll() {
  const devices = await pool.query(`SELECT * FROM fleet_devices`);
  const results = [];
  for (const d of devices.rows) {
    try {
      const r = await checkDeviceHealth(d.name);
      results.push(r);
    } catch (err) {
      results.push({ name: d.name, status: "error", error: err.message });
    }
  }
  return results;
}

// ── Remote Control ──

function getRemoteControlHtml(port) {
  const ADB_CMD = `adb -s localhost:${port}`;
  return `<!DOCTYPE html>
<html><head><title>Device :${port}</title>
<style>
  body { margin:0; background:#111; display:flex; justify-content:center; align-items:center; height:100vh; flex-direction:column; }
  #screen { cursor:crosshair; max-height:90vh; border:1px solid #333; }
  #status { color:#0f0; font-family:monospace; padding:5px; }
</style></head><body>
<div id="status">Device :${port} — Click to tap, Right-click=Back, Type=keyboard input</div>
<img id="screen" />
<script>
const img = document.getElementById('screen');
const W = 1080, H = 1920;
const PORT = ${port};
function refresh() { img.src = '/fleet/remote/' + PORT + '/screenshot?' + Date.now(); }
img.onload = () => setTimeout(refresh, 300);
img.onerror = () => setTimeout(refresh, 1000);
refresh();
img.addEventListener('click', (e) => {
  const rect = img.getBoundingClientRect();
  const x = Math.round((e.clientX - rect.left) / rect.width * W);
  const y = Math.round((e.clientY - rect.top) / rect.height * H);
  fetch('/fleet/remote/' + PORT + '/tap?x=' + x + '&y=' + y);
});
img.addEventListener('contextmenu', (e) => { e.preventDefault(); fetch('/fleet/remote/' + PORT + '/back'); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Backspace') { fetch('/fleet/remote/' + PORT + '/back'); e.preventDefault(); }
  else if (e.key === 'Enter') { fetch('/fleet/remote/' + PORT + '/key?code=66'); }
  else if (e.key === 'Home') { fetch('/fleet/remote/' + PORT + '/key?code=3'); }
  else if (e.key.length === 1) { fetch('/fleet/remote/' + PORT + '/text?t=' + encodeURIComponent(e.key)); }
});
</script></body></html>`;
}

// ── Init: register existing devices ──

async function initFleet() {
  const devices = [
    { name: "redroid01", container: "redroid01", port: 5556, model: "Pixel 7", mfr: "Google", serial: "FLEET01A1B2C3", dpi: 480 },
    { name: "redroid02", container: "redroid02", port: 5557, model: "SM-S911B", mfr: "samsung", serial: "FLEET02D4E5F6", dpi: 420 },
    { name: "redroid03", container: "redroid03", port: 5558, model: "Pixel 8a", mfr: "Google", serial: "FLEET03G7H8I9", dpi: 440 },
    { name: "redroid04", container: "redroid04", port: 5559, model: "moto g84", mfr: "motorola", serial: "FLEET04J0K1L2", dpi: 400 },
    { name: "redroid05", container: "redroid05", port: 5560, model: "SM-A546E", mfr: "samsung", serial: "FLEET05M3N4O5", dpi: 460 },
  ];

  for (const d of devices) {
    await registerDevice(d.name, d.container, d.port, {
      model: d.model, manufacturer: d.mfr, serial: d.serial, dpi: d.dpi,
    });
  }

  // Register home proxy
  await addProxy("home", "vpn", "r605", "King Kazuma", "CO", "Barranquilla");

  console.log("[fleet] Initialized fleet with", devices.length, "devices");
}

module.exports = {
  listDevices, getDevice, registerDevice, startDevice, stopDevice, checkDeviceHealth,
  listProxies, addProxy, assignProxy, checkProxyHealth, applyProxyRouting,
  listAccounts, addAccount, updateAccount,
  healthCheckAll, getRemoteControlHtml, initFleet, pool,
};
