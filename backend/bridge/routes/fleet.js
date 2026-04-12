// routes/fleet.js — Device fleet management API
// Directive: dir_1776018900117
"use strict";

module.exports = function fleetRoutes(ctx) {
  const { sendJSON, parseBody } = ctx;
  const { execSync } = require("child_process");
  const fs = require("fs");
  const ADB_BIN = fs.existsSync("/app/adb") ? "/app/adb" : "adb";
  function adb(port, cmd, opts = {}) {
    return execSync(`${ADB_BIN} -s localhost:${port} ${cmd}`, opts);
  }
  const fleet = (() => { try { return require("../fleet/fleet-manager"); } catch(e) { console.error("[fleet] Load error:", e.message); return null; } })();

  return async function handleFleetRoutes(req, res, pathname, url) {
    if (!pathname.startsWith("/fleet")) return false;
    if (!fleet) { sendJSON(res, 500, { error: "Fleet manager not loaded" }); return true; }

    // ── Devices ──

    // GET /fleet/devices — list all devices with proxy info
    if (req.method === "GET" && pathname === "/fleet/devices") {
      const devices = await fleet.listDevices();
      sendJSON(res, 200, devices);
      return true;
    }

    // POST /fleet/devices — register a device
    if (req.method === "POST" && pathname === "/fleet/devices") {
      const body = await parseBody(req);
      const device = await fleet.registerDevice(body.name, body.container_name, body.adb_port, body.fingerprint || {});
      sendJSON(res, 201, device);
      return true;
    }

    // POST /fleet/devices/:name/start — start a device
    const startMatch = pathname.match(/^\/fleet\/devices\/([^/]+)\/start$/);
    if (req.method === "POST" && startMatch) {
      try {
        const result = await fleet.startDevice(startMatch[1]);
        sendJSON(res, 200, result);
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // POST /fleet/devices/:name/stop — stop a device
    const stopMatch = pathname.match(/^\/fleet\/devices\/([^/]+)\/stop$/);
    if (req.method === "POST" && stopMatch) {
      try {
        const result = await fleet.stopDevice(stopMatch[1]);
        sendJSON(res, 200, result);
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // GET /fleet/devices/:name/health — health check a device
    const healthMatch = pathname.match(/^\/fleet\/devices\/([^/]+)\/health$/);
    if (req.method === "GET" && healthMatch) {
      try {
        const result = await fleet.checkDeviceHealth(healthMatch[1]);
        sendJSON(res, 200, result);
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // POST /fleet/devices/:name/assign-proxy — assign proxy to device
    const assignMatch = pathname.match(/^\/fleet\/devices\/([^/]+)\/assign-proxy$/);
    if (req.method === "POST" && assignMatch) {
      try {
        const body = await parseBody(req);
        const result = await fleet.assignProxy(assignMatch[1], body.proxy);
        sendJSON(res, 200, result);
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // ── Proxies ──

    // GET /fleet/proxies
    if (req.method === "GET" && pathname === "/fleet/proxies") {
      const proxies = await fleet.listProxies();
      sendJSON(res, 200, proxies);
      return true;
    }

    // POST /fleet/proxies
    if (req.method === "POST" && pathname === "/fleet/proxies") {
      const body = await parseBody(req);
      const proxy = await fleet.addProxy(body.name, body.type || "vpn", body.vpn_peer, body.owner, body.country || "CO", body.city);
      sendJSON(res, 201, proxy);
      return true;
    }

    // GET /fleet/proxies/:name/health
    const proxyHealthMatch = pathname.match(/^\/fleet\/proxies\/([^/]+)\/health$/);
    if (req.method === "GET" && proxyHealthMatch) {
      try {
        const result = await fleet.checkProxyHealth(proxyHealthMatch[1]);
        sendJSON(res, 200, result);
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // ── Accounts ──

    // GET /fleet/accounts?device_id=&platform=
    if (req.method === "GET" && pathname === "/fleet/accounts") {
      const deviceId = url.searchParams.get("device_id");
      const platform = url.searchParams.get("platform");
      const accounts = await fleet.listAccounts(deviceId ? parseInt(deviceId) : null, platform);
      sendJSON(res, 200, accounts);
      return true;
    }

    // POST /fleet/accounts
    if (req.method === "POST" && pathname === "/fleet/accounts") {
      try {
        const body = await parseBody(req);
        const account = await fleet.addAccount({
          deviceId: body.device_id, platform: body.platform,
          username: body.username, email: body.email, phone: body.phone,
          displayName: body.display_name, owner: body.owner, notes: body.notes,
        });
        sendJSON(res, 201, account);
      } catch (err) { sendJSON(res, 400, { error: err.message }); }
      return true;
    }

    // PATCH /fleet/accounts/:id
    const accountMatch = pathname.match(/^\/fleet\/accounts\/(\d+)$/);
    if (req.method === "PATCH" && accountMatch) {
      const body = await parseBody(req);
      const account = await fleet.updateAccount(parseInt(accountMatch[1]), body);
      sendJSON(res, 200, account || { error: "not found" });
      return true;
    }

    // ── Fleet-wide ──

    // POST /fleet/init — register all devices and home proxy
    if (req.method === "POST" && pathname === "/fleet/init") {
      await fleet.initFleet();
      sendJSON(res, 200, { message: "Fleet initialized" });
      return true;
    }

    // GET /fleet/health — health check all devices
    if (req.method === "GET" && pathname === "/fleet/health") {
      const results = await fleet.healthCheckAll();
      sendJSON(res, 200, results);
      return true;
    }

    // GET /fleet/status — overview dashboard
    if (req.method === "GET" && pathname === "/fleet/status") {
      const devices = await fleet.listDevices();
      const proxies = await fleet.listProxies();
      const accounts = await fleet.listAccounts();
      sendJSON(res, 200, {
        devices: { total: devices.length, running: devices.filter(d => d.status === "running").length },
        proxies: { total: proxies.length, online: proxies.filter(p => p.status === "online").length },
        accounts: { total: accounts.length, active: accounts.filter(a => a.status === "active").length },
        devices_detail: devices,
        proxies_detail: proxies,
      });
      return true;
    }

    // ── Remote Control ──

    // GET /fleet/remote/:port — interactive web control
    const remoteMatch = pathname.match(/^\/fleet\/remote\/(\d+)$/);
    if (req.method === "GET" && remoteMatch) {
      const port = parseInt(remoteMatch[1]);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fleet.getRemoteControlHtml(port));
      return true;
    }

    // GET /fleet/remote/:port/screenshot
    const ssMatch = pathname.match(/^\/fleet\/remote\/(\d+)\/screenshot$/);
    if (req.method === "GET" && ssMatch) {
      const port = parseInt(ssMatch[1]);
      try {
        adb(port, "shell screencap -p /sdcard/screen.png", { timeout: 5000 });
        const png = adb(port, "exec-out cat /sdcard/screen.png", { timeout: 5000, maxBuffer: 10*1024*1024 });
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
        res.end(png);
      } catch { res.writeHead(500); res.end("error"); }
      return true;
    }

    // GET /fleet/remote/:port/tap?x=&y=
    const tapMatch = pathname.match(/^\/fleet\/remote\/(\d+)\/tap$/);
    if (req.method === "GET" && tapMatch) {
      const port = parseInt(tapMatch[1]);
      const x = parseInt(url.searchParams.get("x")), y = parseInt(url.searchParams.get("y"));
      try { adb(port, `shell input tap ${x} ${y}`, { timeout: 5000 }); } catch {}
      sendJSON(res, 200, { ok: true });
      return true;
    }

    // GET /fleet/remote/:port/back
    const backMatch = pathname.match(/^\/fleet\/remote\/(\d+)\/back$/);
    if (req.method === "GET" && backMatch) {
      const port = parseInt(backMatch[1]);
      try { adb(port, "shell input keyevent 4", { timeout: 5000 }); } catch {}
      sendJSON(res, 200, { ok: true });
      return true;
    }

    // GET /fleet/remote/:port/key?code=
    const keyMatch = pathname.match(/^\/fleet\/remote\/(\d+)\/key$/);
    if (req.method === "GET" && keyMatch) {
      const port = parseInt(keyMatch[1]);
      const code = parseInt(url.searchParams.get("code"));
      try { adb(port, `shell input keyevent ${code}`, { timeout: 5000 }); } catch {}
      sendJSON(res, 200, { ok: true });
      return true;
    }

    // GET /fleet/remote/:port/text?t=
    const textMatch = pathname.match(/^\/fleet\/remote\/(\d+)\/text$/);
    if (req.method === "GET" && textMatch) {
      const port = parseInt(textMatch[1]);
      const t = url.searchParams.get("t") || "";
      try { adb(port, `shell input text '${t.replace(/'/g, "'\\''")}'`, { timeout: 5000 }); } catch {}
      sendJSON(res, 200, { ok: true });
      return true;
    }

    // GET /fleet/remote — list all devices with remote links
    if (req.method === "GET" && pathname === "/fleet/remote") {
      const devices = await fleet.listDevices();
      const html = `<!DOCTYPE html><html><head><title>Fleet Remote</title>
<style>body{background:#111;color:#eee;font-family:monospace;padding:20px}
a{color:#4af;text-decoration:none;font-size:18px}a:hover{text-decoration:underline}
.device{padding:10px;margin:5px;border:1px solid #333;border-radius:5px;display:inline-block}
.running{border-color:#0f0}.stopped{border-color:#f00}</style></head><body>
<h1>Ozzu Fleet Remote Control</h1>
${devices.map(d => `<div class="device ${d.status}">
  <a href="/fleet/remote/${d.adb_port}">${d.name}</a><br/>
  <small>${d.fingerprint?.model || "?"} | ${d.status} | IP: ${d.exit_ip || "?"} | ${d.account_count || 0} accounts</small>
</div>`).join("\n")}
</body></html>`;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return true;
    }

    return false;
  };
};
