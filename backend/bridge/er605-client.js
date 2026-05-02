// er605-client.js — TP-Link ER605 Omada Router API client
// Handles RSA-encrypted auth (TP-Link custom no-padding scheme)
// Queries DHCP, WAN, VPN, system status via JSON API

"use strict";

const https = require("https");
const crypto = require("crypto");
const { getDevice } = require("./lib/devices");

const _r605 = getDevice("r605");
const ROUTER_IP = _r605.lan_ip;
const USERNAME = _r605.ssh_user;
const PASSWORD = process.env[_r605.ssh_secret_var || "R605_SSH_PASS"] || "";
const BASE_URL = `https://${ROUTER_IP}`;
const REFERER_LOGIN = `${BASE_URL}/webpages/login.html`;
const REFERER_INDEX = `${BASE_URL}/webpages/index.html`;

// Reusable TLS agent (self-signed cert)
const agent = new https.Agent({ rejectUnauthorized: false });

let _stok = null;
let _cookies = [];
let _stokExpiry = 0;
let _loginPromise = null; // mutex to prevent concurrent logins
const STOK_TTL = 4 * 60 * 1000; // refresh stok every 4 minutes (ER605 timeout is ~5min)

// ── HTTP helpers ──

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: options.method || "GET",
      agent,
      headers: {
        "Referer": options.referer || REFERER_INDEX,
        ...options.headers,
      },
      timeout: 10000,
    };

    if (_cookies.length > 0 && !options.noCookies) {
      opts.headers["Cookie"] = _cookies.join("; ");
    }

    if (options.body) {
      opts.headers["Content-Length"] = Buffer.byteLength(options.body);
    }

    const req = https.request(opts, (res) => {
      // Capture Set-Cookie
      if (res.headers["set-cookie"]) {
        for (const c of res.headers["set-cookie"]) {
          const name = c.split("=")[0];
          _cookies = _cookies.filter(cc => !cc.startsWith(name + "="));
          _cookies.push(c.split(";")[0]);
        }
      }

      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data, error: "not_json" }); }
      });
    });

    req.on("error", (e) => reject(e));
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ── TP-Link RSA encryption (custom no-padding scheme) ──

function tplinkEncrypt(password, nHex, eHex) {
  const n = BigInt("0x" + nHex);
  const e = BigInt("0x" + eHex);
  const keyLen = Math.ceil(nHex.length / 2);

  // Convert password to bytes, pad with zeros to key length
  const ba = Buffer.alloc(keyLen, 0);
  for (let i = 0; i < password.length && i < keyLen; i++) {
    ba[i] = password.charCodeAt(i);
  }

  // Convert to BigInt
  const m = BigInt("0x" + ba.toString("hex"));

  // Raw RSA: c = m^e mod n
  const c = modPow(m, e, n);

  // Return as zero-padded hex string
  return c.toString(16).padStart(keyLen * 2, "0");
}

function modPow(base, exp, mod) {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) {
      result = (result * base) % mod;
    }
    exp = exp >> 1n;
    base = (base * base) % mod;
  }
  return result;
}

// ── Auth ──

async function login() {
  // Step 1: Get RSA public key
  const keysUrl = `${BASE_URL}/cgi-bin/luci/;stok=/login?form=login`;
  const keysBody = "data=" + encodeURIComponent(JSON.stringify({ method: "get" }));

  const keysResp = await httpsRequest(keysUrl, {
    method: "POST",
    referer: REFERER_LOGIN,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: keysBody,
  });

  if (!keysResp.result?.password) {
    throw new Error("Failed to get RSA keys: " + JSON.stringify(keysResp));
  }

  const [nHex, eHex] = keysResp.result.password;

  // Step 2: Encrypt password
  const encryptedPassword = tplinkEncrypt(PASSWORD, nHex, eHex);

  // Step 3: Login
  const loginUrl = `${BASE_URL}/cgi-bin/luci/;stok=/login?form=login`;
  const loginBody = "data=" + encodeURIComponent(JSON.stringify({
    method: "login",
    params: { username: USERNAME, password: encryptedPassword },
  }));

  const loginResp = await httpsRequest(loginUrl, {
    method: "POST",
    referer: REFERER_LOGIN,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: loginBody,
  });

  if (!loginResp.result?.stok) {
    throw new Error("Login failed: " + JSON.stringify(loginResp));
  }

  _stok = loginResp.result.stok;
  _stokExpiry = Date.now() + STOK_TTL;
  return _stok;
}

async function ensureAuth() {
  if (!_stok || Date.now() > _stokExpiry) {
    // Mutex: if a login is already in progress, wait for it
    if (_loginPromise) {
      await _loginPromise;
      return;
    }
    _loginPromise = login().finally(() => { _loginPromise = null; });
    await _loginPromise;
  }
}

// ── API query ──

async function query(endpoint, method = "get", params = null) {
  await ensureAuth();

  const url = `${BASE_URL}/cgi-bin/luci/;stok=${_stok}/${endpoint}`;
  const payload = { method };
  if (params) payload.params = params;

  const body = "data=" + encodeURIComponent(JSON.stringify(payload));

  try {
    const resp = await httpsRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    // Token expired — re-auth and retry once
    if (resp.error_code === -40401 || resp.error_code === -40101) {
      _stok = null;
      await ensureAuth();
      const retryUrl = `${BASE_URL}/cgi-bin/luci/;stok=${_stok}/${endpoint}`;
      return await httpsRequest(retryUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    }

    return resp;
  } catch (e) {
    return { error: e.message };
  }
}

// ── High-level queries ──

async function getFullState() {
  const state = {
    timestamp: new Date().toISOString(),
    model: null,
    firmware: null,
    uptime: null,
    cpu: null,
    wan: {},
    dhcp: { clients: [], settings: null },
    vpn: { openvpn: null },
    lan: null,
    system: null,
  };

  try {
    // Force fresh login — ER605 invalidates sessions between probe cycles
    _stok = null;
    await ensureAuth();

    // Parallel queries for speed
    const [firmware, wanMode, dhcpClients, dhcpSettings, ovpnClient, ovpnServer,
           cpuNum, timeRun, wanConfig, interfaceStatus, natAlg, switchMirror] = await Promise.all([
      query("admin/firmware?form=upgrade"),
      query("admin/interface_wan?form=wanmode"),
      query("admin/dhcps?form=client"),
      query("admin/dhcps?form=setting"),
      query("admin/openvpn?form=client"),
      query("admin/openvpn?form=server"),
      query("admin/sys_status?form=cpu_num"),
      query("admin/status?form=time_run"),
      query("admin/interface_wan?form=wanconfig"),
      query("admin/interface?form=status2"),
      query("admin/nat?form=alg"),
      query("admin/switch?form=mirror"),
    ]);

    // Firmware/model
    if (firmware.result) {
      state.model = firmware.result.product_name || firmware.result.model;
      state.firmware = firmware.result.firmware_version;
      state.hardware = firmware.result.hardware_version;
      state.macLan = firmware.result.mac;
    }

    // WAN mode
    if (wanMode.result) state.wan.mode = wanMode.result;

    // WAN status per port
    if (interfaceStatus.result) state.wan.interfaces = interfaceStatus.result;

    // WAN config
    if (wanConfig.result) state.wan.config = wanConfig.result;

    // DHCP — result is directly an array
    if (dhcpClients.result) {
      state.dhcp.clients = Array.isArray(dhcpClients.result) ? dhcpClients.result : [];
    }
    if (dhcpSettings.result) state.dhcp.settings = dhcpSettings.result;

    // VPN
    if (ovpnClient.result) state.vpn.openvpnClient = ovpnClient.result;
    if (ovpnServer.result) state.vpn.openvpnServer = ovpnServer.result;

    // CPU
    if (cpuNum.result) state.cpu = cpuNum.result;

    // System time/uptime
    if (timeRun.result) state.uptime = timeRun.result;

    // NAT
    if (natAlg.result) state.nat = natAlg.result;

  } catch (e) {
    state.error = e.message;
  }

  return state;
}

async function getDhcpClients() {
  const resp = await query("admin/dhcps?form=client");
  return resp.result?.client_list || resp.result || [];
}

async function getWanStatus() {
  const resp = await query("admin/interface?form=status2");
  return resp.result || {};
}

async function getVpnStatus() {
  const [client, server] = await Promise.all([
    query("admin/openvpn?form=client"),
    query("admin/openvpn?form=server"),
  ]);
  return {
    client: client.result || {},
    server: server.result || {},
  };
}

async function getSystemInfo() {
  const [firmware, timeRun, cpu] = await Promise.all([
    query("admin/firmware?form=upgrade"),
    query("admin/status?form=time_run"),
    query("admin/sys_status?form=cpu_num"),
  ]);
  return {
    firmware: firmware.result || {},
    time: timeRun.result || {},
    cpu: cpu.result || {},
  };
}

module.exports = {
  login,
  query,
  getFullState,
  getDhcpClients,
  getWanStatus,
  getVpnStatus,
  getSystemInfo,
};
