// routes/designer.js — drag-and-drop layout designer for Ozzu
// Directive: dir_1779020176504
// King Kazuma drags real Ozzu components onto a phone canvas in the browser.
"use strict";

const fs = require("fs");
const path = require("path");

const LAYOUT_DIR = "/home/gcp/ozzu/data/designer-layouts";

// Component manifest — names match real Ozzu source components.
// w/h are default footprint on the phone canvas (iPhone 16: 393x852 logical px).
const COMPONENTS = [
  { name: "ProjectCard",        label: "Project Card",       w: 360, h: 110, accent: "#5e6ad2" },
  { name: "DirectiveListItem",  label: "Directive Row",      w: 360, h: 96,  accent: "#3B82F6" },
  { name: "ServiceCard",        label: "Service Card",       w: 360, h: 80,  accent: "#22C55E" },
  { name: "TaskCard",           label: "Task Card",          w: 360, h: 80,  accent: "#FBBF24" },
  { name: "FindingCard",        label: "OSINT Finding",      w: 360, h: 100, accent: "#A855F7" },
  { name: "GpuCard",            label: "GPU Card",           w: 360, h: 90,  accent: "#22C55E" },
  { name: "GcpCard",            label: "GCP Card",           w: 360, h: 90,  accent: "#3B82F6" },
  { name: "ProgressBar",        label: "Progress Bar",       w: 320, h: 6,   accent: "#5e6ad2" },
  { name: "StatusBadge",        label: "Status Badge",       w: 80,  h: 22,  accent: "#22C55E" },
  { name: "Header",             label: "Screen Header",      w: 393, h: 60,  accent: "#161617" },
  { name: "TabBar",             label: "Bottom Tab Bar",     w: 393, h: 70,  accent: "#161617" },
  { name: "SearchBar",          label: "Search Bar",         w: 360, h: 40,  accent: "#1e1f20" },
  { name: "FilterChips",        label: "Filter Chips Row",   w: 360, h: 32,  accent: "#262728" },
  { name: "SummaryStatsBar",    label: "Stats Row",          w: 360, h: 50,  accent: "#161617" },
  { name: "EntityGraph",        label: "Entity Graph",       w: 360, h: 280, accent: "#A855F7" },
  { name: "FloorPlanMap",       label: "Floor Plan",         w: 360, h: 280, accent: "#5e6ad2" },
  { name: "AuditTrail",         label: "Audit Timeline",     w: 360, h: 200, accent: "#3B82F6" },
  { name: "AlertBanner",        label: "Alert Banner",       w: 360, h: 56,  accent: "#EF4444" },
  { name: "FAB",                label: "Floating Button",    w: 56,  h: 56,  accent: "#5e6ad2" },
  { name: "Box",                label: "Empty Box (custom)", w: 200, h: 100, accent: "#454545" },
];

function ensureLayoutDir() {
  try { fs.mkdirSync(LAYOUT_DIR, { recursive: true }); } catch {}
}

const HTML_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ozzu Layout Designer</title>
<style>
  :root {
    --bg-base: #0a0a0a;
    --bg-elev: #161617;
    --bg-surf: #1e1f20;
    --bg-over: #262728;
    --text-primary: #ebebeb;
    --text-secondary: #9b9b9b;
    --text-tertiary: #6b6b6b;
    --border-default: #2e2f30;
    --border-strong: #3e3f40;
    --accent: #5e6ad2;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: var(--bg-base);
    color: var(--text-primary);
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
    font-size: 13px;
    user-select: none;
    overflow: hidden;
  }
  .app {
    display: flex;
    height: 100vh;
  }
  /* Sidebar */
  .sidebar {
    width: 280px;
    background: var(--bg-elev);
    border-right: 1px solid var(--border-default);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .sidebar-header {
    padding: 16px;
    border-bottom: 1px solid var(--border-default);
  }
  .sidebar-title {
    font-size: 16px;
    font-weight: 600;
    margin: 0 0 4px 0;
  }
  .sidebar-sub {
    font-size: 11px;
    color: var(--text-tertiary);
  }
  .component-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }
  .tile {
    background: var(--bg-surf);
    border: 1px solid var(--border-default);
    border-left: 3px solid var(--accent);
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 8px;
    cursor: grab;
    font-size: 12px;
    transition: background 0.1s;
  }
  .tile:hover { background: var(--bg-over); }
  .tile:active { cursor: grabbing; }
  .tile-name { font-weight: 600; color: var(--text-primary); }
  .tile-size { font-size: 10px; color: var(--text-tertiary); margin-top: 2px; }
  /* Actions */
  .actions {
    padding: 12px;
    border-top: 1px solid var(--border-default);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .btn {
    background: var(--accent);
    color: white;
    border: none;
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .btn:hover { filter: brightness(1.1); }
  .btn-secondary { background: var(--bg-over); }
  .btn-danger { background: #EF4444; }
  .layout-name {
    background: var(--bg-surf);
    border: 1px solid var(--border-default);
    color: var(--text-primary);
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 13px;
    font-family: inherit;
  }
  /* Canvas area */
  .canvas-area {
    flex: 1;
    background: var(--bg-base);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    position: relative;
  }
  .canvas-meta {
    position: absolute;
    top: 12px;
    left: 16px;
    font-size: 11px;
    color: var(--text-tertiary);
  }
  .phone {
    width: 393px;
    height: 852px;
    background: #0a0a0a;
    border: 8px solid #1e1f20;
    border-radius: 36px;
    position: relative;
    overflow: hidden;
    box-shadow: 0 30px 80px rgba(0,0,0,0.6);
  }
  .placed {
    position: absolute;
    background: var(--bg-elev);
    border: 1px solid var(--border-default);
    border-left: 3px solid var(--accent);
    border-radius: 8px;
    color: var(--text-primary);
    font-size: 11px;
    padding: 8px;
    cursor: move;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .placed.selected {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .placed-label {
    font-weight: 600;
    font-size: 11px;
    line-height: 1.2;
  }
  .placed-sub {
    font-size: 9px;
    color: var(--text-tertiary);
    margin-top: 2px;
  }
  .resize {
    position: absolute;
    width: 12px;
    height: 12px;
    background: var(--accent);
    border-radius: 2px;
    right: -6px;
    bottom: -6px;
    cursor: nwse-resize;
  }
  .delete-btn {
    position: absolute;
    top: -8px;
    right: -8px;
    width: 20px;
    height: 20px;
    background: #EF4444;
    border-radius: 50%;
    color: white;
    font-size: 14px;
    line-height: 20px;
    text-align: center;
    cursor: pointer;
    font-weight: 700;
  }
  /* Drop ghost */
  .ghost {
    position: fixed;
    pointer-events: none;
    background: rgba(94,106,210,0.4);
    border: 2px dashed var(--accent);
    border-radius: 8px;
    z-index: 9999;
    font-size: 11px;
    color: white;
    padding: 8px;
    font-weight: 600;
  }
  /* Toast */
  .toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: var(--bg-elev);
    border: 1px solid var(--border-default);
    padding: 12px 16px;
    border-radius: 8px;
    font-size: 13px;
    color: var(--text-primary);
    opacity: 0;
    transition: opacity 0.2s;
    z-index: 10000;
  }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="sidebar-header">
      <h1 class="sidebar-title">Ozzu Designer</h1>
      <div class="sidebar-sub">Drag a component onto the phone</div>
    </div>
    <div class="component-list" id="components"></div>
    <div class="actions">
      <input class="layout-name" id="layoutName" placeholder="Layout name (e.g. directives-v2)">
      <button class="btn" onclick="saveLayout()">💾 Save Layout</button>
      <button class="btn btn-secondary" onclick="loadLayout()">📂 Load Layout</button>
      <button class="btn btn-danger" onclick="clearCanvas()">🗑 Clear Canvas</button>
    </div>
  </aside>
  <main class="canvas-area">
    <div class="canvas-meta" id="meta">393 × 852 (iPhone 16) — 0 components</div>
    <div class="phone" id="canvas"></div>
  </main>
</div>
<div class="toast" id="toast"></div>

<script>
let COMPONENTS = [];
let placed = []; // {id, name, label, x, y, w, h}
let nextId = 1;
let selected = null;

// ── Fetch components ──
fetch('/designer/components').then(r => r.json()).then(list => {
  COMPONENTS = list;
  const root = document.getElementById('components');
  list.forEach(c => {
    const t = document.createElement('div');
    t.className = 'tile';
    t.style.borderLeftColor = c.accent;
    t.innerHTML = '<div class="tile-name">' + c.label + '</div>' +
                  '<div class="tile-size">' + c.w + ' × ' + c.h + '</div>';
    t.addEventListener('mousedown', (e) => startTileDrag(e, c));
    root.appendChild(t);
  });
});

// ── Drag from sidebar onto canvas ──
function startTileDrag(e, comp) {
  e.preventDefault();
  const ghost = document.createElement('div');
  ghost.className = 'ghost';
  ghost.style.width = comp.w + 'px';
  ghost.style.height = comp.h + 'px';
  ghost.textContent = comp.label;
  document.body.appendChild(ghost);
  positionGhost(ghost, e.clientX, e.clientY, comp.w, comp.h);

  const move = (ev) => positionGhost(ghost, ev.clientX, ev.clientY, comp.w, comp.h);
  const up = (ev) => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.removeChild(ghost);
    // Check if over canvas
    const canvas = document.getElementById('canvas');
    const r = canvas.getBoundingClientRect();
    if (ev.clientX >= r.left && ev.clientX <= r.right &&
        ev.clientY >= r.top && ev.clientY <= r.bottom) {
      const x = Math.max(0, Math.round(ev.clientX - r.left - comp.w / 2));
      const y = Math.max(0, Math.round(ev.clientY - r.top - comp.h / 2));
      placeComponent(comp, x, y);
    }
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

function positionGhost(g, cx, cy, w, h) {
  g.style.left = (cx - w / 2) + 'px';
  g.style.top = (cy - h / 2) + 'px';
}

function placeComponent(comp, x, y) {
  const instance = {
    id: 'i' + (nextId++),
    name: comp.name,
    label: comp.label,
    accent: comp.accent,
    x, y,
    w: comp.w,
    h: comp.h,
  };
  placed.push(instance);
  renderInstance(instance);
  updateMeta();
}

function renderInstance(inst) {
  const canvas = document.getElementById('canvas');
  const el = document.createElement('div');
  el.className = 'placed';
  el.dataset.id = inst.id;
  el.style.left = inst.x + 'px';
  el.style.top = inst.y + 'px';
  el.style.width = inst.w + 'px';
  el.style.height = inst.h + 'px';
  el.style.borderLeftColor = inst.accent;
  el.innerHTML = '<div class="placed-label">' + inst.label + '</div>' +
                 '<div class="placed-sub">' + inst.name + '</div>' +
                 '<div class="resize"></div>' +
                 '<div class="delete-btn">×</div>';
  el.addEventListener('mousedown', (e) => startInstanceDrag(e, inst, el));
  el.querySelector('.resize').addEventListener('mousedown', (e) => startResize(e, inst, el));
  el.querySelector('.delete-btn').addEventListener('mousedown', (e) => {
    e.stopPropagation();
    deleteInstance(inst.id);
  });
  canvas.appendChild(el);
}

function startInstanceDrag(e, inst, el) {
  if (e.target.classList.contains('resize') || e.target.classList.contains('delete-btn')) return;
  e.preventDefault();
  e.stopPropagation();
  selectInstance(inst.id);
  const startX = e.clientX, startY = e.clientY;
  const origX = inst.x, origY = inst.y;
  const move = (ev) => {
    inst.x = Math.max(0, origX + (ev.clientX - startX));
    inst.y = Math.max(0, origY + (ev.clientY - startY));
    el.style.left = inst.x + 'px';
    el.style.top = inst.y + 'px';
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

function startResize(e, inst, el) {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX, startY = e.clientY;
  const origW = inst.w, origH = inst.h;
  const move = (ev) => {
    inst.w = Math.max(20, origW + (ev.clientX - startX));
    inst.h = Math.max(20, origH + (ev.clientY - startY));
    el.style.width = inst.w + 'px';
    el.style.height = inst.h + 'px';
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

function selectInstance(id) {
  selected = id;
  document.querySelectorAll('.placed').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
}

function deleteInstance(id) {
  placed = placed.filter(p => p.id !== id);
  const el = document.querySelector('.placed[data-id="' + id + '"]');
  if (el) el.remove();
  updateMeta();
}

function clearCanvas() {
  if (placed.length === 0) return;
  if (!confirm('Clear all components from the canvas?')) return;
  placed = [];
  document.getElementById('canvas').innerHTML = '';
  updateMeta();
}

function updateMeta() {
  document.getElementById('meta').textContent =
    '393 × 852 (iPhone 16) — ' + placed.length + ' component' + (placed.length === 1 ? '' : 's');
}

async function saveLayout() {
  const name = (document.getElementById('layoutName').value || '').trim() || 'untitled';
  const payload = {
    name,
    canvas: { w: 393, h: 852 },
    components: placed.map(p => ({
      name: p.name, label: p.label, x: p.x, y: p.y, w: p.w, h: p.h
    }))
  };
  const r = await fetch('/designer/layout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await r.json();
  if (data.ok) toast('Saved: ' + data.path);
  else toast('Error: ' + (data.error || 'unknown'));
}

async function loadLayout() {
  const r = await fetch('/designer/layouts');
  const list = await r.json();
  if (!list.layouts || list.layouts.length === 0) {
    toast('No saved layouts');
    return;
  }
  const name = prompt('Load which layout?\\n\\nAvailable:\\n' + list.layouts.map(l => '- ' + l).join('\\n'));
  if (!name) return;
  const r2 = await fetch('/designer/layout/' + encodeURIComponent(name));
  const layout = await r2.json();
  if (layout.error) { toast('Error: ' + layout.error); return; }
  clearCanvasSilent();
  document.getElementById('layoutName').value = layout.name || name;
  (layout.components || []).forEach(c => {
    const comp = COMPONENTS.find(cc => cc.name === c.name) || { accent: '#454545' };
    placed.push({ id: 'i' + (nextId++), ...c, accent: comp.accent });
  });
  placed.forEach(renderInstance);
  updateMeta();
}

function clearCanvasSilent() {
  placed = [];
  document.getElementById('canvas').innerHTML = '';
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// Click outside to deselect
document.getElementById('canvas').addEventListener('mousedown', (e) => {
  if (e.target.id === 'canvas') {
    selected = null;
    document.querySelectorAll('.placed').forEach(el => el.classList.remove('selected'));
  }
});

// Keyboard delete
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
    if (document.activeElement.tagName !== 'INPUT') {
      deleteInstance(selected);
      selected = null;
    }
  }
});
</script>
</body>
</html>
`;

module.exports = function designerRoutes(ctx) {
  const { sendJSON, parseBody } = ctx;
  ensureLayoutDir();

  return async function handleDesignerRoutes(req, res, pathname /* , url */) {
    if (!pathname.startsWith("/designer")) return false;

    // GET /designer — serve the HTML page
    if (req.method === "GET" && (pathname === "/designer" || pathname === "/designer/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML_PAGE);
      return true;
    }

    // GET /designer/components — manifest of available Ozzu components
    if (req.method === "GET" && pathname === "/designer/components") {
      sendJSON(res, 200, COMPONENTS);
      return true;
    }

    // GET /designer/layouts — list saved layout names
    if (req.method === "GET" && pathname === "/designer/layouts") {
      try {
        const files = fs.readdirSync(LAYOUT_DIR).filter(f => f.endsWith(".json"));
        sendJSON(res, 200, { layouts: files.map(f => f.replace(/\.json$/, "")) });
      } catch (e) {
        sendJSON(res, 200, { layouts: [] });
      }
      return true;
    }

    // GET /designer/layout/:name — fetch a saved layout
    if (req.method === "GET" && pathname.startsWith("/designer/layout/")) {
      const name = decodeURIComponent(pathname.slice("/designer/layout/".length));
      const safe = name.replace(/[^a-zA-Z0-9_\-]/g, "");
      const file = path.join(LAYOUT_DIR, safe + ".json");
      if (!fs.existsSync(file)) {
        sendJSON(res, 404, { error: "Layout not found" });
        return true;
      }
      try {
        sendJSON(res, 200, JSON.parse(fs.readFileSync(file, "utf8")));
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
      return true;
    }

    // POST /designer/layout — save a layout
    if (req.method === "POST" && pathname === "/designer/layout") {
      try {
        const body = await parseBody(req);
        const name = (body.name || "untitled").toString().replace(/[^a-zA-Z0-9_\-]/g, "") || "untitled";
        const file = path.join(LAYOUT_DIR, name + ".json");
        const payload = {
          name,
          canvas: body.canvas || { w: 393, h: 852 },
          components: Array.isArray(body.components) ? body.components : [],
          savedAt: Date.now(),
        };
        fs.writeFileSync(file, JSON.stringify(payload, null, 2));
        sendJSON(res, 200, { ok: true, path: name + ".json", count: payload.components.length });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
      return true;
    }

    return false;
  };
};
