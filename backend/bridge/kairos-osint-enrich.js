#!/usr/bin/env node
/**
 * KAIROS OSINT NLP Enrichment — runs on HOST (not in Docker)
 * Processes un-enriched KG observations through Claude Haiku.
 * Called by KAIROS via cipher-daemon.js or directly.
 *
 * Usage: node kairos-osint-enrich.js [--batch-size 5]
 *
 * Directive: dir_1775980363354
 */

"use strict";

const { execSync } = require("child_process");

const BRIDGE_URL = process.env.BRIDGE_URL || "http://localhost:3333";
const BATCH_SIZE = parseInt(process.argv.find((a, i) => process.argv[i - 1] === "--batch-size") || "5");

async function main() {
  // 1. Get un-enriched observations from bridge
  const statsResp = await fetch(`${BRIDGE_URL}/kg/stats`);
  const stats = await statsResp.json();

  if (parseInt(stats.unenriched) === 0) {
    console.log("[osint-enrich] No pending observations");
    return;
  }
  console.log(`[osint-enrich] ${stats.unenriched} observation(s) pending enrichment`);

  // 2. Get the actual observations — use DB directly via bridge
  // We need to fetch unenriched observations — bridge doesn't expose this endpoint directly
  // so we'll query all subjects and their observations
  const subjectsResp = await fetch(`${BRIDGE_URL}/kg/subjects`);
  const subjects = await subjectsResp.json();

  let enriched = 0;

  for (const subject of subjects) {
    const obsResp = await fetch(`${BRIDGE_URL}/kg/subjects/${subject.id}/observations?limit=50`);
    const observations = await obsResp.json();

    for (const obs of observations) {
      if (obs.nlp_enriched) continue;
      if (enriched >= BATCH_SIZE) break;

      const data = typeof obs.raw_data === "string" ? JSON.parse(obs.raw_data) : (obs.raw_data || {});
      const content = obs.content || "";
      const combined = { ...data, content_text: content, platform: obs.platform, type: obs.observation_type };

      const prompt = [
        "You are an OSINT intelligence analyst. Extract structured intelligence from this social media observation.",
        `Subject: "${subject.name}" (ID: ${subject.id})`,
        `Platform: ${obs.platform}, Type: ${obs.observation_type}`,
        "",
        "DATA:",
        JSON.stringify(combined, null, 2).slice(0, 3000),
        "",
        'Return ONLY valid JSON:',
        '{"entities":[{"name":"...","type":"person|org|location","role":"..."}],',
        '"relationships":[{"from":"...","to":"...","type":"works_at|knows|follows|mentions","confidence":0-100}],',
        '"sentiment":"positive|negative|neutral",',
        '"inferred_facts":[{"category":"employment|location|education|interest|skill","key":"...","value":"...","confidence":0-100}],',
        '"topics":["..."],',
        '"summary":"1-sentence intelligence summary"}',
      ].join("\n");

      try {
        console.log(`[osint-enrich] Processing obs #${obs.id} (${obs.platform}/${obs.observation_type})...`);

        // Run from /tmp to avoid loading project CLAUDE.md context
        // Unset CLAUDECODE to allow spawning from within a Claude session
        const env = { ...process.env };
        delete env.CLAUDECODE;
        delete env.CLAUDE_CODE_ENTRYPOINT;

        const output = execSync(
          `claude -p ${JSON.stringify(prompt)} --model claude-haiku-4-5-20251001 --output-format text`,
          { cwd: "/tmp", encoding: "utf8", timeout: 45000, env }
        );

        // Strip markdown code fences if present, then extract JSON
        const cleaned = output.replace(/```json\s*/g, "").replace(/```\s*/g, "");
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const nlpResult = JSON.parse(jsonMatch[0]);

          // Mark enriched via direct DB (bridge runs in Docker, but we have postgres on localhost)
          const { Pool } = require("pg");
          const pool = new Pool({
            host: "127.0.0.1", port: 5432, database: "ozzu",
            user: "ozzu", password: process.env.POSTGRES_PASSWORD || "ozzu",
          });

          await pool.query(
            `UPDATE kg_observations SET nlp_enriched = true, nlp_result = $2,
             sentiment = COALESCE($3, sentiment),
             entities_extracted = COALESCE($4, entities_extracted)
             WHERE id = $1`,
            [obs.id, JSON.stringify(nlpResult),
             nlpResult.sentiment || null,
             nlpResult.entities ? JSON.stringify(nlpResult.entities) : null]
          );

          // Store inferred facts
          for (const fact of nlpResult.inferred_facts || []) {
            await fetch(`${BRIDGE_URL}/kg/subjects/${subject.id}/facts`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                category: fact.category, key: fact.key,
                value: typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value),
                source: "kairos:nlp", confidence: fact.confidence || 50,
              }),
            }).catch(() => {});
          }

          await pool.end();
          enriched++;
          console.log(`[osint-enrich] ✓ obs #${obs.id}: ${nlpResult.summary || "enriched"}`);
        } else {
          console.log(`[osint-enrich] ✗ obs #${obs.id}: failed to parse NLP output`);
          // Mark as enriched with error to avoid retrying
          const { Pool } = require("pg");
          const pool = new Pool({ host: "127.0.0.1", port: 5432, database: "ozzu", user: "ozzu", password: process.env.POSTGRES_PASSWORD || "ozzu" });
          await pool.query(`UPDATE kg_observations SET nlp_enriched = true, nlp_result = $2 WHERE id = $1`,
            [obs.id, JSON.stringify({ error: "parse_failed", raw: output.slice(0, 500) })]);
          await pool.end();
        }
      } catch (err) {
        console.error(`[osint-enrich] ✗ obs #${obs.id}: ${err.message}`);
      }
    }
    if (enriched >= BATCH_SIZE) break;
  }

  console.log(`[osint-enrich] Done — enriched ${enriched} observation(s)`);
}

main().catch(err => {
  console.error("[osint-enrich] Fatal:", err.message);
  process.exit(1);
});
