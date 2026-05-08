// octoprint-client.js — OctoPrint REST client
// Directive: dir_1778272304525
//
// Maintains a session against the Octo4a OctoPrint server on the tablet (10.9.0.7).
// Because tablet:5000 is not externally reachable on the WG (Android-side
// behavior), we tunnel via `adb forward tcp:5500 tcp:5000` and talk to
// localhost:5500 from the bridge.
"use strict";

const http = require("http");
const fs = require("fs");
const { execSync, spawn } = require("child_process");
const path = require("path");

const ADB_BIN = fs.existsSync("/app/adb") ? "/app/adb" : "adb";
const TABLET_ADDR = process.env.OCTOPRINT_TABLET_ADB || "10.9.0.7:5555";
const FORWARD_PORT = parseInt(process.env.OCTOPRINT_FORWARD_PORT || "5500", 10);
const TABLET_PORT = parseInt(process.env.OCTOPRINT_TABLET_PORT || "5000", 10);
const BASE_URL = process.env.OCTOPRINT_URL || `http://localhost:${FORWARD_PORT}`;
const USER = process.env.OCTOPRINT_USER || "hadmin";
const PASS = process.env.OCTOPRINT_PASS || "";
const PRINTER_PORT = process.env.OCTOPRINT_PRINTER_PORT || "/dev/ttyOcto4a";
const PRINTER_BAUD = parseInt(process.env.OCTOPRINT_BAUDRATE || "115200", 10);

let _session = null; // { csrf, cookie, expires }

function adb(args, opts = {}) {
  return execSync(`${ADB_BIN} ${args}`, { encoding: "utf8", ...opts });
}

function ensureAdbForward() {
  try {
    adb(`connect ${TABLET_ADDR}`);
  } catch (_) { /* may already be connected */ }
  try {
    const out = adb("forward --list").toString();
    if (out.includes(`tcp:${FORWARD_PORT}`)) return true;
  } catch (_) {}
  try {
    adb(`-s ${TABLET_ADDR} forward tcp:${FORWARD_PORT} tcp:${TABLET_PORT}`);
    return true;
  } catch (e) {
    return false;
  }
}

function http_request({ method = "GET", url, headers = {}, body = null, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const setCookies = res.headers["set-cookie"] || [];
        resolve({ status: res.statusCode, headers: res.headers, body: buf, setCookies });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    if (body) req.write(body);
    req.end();
  });
}

function parseCsrfFromSetCookies(setCookies, port = FORWARD_PORT) {
  // OctoPrint sets `csrf_token_PNNNN=<value>; ...`
  const cookieName = `csrf_token_P${port}`;
  for (const c of setCookies) {
    const m = c.match(new RegExp(`${cookieName}=([^;]+)`));
    if (m) return m[1];
  }
  return null;
}

async function login() {
  ensureAdbForward();
  if (!PASS) throw new Error("OCTOPRINT_PASS not configured");

  // 1. GET / to obtain csrf cookie
  const initial = await http_request({ url: `${BASE_URL}/` });
  const csrf = parseCsrfFromSetCookies(initial.setCookies);
  if (!csrf) throw new Error("could not obtain csrf token from initial GET /");

  // Build cookie jar from set-cookies
  const cookieJar = initial.setCookies.map(c => c.split(";")[0]).join("; ");

  // 2. POST /api/login with csrf header + cookies
  const loginRes = await http_request({
    method: "POST",
    url: `${BASE_URL}/api/login`,
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
      "Cookie": cookieJar,
    },
    body: JSON.stringify({ user: USER, pass: PASS, remember: true }),
  });

  if (loginRes.status !== 200) {
    throw new Error(`octoprint login failed: HTTP ${loginRes.status} ${loginRes.body.toString().slice(0, 200)}`);
  }

  // Merge cookies from login response
  const loginCookies = loginRes.setCookies.map(c => c.split(";")[0]);
  const finalJar = [...new Set([...cookieJar.split("; "), ...loginCookies])].filter(Boolean).join("; ");
  const finalCsrf = parseCsrfFromSetCookies(loginRes.setCookies) || csrf;

  _session = {
    csrf: finalCsrf,
    cookie: finalJar,
    expires: Date.now() + 1000 * 60 * 60 * 12, // 12h
  };
  return _session;
}

async function ensureSession() {
  if (_session && _session.expires > Date.now()) return _session;
  return await login();
}

async function api(method, urlPath, body, contentType = "application/json", isFormData = false) {
  const s = await ensureSession();
  const headers = {
    "X-CSRF-Token": s.csrf,
    "Cookie": s.cookie,
  };
  let bodyBuf = null;
  if (body) {
    if (isFormData) {
      // body is { Buffer, headers } pre-built
      Object.assign(headers, body.headers);
      bodyBuf = body.buffer;
    } else {
      headers["Content-Type"] = contentType;
      bodyBuf = typeof body === "string" ? body : JSON.stringify(body);
    }
  }
  const res = await http_request({
    method,
    url: `${BASE_URL}${urlPath}`,
    headers,
    body: bodyBuf,
  });
  // 401/403 → session expired, retry once
  if ((res.status === 401 || res.status === 403) && _session) {
    _session = null;
    const s2 = await ensureSession();
    headers["X-CSRF-Token"] = s2.csrf;
    headers["Cookie"] = s2.cookie;
    return await http_request({ method, url: `${BASE_URL}${urlPath}`, headers, body: bodyBuf });
  }
  return res;
}

async function getStatus() {
  const conn = await api("GET", "/api/connection");
  const job = await api("GET", "/api/job");
  const printer = await api("GET", "/api/printer").catch(() => ({ status: 0 }));
  return {
    connection: conn.status === 200 ? JSON.parse(conn.body.toString()) : { error: conn.body.toString() },
    job: job.status === 200 ? JSON.parse(job.body.toString()) : null,
    printer: printer.status === 200 ? JSON.parse(printer.body.toString()) : null,
  };
}

async function connectPrinter() {
  const res = await api("POST", "/api/connection", {
    command: "connect",
    port: PRINTER_PORT,
    baudrate: PRINTER_BAUD,
    printerProfile: "_default",
    save: true,
    autoconnect: true,
  });
  return { ok: res.status === 204, status: res.status, body: res.body.toString().slice(0, 300) };
}

// Build a simple multipart/form-data body for file upload.
function buildFormData(filename, gcodeBuffer, fields = {}) {
  const boundary = "----octoprintform" + Math.random().toString(36).slice(2);
  const eol = "\r\n";
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}${eol}Content-Disposition: form-data; name="${k}"${eol}${eol}${v}${eol}`,
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}${eol}Content-Disposition: form-data; name="file"; filename="${filename}"${eol}` +
    `Content-Type: application/octet-stream${eol}${eol}`,
  ));
  parts.push(gcodeBuffer);
  parts.push(Buffer.from(`${eol}--${boundary}--${eol}`));
  const buffer = Buffer.concat(parts);
  return {
    buffer,
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(buffer.length),
    },
  };
}

async function uploadGcode(localPath, options = {}) {
  const filename = options.filename || path.basename(localPath);
  const buf = fs.readFileSync(localPath);
  const form = buildFormData(filename, buf, {
    select: options.select === false ? "false" : "true",
    print: options.startPrint === true ? "true" : "false",
  });
  const res = await api("POST", "/api/files/local", form, undefined, true);
  if (res.status !== 201) {
    throw new Error(`upload failed: HTTP ${res.status} ${res.body.toString().slice(0, 200)}`);
  }
  return JSON.parse(res.body.toString());
}

async function startPrint(filename) {
  const res = await api("POST", `/api/files/local/${encodeURIComponent(filename)}`, {
    command: "select",
    print: true,
  });
  return { ok: res.status === 204, status: res.status };
}

async function cancelPrint() {
  const res = await api("POST", "/api/job", { command: "cancel" });
  return { ok: res.status === 204, status: res.status };
}

module.exports = {
  ensureAdbForward,
  login,
  ensureSession,
  getStatus,
  connectPrinter,
  uploadGcode,
  startPrint,
  cancelPrint,
};
