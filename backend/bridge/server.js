#!/usr/bin/env node
// Command Bridge Server — zero-dependency Node.js HTTP server
// Bridges Claude Code hooks ↔ Gemini AI companion on the tablet

const http = require("http");
const fs = require("fs");
const path = require("path");

const crypto = require("crypto");

const PORT = 3333;
const DATA_DIR = "/tmp/ozzu-bridge";
const UPDATES_DIR = path.join(DATA_DIR, "updates");
const STATUS_FILE = path.join(DATA_DIR, "status.json");
const APPROVALS_FILE = path.join(DATA_DIR, "approvals.json");
const DIRECTIVES_FILE = path.join(DATA_DIR, "directives.json");
const MAX_STATUS_ENTRIES = 20;
const MAX_DIRECTIVES = 20;
const APPROVAL_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

const BRIDGE_PIN = process.env.BRIDGE_PIN || "1234";

// ── Storage helpers ──

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getStatusEntries() {
  return readJSON(STATUS_FILE, []);
}

function getApprovals() {
  return readJSON(APPROVALS_FILE, []);
}

function saveApprovals(approvals) {
  writeJSON(APPROVALS_FILE, approvals);
}

function getDirectives() {
  return readJSON(DIRECTIVES_FILE, []);
}

function saveDirectives(directives) {
  writeJSON(DIRECTIVES_FILE, directives);
}

// Expire old approvals — mark unresolved ones past expiry as denied
function expireApprovals(approvals) {
  const now = Date.now();
  let changed = false;
  for (const a of approvals) {
    if (!a.resolved && now - a.createdAt > APPROVAL_EXPIRY_MS) {
      a.resolved = true;
      a.approved = false;
      a.resolvedAt = now;
      a.reason = "expired";
      changed = true;
    }
  }
  if (changed) saveApprovals(approvals);
  return approvals;
}

// ── Request parsing ──

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

// ── Route handlers ──

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    sendJSON(res, 204, null);
    return;
  }

  // POST /status — Claude Code posts activity
  if (req.method === "POST" && pathname === "/status") {
    const data = await parseBody(req);
    const entry = {
      event: data.event || "unknown",
      tool: data.tool || "",
      message: data.message || "",
      timestamp: data.timestamp || new Date().toISOString(),
    };
    const entries = getStatusEntries();
    entries.push(entry);
    // Keep only latest N
    while (entries.length > MAX_STATUS_ENTRIES) entries.shift();
    writeJSON(STATUS_FILE, entries);
    sendJSON(res, 200, { ok: true });
    return;
  }

  // GET /status — Tablet fetches activity log
  if (req.method === "GET" && pathname === "/status") {
    sendJSON(res, 200, getStatusEntries());
    return;
  }

  // POST /approvals — Claude Code creates a pending approval
  if (req.method === "POST" && pathname === "/approvals") {
    const data = await parseBody(req);
    const approval = {
      id: data.id || `apr_${Date.now()}`,
      tool: data.tool || "",
      description: data.description || "",
      risk: data.risk || "medium",
      resolved: false,
      approved: false,
      createdAt: Date.now(),
    };
    const approvals = getApprovals();
    approvals.push(approval);
    saveApprovals(approvals);
    sendJSON(res, 200, { ok: true, id: approval.id });
    return;
  }

  // GET /approvals — List pending approvals
  if (req.method === "GET" && pathname === "/approvals") {
    const approvals = expireApprovals(getApprovals());
    const pending = approvals.filter((a) => !a.resolved);
    sendJSON(res, 200, pending);
    return;
  }

  // POST /approvals/:id/resolve — Resolve an approval
  const resolveMatch = pathname.match(/^\/approvals\/([^/]+)\/resolve$/);
  if (req.method === "POST" && resolveMatch) {
    const id = resolveMatch[1];
    const data = await parseBody(req);

    // Validate PIN
    if (data.pin !== BRIDGE_PIN) {
      sendJSON(res, 403, { error: "Invalid PIN" });
      return;
    }

    const approvals = getApprovals();
    const approval = approvals.find((a) => a.id === id);
    if (!approval) {
      sendJSON(res, 404, { error: "Approval not found" });
      return;
    }
    if (approval.resolved) {
      sendJSON(res, 409, { error: "Already resolved" });
      return;
    }

    approval.resolved = true;
    approval.approved = !!data.approved;
    approval.resolvedAt = Date.now();
    saveApprovals(approvals);
    sendJSON(res, 200, { ok: true, approved: approval.approved });
    return;
  }

  // GET /approvals/:id/poll — Hook polls for resolution
  const pollMatch = pathname.match(/^\/approvals\/([^/]+)\/poll$/);
  if (req.method === "GET" && pollMatch) {
    const id = pollMatch[1];
    const approvals = expireApprovals(getApprovals());
    const approval = approvals.find((a) => a.id === id);
    if (!approval) {
      sendJSON(res, 404, { error: "Approval not found" });
      return;
    }
    sendJSON(res, 200, {
      resolved: approval.resolved,
      approved: approval.approved,
    });
    return;
  }

  // POST /directives — June creates a directive
  if (req.method === "POST" && pathname === "/directives") {
    const data = await parseBody(req);
    const validTypes = ["quick", "feature", "explore"];
    if (!data.type || !validTypes.includes(data.type)) {
      sendJSON(res, 400, { error: "type must be one of: quick, feature, explore" });
      return;
    }
    if (!data.description) {
      sendJSON(res, 400, { error: "description is required" });
      return;
    }
    const directive = {
      id: `dir_${Date.now()}`,
      type: data.type,
      title: data.title || "",
      description: data.description,
      status: "pending",
      plan: null,
      directiveApprovalId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const directives = getDirectives();
    directives.push(directive);
    while (directives.length > MAX_DIRECTIVES) directives.shift();
    saveDirectives(directives);
    sendJSON(res, 200, { ok: true, directive });
    return;
  }

  // GET /directives — List directives (optional ?status= filter)
  if (req.method === "GET" && pathname === "/directives") {
    const statusFilter = url.searchParams.get("status");
    let directives = getDirectives();
    if (statusFilter) {
      directives = directives.filter((d) => d.status === statusFilter);
    }
    sendJSON(res, 200, directives);
    return;
  }

  // GET /directives/:id — Single directive with full plan text
  const directiveGetMatch = pathname.match(/^\/directives\/([^/]+)$/);
  if (req.method === "GET" && directiveGetMatch) {
    const id = directiveGetMatch[1];
    const directives = getDirectives();
    const directive = directives.find((d) => d.id === id);
    if (!directive) {
      sendJSON(res, 404, { error: "Directive not found" });
      return;
    }
    sendJSON(res, 200, directive);
    return;
  }

  // PATCH /directives/:id — Update directive (status, plan, title)
  const directivePatchMatch = pathname.match(/^\/directives\/([^/]+)$/);
  if (req.method === "PATCH" && directivePatchMatch) {
    const id = directivePatchMatch[1];
    const data = await parseBody(req);
    const directives = getDirectives();
    const directive = directives.find((d) => d.id === id);
    if (!directive) {
      sendJSON(res, 404, { error: "Directive not found" });
      return;
    }

    // Apply updates
    if (data.status) directive.status = data.status;
    if (data.plan !== undefined) directive.plan = data.plan;
    if (data.title) directive.title = data.title;
    directive.updatedAt = Date.now();

    // Auto-create plan-approval when a feature directive reaches "planned" with a plan
    if (directive.type === "feature" && directive.status === "planned" && directive.plan) {
      const approvalId = `apr_plan_${directive.id}`;
      const approval = {
        id: approvalId,
        tool: "directive_plan",
        description: `Plan for: ${directive.title || directive.description.substring(0, 80)}`,
        risk: "high",
        directiveId: directive.id,
        resolved: false,
        approved: false,
        createdAt: Date.now(),
      };
      const approvals = getApprovals();
      approvals.push(approval);
      saveApprovals(approvals);
      directive.directiveApprovalId = approvalId;
    }

    saveDirectives(directives);
    sendJSON(res, 200, { ok: true, directive });
    return;
  }

  // ── OTA Update endpoints ──

  // GET /api/manifest — Expo Updates protocol v1
  if (req.method === "GET" && pathname === "/api/manifest") {
    const platform = req.headers["expo-platform"] || "android";
    const runtimeVersion = req.headers["expo-runtime-version"] || "1.0.0";
    const currentUpdateId = req.headers["expo-current-update-id"];

    const updateDir = path.join(UPDATES_DIR, runtimeVersion);
    const metadataPath = path.join(updateDir, "metadata.json");

    if (!fs.existsSync(metadataPath)) {
      // No update available — return directive
      const boundary = "ota-boundary";
      res.writeHead(200, {
        "expo-protocol-version": "1",
        "expo-sfv-version": "0",
        "cache-control": "private, max-age=0",
        "content-type": `multipart/mixed; boundary=${boundary}`,
        "Access-Control-Allow-Origin": "*",
      });
      res.end(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="directive"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        `{"type":"noUpdateAvailable"}\r\n` +
        `--${boundary}--\r\n`
      );
      return;
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const platformMeta = metadata.fileMetadata?.[platform];
    if (!platformMeta) {
      sendJSON(res, 404, { error: `No ${platform} update found` });
      return;
    }

    // Compute update ID from metadata
    const metaHash = crypto.createHash("sha256").update(fs.readFileSync(metadataPath)).digest("hex");
    const updateId = `${metaHash.slice(0,8)}-${metaHash.slice(8,12)}-${metaHash.slice(12,16)}-${metaHash.slice(16,20)}-${metaHash.slice(20,32)}`;

    // If client already has this update, return no-update
    if (currentUpdateId === updateId) {
      const boundary = "ota-boundary";
      res.writeHead(200, {
        "expo-protocol-version": "1",
        "expo-sfv-version": "0",
        "cache-control": "private, max-age=0",
        "content-type": `multipart/mixed; boundary=${boundary}`,
        "Access-Control-Allow-Origin": "*",
      });
      res.end(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="directive"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        `{"type":"noUpdateAvailable"}\r\n` +
        `--${boundary}--\r\n`
      );
      return;
    }

    // Build launch asset info
    const bundlePath = path.join(updateDir, platformMeta.bundle);
    const bundleData = fs.readFileSync(bundlePath);
    const bundleHash = crypto.createHash("sha256").update(bundleData).digest("base64url");
    const bundleKey = crypto.createHash("md5").update(bundleData).digest("hex");

    const baseUrl = `http://10.8.0.1:${PORT}/api/assets?runtimeVersion=${runtimeVersion}&platform=${platform}`;

    const launchAsset = {
      hash: bundleHash,
      key: bundleKey,
      fileExtension: ".bundle",
      contentType: "application/javascript",
      url: `${baseUrl}&asset=${encodeURIComponent(platformMeta.bundle)}`,
    };

    // Build assets list
    const assets = (platformMeta.assets || []).map((a) => {
      const assetPath = path.join(updateDir, a.path);
      const assetData = fs.readFileSync(assetPath);
      return {
        hash: crypto.createHash("sha256").update(assetData).digest("base64url"),
        key: crypto.createHash("md5").update(assetData).digest("hex"),
        fileExtension: `.${a.ext}`,
        contentType: a.ext === "png" ? "image/png" : a.ext === "jpg" ? "image/jpeg" : "application/octet-stream",
        url: `${baseUrl}&asset=${encodeURIComponent(a.path)}`,
      };
    });

    // Load expoConfig if available
    const expoConfigPath = path.join(updateDir, "expoConfig.json");
    const expoClient = fs.existsSync(expoConfigPath) ? JSON.parse(fs.readFileSync(expoConfigPath, "utf8")) : {};

    const createdAt = fs.statSync(metadataPath).mtime.toISOString();

    const manifest = {
      id: updateId,
      createdAt,
      runtimeVersion,
      launchAsset,
      assets,
      metadata: {},
      extra: { expoClient },
    };

    const boundary = "ota-boundary";
    const manifestJson = JSON.stringify(manifest);
    const extensionsJson = JSON.stringify({ assetRequestHeaders: {} });

    res.writeHead(200, {
      "expo-protocol-version": "1",
      "expo-sfv-version": "0",
      "cache-control": "private, max-age=0",
      "content-type": `multipart/mixed; boundary=${boundary}`,
      "Access-Control-Allow-Origin": "*",
    });
    res.end(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="manifest"\r\n` +
      `Content-Type: application/json; charset=utf-8\r\n\r\n` +
      `${manifestJson}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="extensions"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${extensionsJson}\r\n` +
      `--${boundary}--\r\n`
    );
    return;
  }

  // GET /api/assets — Serve update assets
  if (req.method === "GET" && pathname === "/api/assets") {
    const runtimeVersion = url.searchParams.get("runtimeVersion") || "1.0.0";
    const assetPath = url.searchParams.get("asset");
    if (!assetPath) {
      sendJSON(res, 400, { error: "Missing asset parameter" });
      return;
    }

    const filePath = path.join(UPDATES_DIR, runtimeVersion, assetPath);
    // Prevent directory traversal
    if (!filePath.startsWith(path.join(UPDATES_DIR, runtimeVersion))) {
      sendJSON(res, 403, { error: "Forbidden" });
      return;
    }

    if (!fs.existsSync(filePath)) {
      sendJSON(res, 404, { error: "Asset not found" });
      return;
    }

    const ext = path.extname(assetPath).toLowerCase();
    const contentTypes = {
      ".hbc": "application/javascript",
      ".bundle": "application/javascript",
      ".js": "application/javascript",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".gif": "image/gif",
    };

    res.writeHead(200, {
      "Content-Type": contentTypes[ext] || "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // Health check
  if (req.method === "GET" && pathname === "/") {
    sendJSON(res, 200, { service: "ozzu-bridge", uptime: process.uptime() });
    return;
  }

  sendJSON(res, 404, { error: "Not found" });
}

// ── Start ──

ensureDataDir();

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[ozzu-bridge] listening on :${PORT}`);
  console.log(`[ozzu-bridge] data dir: ${DATA_DIR}`);
});
