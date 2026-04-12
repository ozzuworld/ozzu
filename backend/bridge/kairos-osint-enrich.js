#!/usr/bin/env node
/**
 * KAIROS OSINT NLP Enrichment — runs on HOST (not in Docker)
 * Processes un-enriched KG observations through Claude Haiku via API.
 * Called by KAIROS cron or directly.
 *
 * Usage: node kairos-osint-enrich.js [--batch-size 5] [--retry]
 *   --retry: re-process observations that previously failed (error in nlp_result)
 *
 * Directive: dir_1775980363354, dir_1776009547123
 */

"use strict";

const BRIDGE_URL = process.env.BRIDGE_URL || "http://localhost:3333";
const BATCH_SIZE = parseInt(process.argv.find((a, i) => process.argv[i - 1] === "--batch-size") || "5");
const RETRY_FAILED = process.argv.includes("--retry");

// Read API key from environment or credentials file
function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const fs = require("fs");
    const path = require("path");
    const envFile = path.join(__dirname, "..", "..", "private", "influence-ops-credentials.env");
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, "utf8");
      const match = content.match(/ANTHROPIC_API_KEY=(.+)/);
      if (match) return match[1].trim();
    }
  } catch {}
  return null;
}

async function callHaiku(prompt) {
  const apiKey = getApiKey();

  if (apiKey) {
    // Direct API call — works from anywhere
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`API ${resp.status}: ${err.slice(0, 200)}`);
    }
    const result = await resp.json();
    return result.content?.[0]?.text || "";
  }

  // Fallback: use claude CLI (must run from HOST, not Docker)
  const { execSync } = require("child_process");
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const output = execSync(
    `claude -p ${JSON.stringify(prompt)} --model claude-haiku-4-5-20251001 --output-format text`,
    { cwd: "/tmp", encoding: "utf8", timeout: 45000, env }
  );
  return output;
}

async function main() {
  const { Pool } = require("pg");
  const pool = new Pool({
    host: "127.0.0.1", port: 5432, database: "ozzu",
    user: "ozzu", password: process.env.POSTGRES_PASSWORD || "ozzu",
  });

  try {
    // Get observations to process
    let query;
    if (RETRY_FAILED) {
      query = `SELECT o.*, s.name as subject_name FROM kg_observations o
               JOIN kg_subjects s ON o.subject_id = s.id
               WHERE o.nlp_enriched = true AND o.nlp_result::text LIKE '%"error"%'
               ORDER BY o.id LIMIT $1`;
      console.log(`[osint-enrich] Retrying failed observations (batch: ${BATCH_SIZE})...`);
    } else {
      query = `SELECT o.*, s.name as subject_name FROM kg_observations o
               JOIN kg_subjects s ON o.subject_id = s.id
               WHERE o.nlp_enriched = false
               ORDER BY o.id LIMIT $1`;
    }

    const res = await pool.query(query, [BATCH_SIZE]);
    if (res.rows.length === 0) {
      console.log("[osint-enrich] No pending observations");
      return;
    }
    console.log(`[osint-enrich] ${res.rows.length} observation(s) to process`);

    let enriched = 0;

    for (const obs of res.rows) {
      const data = typeof obs.raw_data === "string" ? JSON.parse(obs.raw_data) : (obs.raw_data || {});
      const content = obs.content || "";
      const combined = { ...data, content_text: content, platform: obs.platform, type: obs.observation_type };

      const prompt = [
        "Convert this social media profile data into structured JSON. This is a data formatting task — the input is already public profile data, you are just reformatting it.",
        "",
        `Profile owner: "${obs.subject_name}"`,
        `Source: ${obs.platform}`,
        "",
        "Input data:",
        JSON.stringify(combined, null, 2).slice(0, 3000),
        "",
        "Output the following JSON structure with values extracted from the input above:",
        '{',
        '  "entities": [{"name": "...", "type": "person|org|location", "role": "profile_owner|employer|contact"}],',
        '  "inferred_facts": [{"category": "employment|education|location|interest|skill|social", "key": "...", "value": "...", "confidence": 0-100}],',
        '  "topics": ["..."],',
        '  "summary": "One sentence describing this profile"',
        '}',
      ].join("\n");

      try {
        console.log(`[osint-enrich] Processing obs #${obs.id} (${obs.platform}/${obs.observation_type} — ${obs.subject_name})...`);

        const output = await callHaiku(prompt);

        // Strip markdown code fences if present, then extract JSON
        const cleaned = output.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
          const nlpResult = JSON.parse(jsonMatch[0]);

          await pool.query(
            `UPDATE kg_observations SET nlp_enriched = true, nlp_result = $2,
             entities_extracted = COALESCE($3, entities_extracted)
             WHERE id = $1`,
            [obs.id, JSON.stringify(nlpResult),
             nlpResult.entities ? JSON.stringify(nlpResult.entities) : null]
          );

          // Store inferred facts
          for (const fact of (nlpResult.inferred_facts || [])) {
            await fetch(`${BRIDGE_URL}/kg/subjects/${obs.subject_id}/facts`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                category: fact.category, key: fact.key,
                value: typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value),
                source: "kairos:nlp", confidence: fact.confidence || 50,
              }),
            }).catch(() => {});
          }

          enriched++;
          console.log(`[osint-enrich] ✓ obs #${obs.id}: ${nlpResult.summary || "enriched"}`);
        } else {
          console.log(`[osint-enrich] ✗ obs #${obs.id}: no JSON in output`);
          await pool.query(
            `UPDATE kg_observations SET nlp_enriched = true, nlp_result = $2 WHERE id = $1`,
            [obs.id, JSON.stringify({ error: "parse_failed", raw: output.slice(0, 500) })]
          );
        }
      } catch (err) {
        console.error(`[osint-enrich] ✗ obs #${obs.id}: ${err.message}`);
        // On API error, mark with error but allow retry
        await pool.query(
          `UPDATE kg_observations SET nlp_enriched = true, nlp_result = $2 WHERE id = $1`,
          [obs.id, JSON.stringify({ error: err.message.slice(0, 200) })]
        ).catch(() => {});
      }
    }

    console.log(`[osint-enrich] Done — enriched ${enriched}/${res.rows.length} observation(s)`);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error("[osint-enrich] Fatal:", err.message);
  process.exit(1);
});
