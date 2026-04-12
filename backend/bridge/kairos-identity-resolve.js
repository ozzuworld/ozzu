#!/usr/bin/env node
/**
 * KAIROS Identity Resolver — runs on HOST via cron
 * Processes pending identity candidates through the Fellegi-Sunter cascade.
 * For each subject with unresolved candidates, runs Stage 1 (free) and Stage 2 (ADB).
 *
 * Usage: node kairos-identity-resolve.js [--batch-size 3] [--max-stage 2]
 *
 * Directive: dir_1776009547123
 */

"use strict";

const BRIDGE_URL = process.env.BRIDGE_URL || "http://localhost:3333";
const BATCH_SIZE = parseInt(process.argv.find((a, i) => process.argv[i - 1] === "--batch-size") || "3");
const MAX_STAGE = parseInt(process.argv.find((a, i) => process.argv[i - 1] === "--max-stage") || "2");

async function main() {
  // Find subjects with pending identity candidates
  const subjectsResp = await fetch(`${BRIDGE_URL}/kg/subjects`);
  const subjects = await subjectsResp.json();

  let processed = 0;

  for (const subject of subjects) {
    if (processed >= BATCH_SIZE) break;

    // Check for pending candidates
    const candResp = await fetch(`${BRIDGE_URL}/kg/subjects/${subject.id}/identity-candidates?classification=pending`);
    const candidates = await candResp.json();

    if (candidates.length === 0) continue;

    console.log(`[identity-resolve] Subject "${subject.name}" (${subject.id}): ${candidates.length} pending candidates`);

    // Trigger resolution via bridge API
    try {
      const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subject.id}/identity-candidates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_stage: MAX_STAGE, max_adb: 5 }),
        signal: AbortSignal.timeout(120000),
      });
      const result = await resp.json();
      console.log(`[identity-resolve] ✓ ${subject.name}: ${result.message || "triggered"}`);
      processed++;
    } catch (err) {
      console.error(`[identity-resolve] ✗ ${subject.name}: ${err.message}`);
    }

    // Delay between subjects
    await new Promise(r => setTimeout(r, 5000));
  }

  if (processed === 0) {
    console.log("[identity-resolve] No subjects with pending candidates");
  } else {
    console.log(`[identity-resolve] Done ��� processed ${processed} subject(s)`);
  }
}

main().catch(err => {
  console.error("[identity-resolve] Fatal:", err.message);
  process.exit(1);
});
