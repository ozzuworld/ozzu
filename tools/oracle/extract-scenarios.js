#!/usr/bin/env node
// Extract training scenarios from completed engagement runs.
//
// For each iter of each engagement, build a state snapshot that represents
// "what the model knew at decision time" — this is the input format the
// Oracle will see during trajectory generation.
//
// Output: JSONL file, one scenario per line, ready to feed generate-trajectories.js
//
// Usage:
//   node extract-scenarios.js <engagement_id> [<engagement_id> ...] > scenarios.jsonl
//   node extract-scenarios.js --all-ozzulab > scenarios.jsonl

const { Client } = require("pg");

const PG = {
  host: process.env.PGHOST || "localhost",
  port: parseInt(process.env.PGPORT || "5432", 10),
  user: process.env.PGUSER || "ozzu",
  password: process.env.PGPASSWORD || "ozzu",
  database: process.env.PGDATABASE || "ozzu",
};

async function listOzzuLabEngagements(client) {
  const r = await client.query(
    `SELECT id, scope->>'objective' AS objective FROM pentest_engagements
       WHERE client_name = 'OzzuLab' OR scope->>'synthetic_lab' = 'true'
       ORDER BY created_at`);
  return r.rows;
}

async function getEngagementMeta(client, id) {
  const r = await client.query(
    `SELECT id, scope, roe, agent_run_state FROM pentest_engagements WHERE id=$1`, [id]);
  return r.rows[0];
}

async function getQueueHistory(client, id) {
  const r = await client.query(
    `SELECT id, status, intent_class, title, command, LEFT(output, 600) AS output_excerpt,
            created_at, started_at
       FROM soc_queue_items WHERE engagement_id=$1 ORDER BY id`, [id]);
  return r.rows;
}

// Build one scenario per queue item — that's the state RIGHT BEFORE the
// model emitted that command. Earlier queue items become the history; the
// command in question is what the model actually chose. We don't include
// the chosen command in the state (that's the prediction target).
function buildScenarios(meta, queue) {
  const scope = meta.scope || {};
  const scenarios = [];

  for (let i = 0; i < queue.length; i++) {
    const target = queue[i];
    const history = queue.slice(0, i);

    // Derive discovered facts (very rough) — hostnames + open ports from past output.
    const discovered = new Set();
    for (const q of history) {
      if (!q.output_excerpt) continue;
      const txt = q.output_excerpt;
      const hostMatches = txt.match(/\b[\w-]+\.skyline\.local\b/g);
      if (hostMatches) hostMatches.forEach(h => discovered.add(`host: ${h}`));
      const portMatches = txt.match(/(\d{1,5})\/tcp\s+open\s+(\S+)/g);
      if (portMatches) portMatches.forEach(p => discovered.add(`port: ${p}`));
      const verMatches = txt.match(/(Apache|nginx|MySQL|OpenSSH)[^\n,]{0,40}/g);
      if (verMatches) verMatches.forEach(v => discovered.add(`service: ${v.trim()}`));
      if (/OZZULAB\{/.test(txt)) discovered.add("FLAG_VISIBLE_IN_PRIOR_OUTPUT");
    }

    scenarios.push({
      engagement_id: meta.id,
      iter: i + 1,
      max_iter: 30,
      objective: scope.objective || "Find OZZULAB{...} flag",
      allowed: scope.allowed || [],
      prohibited: scope.prohibited || [],
      synthetic_lab: scope.synthetic_lab === true,
      discovered: Array.from(discovered).slice(-20),
      queue_history: history.slice(-10).map(q => ({
        id: q.id,
        status: q.status,
        intent: q.intent_class,
        command: q.command ? q.command.slice(0, 300) : "",
        output_excerpt: q.output_excerpt ? q.output_excerpt.slice(0, 300) : null,
      })),
      // What the actual model did (for reference / evaluation; NOT given to Oracle)
      ground_truth: {
        queue_id: target.id,
        chose_command: target.command,
        outcome_status: target.status,
        output_excerpt: target.output_excerpt,
      },
    });
  }
  return scenarios;
}

async function main() {
  const args = process.argv.slice(2);
  const client = new Client(PG);
  await client.connect();

  let engagementIds = [];
  if (args.includes("--all-ozzulab")) {
    const all = await listOzzuLabEngagements(client);
    engagementIds = all.map(e => e.id);
    console.error(`[extract] discovered ${engagementIds.length} OzzuLab engagement(s)`);
  } else {
    engagementIds = args.filter(a => !a.startsWith("--"));
  }

  if (!engagementIds.length) {
    console.error("Usage: extract-scenarios.js <engagement_id> ... | --all-ozzulab");
    process.exit(2);
  }

  let total = 0;
  for (const id of engagementIds) {
    const meta = await getEngagementMeta(client, id);
    if (!meta) {
      console.error(`[extract] ${id}: not found`);
      continue;
    }
    const queue = await getQueueHistory(client, id);
    const scenarios = buildScenarios(meta, queue);
    for (const s of scenarios) {
      process.stdout.write(JSON.stringify(s) + "\n");
      total++;
    }
    console.error(`[extract] ${id}: ${scenarios.length} scenarios from ${queue.length} queue items`);
  }
  console.error(`[extract] TOTAL: ${total} scenarios`);
  await client.end();
}

if (require.main === module) {
  main().catch(e => { console.error("extract error:", e); process.exit(1); });
}
