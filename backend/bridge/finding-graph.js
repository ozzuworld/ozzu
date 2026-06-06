// finding-graph.js — dir_1780781999942
//
// Materializes the attack graph for a given engagement: confirmed findings
// + open hypothesis nodes + pending probe nodes (from soc_queue_items),
// with informed_by / enables edges between them. Output is membrane-safe
// (no raw commands, payloads, credentials) — only structural shape +
// severity + sanitized titles.
//
// Used by:
//   - L4 MCP tool `get_finding_graph` (Cipher inspection, audit)
//   - SOC app `GET /soc/engagements/:id/finding-graph` (UI rendering)
//   - L3 offense agent (Reasoning role prompt context, when
//     pentest_engagements.graph_mode_enabled = true)

"use strict";

const db = require("/app/db");

// Patterns we redact from titles before they enter L4 context. Mirrors
// membrane-audit.js intent. Sanitization here is defensive — finding titles
// are already authored by the offense model and should be clean.
const REDACT_PATTERNS = [
  { kind: "cve_id", regex: /\bCVE-\d{4}-\d{4,7}\b/gi },         // keep CVE refs — useful structural signal
  { kind: "ip",     regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
];

function sanitizeTitle(t, opts = {}) {
  if (!t) return t;
  if (opts.keepCves && opts.keepIps) return t;
  let out = String(t);
  if (!opts.keepIps) {
    out = out.replace(REDACT_PATTERNS.find(p => p.kind === "ip").regex, "<ip>");
  }
  return out;
}

async function materializeFindingGraph(engagementId, opts = {}) {
  if (!engagementId) throw new Error("engagementId required");
  const keepCves = opts.keepCves !== false;       // default: keep CVE IDs (structural)
  const keepIps = opts.keepIps === true;          // default: redact raw IPs

  // 1. Findings (confirmed + hypothesis + refuted)
  const fr = await db.query(
    `SELECT id, severity, title, kind, status, informed_by, enables, discovered_at, affected_asset
       FROM pentest_findings WHERE engagement_id = $1 ORDER BY discovered_at ASC, id ASC`,
    [engagementId]);

  // 2. Pending queue items as "pending_probe" nodes — what the model has proposed
  //    but the PA hasn't run yet (or just started). Membrane-critical: do NOT
  //    expose command / output here — only title + status.
  const qr = await db.query(
    `SELECT id, seq, title, status, created_at FROM soc_queue_items
       WHERE engagement_id = $1 AND status IN ('pending', 'running')
       ORDER BY seq ASC`,
    [engagementId]);

  // ── Nodes ──
  const nodes = [];
  for (const f of fr.rows) {
    nodes.push({
      id: `f${f.id}`,
      type: "finding",
      kind: f.kind || "confirmed",                            // confirmed | hypothesis | refuted
      severity: f.severity,
      title: sanitizeTitle(f.title, { keepCves, keepIps }),
      status: f.status,
      asset: f.affected_asset || null,
      informed_by: Array.isArray(f.informed_by) ? f.informed_by : [],
      enables: Array.isArray(f.enables) ? f.enables : [],
      discovered_at: f.discovered_at,
    });
  }
  for (const q of qr.rows) {
    nodes.push({
      id: `q${q.id}`,
      type: "probe",
      kind: "pending_probe",
      severity: null,
      title: sanitizeTitle(q.title, { keepCves, keepIps }),
      status: q.status,
      asset: null,
      seq: q.seq,
      created_at: q.created_at,
    });
  }

  // ── Edges ──
  // informed_by entries point AT this node — flip direction so the edge reads
  // from-evidence → to-conclusion.
  const findingIds = new Set(fr.rows.map(r => `f${r.id}`));
  const edges = [];
  for (const f of fr.rows) {
    const src = `f${f.id}`;
    const ibList = Array.isArray(f.informed_by) ? f.informed_by : [];
    for (const ib of ibList) {
      // Support both shapes: {finding_id, edge_kind} and bare finding_id
      const fromId = typeof ib === "object" ? `f${ib.finding_id}` : `f${ib}`;
      const edgeKind = (typeof ib === "object" ? ib.edge_kind : null) || "evidence";
      if (findingIds.has(fromId)) {
        edges.push({ from: fromId, to: src, kind: edgeKind });
      }
    }
  }

  // ── Topological order (Kahn's) ──
  const indeg = new Map(nodes.map(n => [n.id, 0]));
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  const ready = nodes.filter(n => (indeg.get(n.id) || 0) === 0).map(n => n.id);
  const topoOrder = [];
  while (ready.length > 0) {
    const u = ready.shift();
    topoOrder.push(u);
    for (const e of edges) {
      if (e.from !== u) continue;
      const d = (indeg.get(e.to) || 1) - 1;
      indeg.set(e.to, d);
      if (d === 0) ready.push(e.to);
    }
  }
  // Append any cycle-trapped nodes at the end (shouldn't happen in a DAG but
  // we don't crash on bad data — the agent prompt will still see them).
  if (topoOrder.length < nodes.length) {
    for (const n of nodes) if (!topoOrder.includes(n.id)) topoOrder.push(n.id);
  }

  // ── Open frontiers ──
  // v1 rule (dir_1780783102989): everything is open unless explicitly closed.
  //   - hypothesis nodes with no child
  //   - pending probe nodes (awaiting PA outcome)
  //   - every confirmed/refuted finding's `enables[]` entry is listed as open
  //     until a later finding's `fulfills[]` array explicitly closes it.
  //     Today nobody sets fulfills → all enables list as open. Correct: the
  //     model gets a complete view of what's still on the table, not a buggy
  //     heuristic that over-marks labels as fulfilled.
  const hasChild = new Set(edges.map(e => e.from));
  const explicitlyFulfilled = new Set();
  for (const f of fr.rows) {
    const ff = Array.isArray(f.fulfills) ? f.fulfills : [];
    for (const lbl of ff) {
      if (typeof lbl === "string") explicitlyFulfilled.add(lbl);
      else if (lbl && lbl.hypothesis_label) explicitlyFulfilled.add(lbl.hypothesis_label);
    }
  }
  const openFrontiers = [];
  for (const n of nodes) {
    if (n.kind === "hypothesis" && !hasChild.has(n.id)) {
      openFrontiers.push({ node_id: n.id, title: n.title, reason: "open hypothesis — no probe / finding advances it" });
    }
    if (n.kind === "pending_probe") {
      openFrontiers.push({ node_id: n.id, title: n.title, reason: `probe ${n.status} — awaiting result` });
    }
    if ((n.kind === "confirmed" || n.kind === "refuted") && Array.isArray(n.enables)) {
      for (const en of n.enables) {
        if (!en || !en.hypothesis_label) continue;
        if (explicitlyFulfilled.has(en.hypothesis_label)) continue;
        openFrontiers.push({
          node_id: n.id,
          title: n.title,
          reason: `unfulfilled enables: ${en.hypothesis_label}${en.ttp_hint ? ` (${en.ttp_hint})` : ""}`,
        });
      }
    }
  }

  return { nodes, edges, topo_order: topoOrder, open_frontiers: openFrontiers };
}

// ── Renderer for agent prompt context ──
// Compact ASCII rendering of the graph — small token footprint, easy for the
// model to reason over. Returns a multi-line string ready to drop into a
// prompt block. Membrane-safe (uses sanitized titles from materialize).
function renderForPrompt(graph) {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    return "(no findings or open probes yet — engagement is empty.)";
  }
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const children = new Map();
  for (const e of graph.edges) {
    if (!children.has(e.from)) children.set(e.from, []);
    children.get(e.from).push(e);
  }
  const lines = [];
  lines.push("FINDING GRAPH (confirmed → hypothesis → pending probe):");
  for (const id of graph.topo_order) {
    const n = byId.get(id);
    if (!n) continue;
    const sevTag = n.severity ? `[${n.severity.toUpperCase()}]` : "";
    const kindTag = n.kind === "confirmed" ? "✓" : n.kind === "hypothesis" ? "?" : n.kind === "refuted" ? "✗" : n.kind === "pending_probe" ? "⏳" : "·";
    const incoming = graph.edges.filter(e => e.to === id).map(e => e.from).join(",") || "—";
    lines.push(`  ${kindTag} ${id} ${sevTag} ${n.title}${n.asset ? ` @ ${n.asset}` : ""}  [evidence: ${incoming}]`);
  }
  if (graph.open_frontiers.length > 0) {
    lines.push("");
    lines.push("OPEN FRONTIERS (where reasoning can still advance):");
    for (const f of graph.open_frontiers.slice(0, 10)) {
      lines.push(`  → ${f.node_id}: ${f.reason}`);
    }
    if (graph.open_frontiers.length > 10) {
      lines.push(`  …(${graph.open_frontiers.length - 10} more)`);
    }
  }
  return lines.join("\n");
}

module.exports = { materializeFindingGraph, renderForPrompt };
