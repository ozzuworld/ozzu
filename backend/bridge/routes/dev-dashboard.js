// routes/dev-dashboard.js — Dev dashboard: split-screen TV view (device mirror + code diff)
// Directive: dir_1776203161681
"use strict";

module.exports = function devDashboardRoutes(ctx) {
  const { sendJSON } = ctx;
  const { execSync } = require("child_process");
  const fs = require("fs");
  const path = require("path");
  const ADB_BIN = fs.existsSync("/app/adb") ? "/app/adb" : "adb";

  // Track file changes for SSE clients
  let _changeClients = [];
  let _lastDiff = "";
  let _lastDiffTime = 0;

  function adb(port, cmd, opts = {}) {
    return execSync(`${ADB_BIN} -s localhost:${port} ${cmd}`, opts);
  }

  // Watch for git changes and push to SSE clients
  function pollGitChanges() {
    try {
      const diff = execSync("git diff --stat HEAD 2>/dev/null || true", {
        cwd: "/home/gcp/ozzu/frontend",
        encoding: "utf8",
        timeout: 5000,
      });
      const fullDiff = execSync("git diff HEAD 2>/dev/null || true", {
        cwd: "/home/gcp/ozzu/frontend",
        encoding: "utf8",
        timeout: 5000,
      });
      if (fullDiff !== _lastDiff) {
        _lastDiff = fullDiff;
        _lastDiffTime = Date.now();
        const payload = JSON.stringify({
          type: "diff",
          stat: diff.trim(),
          diff: fullDiff,
          time: _lastDiffTime,
        });
        _changeClients = _changeClients.filter((res) => {
          try {
            res.write(`data: ${payload}\n\n`);
            return true;
          } catch {
            return false;
          }
        });
      }
    } catch {}
  }

  // Poll every 2 seconds
  const _pollInterval = setInterval(pollGitChanges, 2000);

  return async function handleDevDashboardRoutes(req, res, pathname, url) {
    if (!pathname.startsWith("/dev")) return false;

    // GET /dev/dashboard — main split-screen page
    if (req.method === "GET" && pathname === "/dev/dashboard") {
      const port = url.searchParams.get("port") || "5560";
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(getDashboardHtml(parseInt(port)));
      return true;
    }

    // GET /dev/screenshot/:port — device screenshot (PNG)
    const ssMatch = pathname.match(/^\/dev\/screenshot\/(\d+)$/);
    if (req.method === "GET" && ssMatch) {
      const port = parseInt(ssMatch[1]);
      try {
        adb(port, "shell screencap -p /sdcard/screen.png", { timeout: 5000 });
        const png = adb(port, "exec-out cat /sdcard/screen.png", {
          timeout: 5000,
          maxBuffer: 10 * 1024 * 1024,
        });
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "no-cache",
        });
        res.end(png);
      } catch {
        res.writeHead(500);
        res.end("screenshot error");
      }
      return true;
    }

    // GET /dev/changes — SSE stream of git diffs
    if (req.method === "GET" && pathname === "/dev/changes") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("\n");
      // Send current diff immediately
      if (_lastDiff) {
        const payload = JSON.stringify({
          type: "diff",
          stat: "",
          diff: _lastDiff,
          time: _lastDiffTime,
        });
        res.write(`data: ${payload}\n\n`);
      }
      _changeClients.push(res);
      req.on("close", () => {
        _changeClients = _changeClients.filter((c) => c !== res);
      });
      return true;
    }

    // GET /dev/build-status — check if auto-build loop is running
    if (req.method === "GET" && pathname === "/dev/build-status") {
      try {
        const pid = execSync("pgrep -f dev-loop.sh 2>/dev/null || true", {
          encoding: "utf8",
          timeout: 3000,
        }).trim();
        sendJSON(res, 200, {
          running: !!pid,
          pid: pid || null,
        });
      } catch {
        sendJSON(res, 200, { running: false });
      }
      return true;
    }

    return false;
  };
};

function getDashboardHtml(port) {
  return `<!DOCTYPE html>
<html><head>
<title>Ozzu Dev Dashboard</title>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a0a;
    color: #e5e5e5;
    font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
    height: 100vh;
    overflow: hidden;
  }

  /* Top bar */
  .topbar {
    height: 36px;
    background: #111;
    border-bottom: 1px solid #222;
    display: flex;
    align-items: center;
    padding: 0 16px;
    gap: 16px;
    font-size: 12px;
    color: #666;
  }
  .topbar .title { color: #5e6ad2; font-weight: 600; letter-spacing: 1px; }
  .topbar .status { margin-left: auto; }
  .topbar .dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; margin-right: 4px; }
  .dot.green { background: #22c55e; }
  .dot.yellow { background: #eab308; }
  .dot.red { background: #ef4444; }

  /* Main split */
  .split {
    display: flex;
    height: calc(100vh - 36px);
  }

  /* Left: Device mirror */
  .device-panel {
    width: 40%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: #0a0a0a;
    border-right: 1px solid #1a1a1a;
    position: relative;
  }
  .device-panel img {
    max-height: calc(100vh - 80px);
    max-width: 100%;
    object-fit: contain;
    border-radius: 8px;
    border: 1px solid #222;
  }
  .device-label {
    position: absolute;
    bottom: 8px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 10px;
    color: #444;
    background: #111;
    padding: 2px 8px;
    border-radius: 4px;
  }

  /* Right: Code diff */
  .code-panel {
    width: 60%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .code-header {
    height: 32px;
    background: #111;
    border-bottom: 1px solid #1a1a1a;
    display: flex;
    align-items: center;
    padding: 0 12px;
    gap: 12px;
    font-size: 11px;
    color: #555;
    flex-shrink: 0;
  }
  .code-header .changed { color: #eab308; }
  .code-body {
    flex: 1;
    overflow-y: auto;
    padding: 12px 0;
  }

  /* Diff rendering */
  .diff-file {
    margin-bottom: 16px;
  }
  .diff-file-header {
    background: #161616;
    padding: 6px 16px;
    font-size: 12px;
    color: #8b8b8b;
    border-top: 1px solid #1a1a1a;
    border-bottom: 1px solid #1a1a1a;
    position: sticky;
    top: 0;
    z-index: 1;
  }
  .diff-line {
    font-size: 12px;
    line-height: 20px;
    padding: 0 16px;
    white-space: pre;
    font-family: inherit;
  }
  .diff-add { background: rgba(34, 197, 94, 0.08); color: #4ade80; }
  .diff-del { background: rgba(239, 68, 68, 0.08); color: #f87171; }
  .diff-hunk { color: #5e6ad2; background: rgba(94, 106, 210, 0.06); }
  .diff-ctx { color: #555; }

  /* Empty state */
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #333;
    font-size: 14px;
  }

  /* Scrollbar */
  .code-body::-webkit-scrollbar { width: 6px; }
  .code-body::-webkit-scrollbar-track { background: transparent; }
  .code-body::-webkit-scrollbar-thumb { background: #222; border-radius: 3px; }
</style>
</head><body>

<div class="topbar">
  <span class="title">OZZU DEV</span>
  <span>Device :${port}</span>
  <span>|</span>
  <span id="file-count">0 files changed</span>
  <span class="status">
    <span class="dot" id="build-dot"></span>
    <span id="build-label">checking...</span>
    <span style="margin-left:12px; color:#333" id="fps-label"></span>
  </span>
</div>

<div class="split">
  <div class="device-panel">
    <img id="screen" alt="Device Screen" />
    <div class="device-label" id="device-label">loading...</div>
  </div>
  <div class="code-panel">
    <div class="code-header">
      <span>LIVE DIFF</span>
      <span class="changed" id="diff-time"></span>
    </div>
    <div class="code-body" id="diff-view">
      <div class="empty">Waiting for code changes...</div>
    </div>
  </div>
</div>

<script>
const PORT = ${port};
const img = document.getElementById('screen');
const diffView = document.getElementById('diff-view');
const diffTime = document.getElementById('diff-time');
const fileCount = document.getElementById('file-count');
const buildDot = document.getElementById('build-dot');
const buildLabel = document.getElementById('build-label');
const deviceLabel = document.getElementById('device-label');
const fpsLabel = document.getElementById('fps-label');

// ── Device screenshot polling ──
let frameCount = 0, lastFpsTime = Date.now();

function refreshScreen() {
  const t = Date.now();
  const next = new Image();
  next.onload = () => {
    img.src = next.src;
    frameCount++;
    const elapsed = Date.now() - lastFpsTime;
    if (elapsed > 3000) {
      const fps = (frameCount / (elapsed / 1000)).toFixed(1);
      fpsLabel.textContent = fps + ' fps';
      deviceLabel.textContent = 'Device :' + PORT + ' — ' + fps + ' fps';
      frameCount = 0;
      lastFpsTime = Date.now();
    }
    setTimeout(refreshScreen, 200);
  };
  next.onerror = () => setTimeout(refreshScreen, 1000);
  next.src = '/dev/screenshot/' + PORT + '?' + t;
}
refreshScreen();

// ── Code diff SSE stream ──
function connectChanges() {
  const es = new EventSource('/dev/changes');
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'diff') renderDiff(data.diff, data.stat);
    } catch {}
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectChanges, 3000);
  };
}
connectChanges();

function renderDiff(raw, stat) {
  if (!raw.trim()) {
    diffView.innerHTML = '<div class="empty">No uncommitted changes</div>';
    fileCount.textContent = '0 files changed';
    diffTime.textContent = '';
    return;
  }

  const lines = raw.split('\\n');
  let html = '';
  let currentFile = '';
  let filesChanged = 0;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const m = line.match(/b\\/(.+)$/);
      currentFile = m ? m[1] : '';
      filesChanged++;
      html += '<div class="diff-file"><div class="diff-file-header">' + esc(currentFile) + '</div>';
    } else if (line.startsWith('@@')) {
      html += '<div class="diff-line diff-hunk">' + esc(line) + '</div>';
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      html += '<div class="diff-line diff-add">' + esc(line) + '</div>';
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      html += '<div class="diff-line diff-del">' + esc(line) + '</div>';
    } else if (!line.startsWith('index ') && !line.startsWith('---') && !line.startsWith('+++') && !line.startsWith('diff ')) {
      html += '<div class="diff-line diff-ctx">' + esc(line) + '</div>';
    }
  }

  diffView.innerHTML = html || '<div class="empty">No diff data</div>';
  fileCount.textContent = filesChanged + ' file' + (filesChanged !== 1 ? 's' : '') + ' changed';
  diffTime.textContent = new Date().toLocaleTimeString();

  // Auto-scroll to bottom to show latest changes
  diffView.scrollTop = diffView.scrollHeight;
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Build status polling ──
async function checkBuild() {
  try {
    const r = await fetch('/dev/build-status');
    const d = await r.json();
    if (d.running) {
      buildDot.className = 'dot green';
      buildLabel.textContent = 'auto-build active';
    } else {
      buildDot.className = 'dot yellow';
      buildLabel.textContent = 'auto-build off';
    }
  } catch {
    buildDot.className = 'dot red';
    buildLabel.textContent = 'bridge offline';
  }
}
checkBuild();
setInterval(checkBuild, 10000);
</script>
</body></html>`;
}
