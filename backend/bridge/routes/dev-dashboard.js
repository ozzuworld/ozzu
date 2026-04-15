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
      const diff = execSync("git -C /home/gcp/ozzu diff --stat HEAD -- frontend/app frontend/components frontend/lib tv/ 2>/dev/null || true", {
        encoding: "utf8",
        timeout: 5000,
      });
      const fullDiff = execSync("git -C /home/gcp/ozzu diff HEAD -- frontend/app frontend/components frontend/lib tv/ 2>/dev/null || true", {
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

    // GET /dev/diff — current diff as JSON (for polling clients like TV app)
    if (req.method === "GET" && pathname === "/dev/diff") {
      sendJSON(res, 200, {
        diff: _lastDiff,
        time: _lastDiffTime,
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
<title>OZZU // DEV CONSOLE</title>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap');

  :root {
    --cyan: #0ff5ee;
    --cyan-mid: #0cc7c2;
    --cyan-dim: #0aa8a3;
    --cyan-dark: #064d4a;
    --cyan-glow: rgba(15, 245, 238, 0.25);
    --cyan-glow-strong: rgba(15, 245, 238, 0.5);
    --green: #00ff41;
    --red: #ff3c3c;
    --yellow: #ffd700;
    --bg: #020208;
    --frame-bg: rgba(6, 77, 74, 0.06);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--bg);
    color: var(--cyan);
    font-family: 'Share Tech Mono', 'Courier New', monospace;
    height: 100vh;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 30px;
  }

  /* ── Scanline overlay ── */
  body::after {
    content: '';
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: repeating-linear-gradient(
      0deg, transparent, transparent 2px,
      rgba(0, 0, 0, 0.06) 2px, rgba(0, 0, 0, 0.06) 4px
    );
    pointer-events: none;
    z-index: 9999;
  }

  /* ── Ambient background glow ── */
  body::before {
    content: '';
    position: fixed;
    top: 50%; left: 50%;
    width: 120vw; height: 120vh;
    transform: translate(-50%, -50%);
    background: radial-gradient(ellipse at 30% 50%, rgba(15,245,238,0.03) 0%, transparent 50%),
                radial-gradient(ellipse at 70% 50%, rgba(15,245,238,0.02) 0%, transparent 50%);
    pointer-events: none;
    z-index: 0;
  }

  /* ══════════════════════════════════
     SCI-FI FLOATING FRAME
     ══════════════════════════════════ */
  .hud-frame {
    position: relative;
    z-index: 1;
    /* Outer glow */
    filter: drop-shadow(0 0 15px rgba(15, 245, 238, 0.15))
            drop-shadow(0 0 40px rgba(15, 245, 238, 0.05));
  }

  .hud-frame .frame-border {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 10;
  }

  /* Main border with corner cuts */
  .hud-frame .frame-border::before {
    content: '';
    position: absolute;
    inset: 0;
    border: 1px solid var(--cyan-dark);
    /* Cut corners using clip-path */
    clip-path: polygon(
      20px 0%, calc(100% - 20px) 0%,
      100% 20px, 100% calc(100% - 20px),
      calc(100% - 20px) 100%, 20px 100%,
      0% calc(100% - 20px), 0% 20px
    );
  }

  /* Inner glow border */
  .hud-frame .frame-border::after {
    content: '';
    position: absolute;
    inset: 3px;
    border: 1px solid rgba(15, 245, 238, 0.08);
    clip-path: polygon(
      18px 0%, calc(100% - 18px) 0%,
      100% 18px, 100% calc(100% - 18px),
      calc(100% - 18px) 100%, 18px 100%,
      0% calc(100% - 18px), 0% 18px
    );
  }

  /* Corner hotspot glow elements */
  .corner {
    position: absolute;
    width: 30px;
    height: 30px;
    z-index: 11;
    pointer-events: none;
  }
  .corner::before, .corner::after {
    content: '';
    position: absolute;
    background: var(--cyan);
    box-shadow: 0 0 6px var(--cyan), 0 0 12px var(--cyan-glow);
  }
  /* Top-left */
  .corner.tl { top: -1px; left: -1px; }
  .corner.tl::before { top: 0; left: 20px; width: 16px; height: 2px; }
  .corner.tl::after { top: 20px; left: 0; width: 2px; height: 16px; }
  /* Top-right */
  .corner.tr { top: -1px; right: -1px; }
  .corner.tr::before { top: 0; right: 20px; width: 16px; height: 2px; }
  .corner.tr::after { top: 20px; right: 0; width: 2px; height: 16px; }
  /* Bottom-left */
  .corner.bl { bottom: -1px; left: -1px; }
  .corner.bl::before { bottom: 0; left: 20px; width: 16px; height: 2px; }
  .corner.bl::after { bottom: 20px; left: 0; width: 2px; height: 16px; }
  /* Bottom-right */
  .corner.br { bottom: -1px; right: -1px; }
  .corner.br::before { bottom: 0; right: 20px; width: 16px; height: 2px; }
  .corner.br::after { bottom: 20px; right: 0; width: 2px; height: 16px; }

  /* Small tick marks along edges */
  .edge-tick {
    position: absolute;
    background: var(--cyan-dark);
    z-index: 11;
    pointer-events: none;
  }
  .edge-tick.top { top: 0; height: 1px; width: 6px; }
  .edge-tick.bottom { bottom: 0; height: 1px; width: 6px; }
  .edge-tick.left { left: 0; width: 1px; height: 6px; }
  .edge-tick.right { right: 0; width: 1px; height: 6px; }

  /* Frame label */
  .frame-label {
    position: absolute;
    top: -22px;
    left: 28px;
    font-size: 9px;
    letter-spacing: 4px;
    text-transform: uppercase;
    color: var(--cyan-dim);
    z-index: 11;
    text-shadow: 0 0 8px var(--cyan-glow);
  }

  /* Frame status (bottom) */
  .frame-status {
    position: absolute;
    bottom: -20px;
    right: 28px;
    font-size: 8px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--cyan-dark);
    z-index: 11;
  }

  /* Inner grid pattern */
  .frame-grid {
    position: absolute;
    inset: 4px;
    background-image:
      linear-gradient(rgba(15,245,238,0.02) 1px, transparent 1px),
      linear-gradient(90deg, rgba(15,245,238,0.02) 1px, transparent 1px);
    background-size: 40px 40px;
    clip-path: polygon(
      17px 0%, calc(100% - 17px) 0%,
      100% 17px, 100% calc(100% - 17px),
      calc(100% - 17px) 100%, 17px 100%,
      0% calc(100% - 17px), 0% 17px
    );
    pointer-events: none;
    z-index: 2;
  }

  /* Content area inside the frame */
  .frame-content {
    position: relative;
    z-index: 5;
    width: 100%;
    height: 100%;
    clip-path: polygon(
      17px 0%, calc(100% - 17px) 0%,
      100% 17px, 100% calc(100% - 17px),
      calc(100% - 17px) 100%, 17px 100%,
      0% calc(100% - 17px), 0% 17px
    );
    overflow: hidden;
  }

  /* ══════════════════════════════════
     DEVICE FRAME — phone aspect ratio (9:19.5)
     ══════════════════════════════════ */
  .device-frame {
    /* 9:19.5 aspect = 0.4615 width:height */
    height: calc(100vh - 80px);
    width: calc((100vh - 80px) * 0.4615);
    max-width: 42vw;
  }
  .device-frame .frame-content {
    background: #000;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .device-frame img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  /* ══════════════════════════════════
     CODE FRAME — fills remaining space
     ══════════════════════════════════ */
  .code-frame {
    height: calc(100vh - 80px);
    width: 52vw;
    display: flex;
    flex-direction: column;
  }
  .code-frame .frame-content {
    display: flex;
    flex-direction: column;
    background: var(--frame-bg);
  }

  /* Code header inside frame */
  .code-header {
    height: 30px;
    display: flex;
    align-items: center;
    padding: 0 20px;
    gap: 16px;
    font-size: 9px;
    letter-spacing: 2px;
    color: var(--cyan-dim);
    border-bottom: 1px solid rgba(15,245,238,0.08);
    flex-shrink: 0;
    text-transform: uppercase;
  }
  .code-header .tag {
    color: var(--yellow);
    text-shadow: 0 0 6px rgba(255,215,0,0.3);
  }
  .code-header .files { color: var(--cyan-mid); }

  /* Code body (diff view) */
  .code-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }

  /* Diff rendering */
  .diff-file { margin-bottom: 6px; }
  .diff-file-header {
    background: rgba(15, 245, 238, 0.04);
    padding: 4px 20px;
    font-size: 11px;
    color: var(--cyan);
    letter-spacing: 1px;
    border-left: 2px solid var(--cyan-dim);
    position: sticky;
    top: 0;
    z-index: 1;
  }
  .diff-line {
    font-size: 11px;
    line-height: 17px;
    padding: 0 20px 0 24px;
    white-space: pre;
    font-family: inherit;
    border-left: 2px solid transparent;
  }
  .diff-add {
    background: rgba(0, 255, 65, 0.05);
    color: var(--green);
    border-left-color: var(--green);
    text-shadow: 0 0 3px rgba(0,255,65,0.15);
  }
  .diff-del {
    background: rgba(255, 60, 60, 0.05);
    color: var(--red);
    border-left-color: var(--red);
    text-shadow: 0 0 3px rgba(255,60,60,0.15);
  }
  .diff-hunk {
    color: var(--cyan-dim);
    background: rgba(15, 245, 238, 0.02);
    font-size: 9px;
    padding-top: 3px;
    padding-bottom: 3px;
    margin-top: 3px;
  }
  .diff-ctx { color: rgba(10, 168, 163, 0.4); }

  /* Telemetry strip at bottom of code frame */
  .telem-strip {
    height: 28px;
    display: flex;
    align-items: center;
    padding: 0 20px;
    gap: 24px;
    border-top: 1px solid rgba(15,245,238,0.08);
    font-size: 9px;
    letter-spacing: 2px;
    color: var(--cyan-dark);
    text-transform: uppercase;
    flex-shrink: 0;
  }
  .telem-strip .val { color: var(--cyan-dim); }
  .telem-strip .live { color: var(--green); }
  .telem-strip .warn { color: var(--yellow); }
  .telem-strip .err { color: var(--red); }

  /* ── Empty state ── */
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--cyan-dark);
    font-size: 11px;
    letter-spacing: 4px;
    text-transform: uppercase;
  }

  /* ── Scrollbar ── */
  ::-webkit-scrollbar { width: 3px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--cyan-dark); }

  /* ── Animations ── */
  @keyframes glow-pulse {
    0%, 100% { box-shadow: 0 0 6px var(--cyan), 0 0 12px var(--cyan-glow); }
    50% { box-shadow: 0 0 10px var(--cyan), 0 0 20px var(--cyan-glow-strong); }
  }
  .corner::before, .corner::after { animation: glow-pulse 3s ease-in-out infinite; }
  .corner.tr::before, .corner.tr::after { animation-delay: 0.5s; }
  .corner.bl::before, .corner.bl::after { animation-delay: 1s; }
  .corner.br::before, .corner.br::after { animation-delay: 1.5s; }

  @keyframes flicker { 0%,97%,100% { opacity: 1; } 98% { opacity: 0.85; } 99% { opacity: 0.92; } }
</style>
</head><body>

<!-- ═══ DEVICE FRAME (left) ═══ -->
<div class="hud-frame device-frame">
  <div class="frame-border"></div>
  <div class="corner tl"></div><div class="corner tr"></div>
  <div class="corner bl"></div><div class="corner br"></div>
  <div class="edge-tick top" style="left:50%"></div>
  <div class="edge-tick bottom" style="left:50%"></div>
  <div class="edge-tick left" style="top:50%"></div>
  <div class="edge-tick right" style="top:50%"></div>
  <div class="frame-grid"></div>
  <div class="frame-label">DEVICE MIRROR // :${port}</div>
  <div class="frame-status"><span id="device-status">CONNECTING</span> | <span id="fps-label">-- FPS</span> | <span id="device-res">--</span></div>
  <div class="frame-content">
    <img id="screen" alt="" />
  </div>
</div>

<!-- ═══ CODE FRAME (right) ═══ -->
<div class="hud-frame code-frame">
  <div class="frame-border"></div>
  <div class="corner tl"></div><div class="corner tr"></div>
  <div class="corner bl"></div><div class="corner br"></div>
  <div class="edge-tick top" style="left:33%"></div>
  <div class="edge-tick top" style="left:66%"></div>
  <div class="edge-tick bottom" style="left:33%"></div>
  <div class="edge-tick bottom" style="left:66%"></div>
  <div class="edge-tick left" style="top:33%"></div>
  <div class="edge-tick left" style="top:66%"></div>
  <div class="edge-tick right" style="top:33%"></div>
  <div class="edge-tick right" style="top:66%"></div>
  <div class="frame-grid"></div>
  <div class="frame-label">LIVE DIFF // SOURCE MONITOR</div>
  <div class="frame-status"><span id="file-count">0 FILES</span> | <span id="diff-time">--:--:--</span></div>
  <div class="frame-content">
    <div class="code-header">
      <span class="files" id="file-summary">AWAITING CHANGES</span>
      <span style="margin-left:auto" class="tag" id="build-label">SCANNING...</span>
    </div>
    <div class="code-body" id="diff-view">
      <div class="empty">AWAITING SOURCE MODIFICATIONS</div>
    </div>
    <div class="telem-strip">
      <span>FPS <span class="val" id="tv-fps">--</span></span>
      <span>BUILD <span class="val" id="tv-build">--</span>S</span>
      <span id="clock">00:00:00</span>
    </div>
  </div>
</div>

<script>
const PORT = ${port};
const img = document.getElementById('screen');
const diffView = document.getElementById('diff-view');
const diffTime = document.getElementById('diff-time');
const fileCount = document.getElementById('file-count');
const fileSummary = document.getElementById('file-summary');
const buildLabel = document.getElementById('build-label');
const fpsLabel = document.getElementById('fps-label');
const deviceStatus = document.getElementById('device-status');
const deviceRes = document.getElementById('device-res');
const clockEl = document.getElementById('clock');
const tvFps = document.getElementById('tv-fps');
const tvBuild = document.getElementById('tv-build');

// ── Clock ──
setInterval(() => {
  clockEl.textContent = new Date().toLocaleTimeString('en', { hour12: false });
}, 1000);

// ── Device screenshot polling ──
let frameCount = 0, lastFpsTime = Date.now(), totalFrames = 0;

function refreshScreen() {
  const next = new Image();
  next.onload = () => {
    img.src = next.src;
    frameCount++;
    totalFrames++;
    if (totalFrames === 1) {
      deviceStatus.textContent = 'ONLINE';
      deviceRes.textContent = next.naturalWidth + 'x' + next.naturalHeight;
    }
    const elapsed = Date.now() - lastFpsTime;
    if (elapsed > 2000) {
      const fps = (frameCount / (elapsed / 1000)).toFixed(1);
      fpsLabel.textContent = fps + ' FPS';
      tvFps.textContent = fps;
      frameCount = 0;
      lastFpsTime = Date.now();
    }
    setTimeout(refreshScreen, 150);
  };
  next.onerror = () => {
    deviceStatus.textContent = 'OFFLINE';
    tvFps.textContent = '0';
    setTimeout(refreshScreen, 2000);
  };
  next.src = '/dev/screenshot/' + PORT + '?' + Date.now();
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
  es.onerror = () => { es.close(); setTimeout(connectChanges, 3000); };
}
connectChanges();

function renderDiff(raw, stat) {
  if (!raw.trim()) {
    diffView.innerHTML = '<div class="empty">NO UNCOMMITTED CHANGES</div>';
    fileCount.textContent = '0 FILES';
    fileSummary.textContent = 'CLEAN';
    diffTime.textContent = '--:--:--';
    return;
  }
  const lines = raw.split('\\n');
  let html = '', filesChanged = 0, additions = 0, deletions = 0;
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const m = line.match(/b\\/(.+)$/);
      filesChanged++;
      html += '<div class="diff-file"><div class="diff-file-header">\u25B8 ' + esc(m ? m[1] : '') + '</div>';
    } else if (line.startsWith('@@')) {
      html += '<div class="diff-line diff-hunk">' + esc(line) + '</div>';
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
      html += '<div class="diff-line diff-add">' + esc(line) + '</div>';
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
      html += '<div class="diff-line diff-del">' + esc(line) + '</div>';
    } else if (!line.startsWith('index ') && !line.startsWith('---') && !line.startsWith('+++') && !line.startsWith('diff ')) {
      html += '<div class="diff-line diff-ctx">' + esc(line) + '</div>';
    }
  }
  diffView.innerHTML = html || '<div class="empty">NO DIFF DATA</div>';
  fileCount.textContent = filesChanged + ' FILE' + (filesChanged !== 1 ? 'S' : '');
  fileSummary.textContent = filesChanged + ' FILE' + (filesChanged !== 1 ? 'S' : '') + ' // +' + additions + ' -' + deletions;
  diffTime.textContent = new Date().toLocaleTimeString('en', { hour12: false });
  diffView.scrollTop = diffView.scrollHeight;
}

function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Build status ──
async function checkBuild() {
  try {
    const r = await fetch('/dev/build-status');
    const d = await r.json();
    if (d.running) {
      buildLabel.textContent = 'AUTO-BUILD \u25CF';
      buildLabel.style.color = 'var(--green)';
    } else {
      buildLabel.textContent = 'BUILD \u25CB IDLE';
      buildLabel.style.color = 'var(--yellow)';
    }
  } catch {
    buildLabel.textContent = 'OFFLINE';
    buildLabel.style.color = 'var(--red)';
  }
}
checkBuild();
setInterval(checkBuild, 5000);
</script>
</body></html>`;
}
