"use strict";

// Jobs refresh worker (dir_1785424018953). Periodically re-runs the ingest so the inbox
// stays current. Unlike SECOP's Claude worker (expensive → default paused), this is just
// public-API HTTP, so it defaults ON. Runtime play/pause is the DB flag jobs_worker_state
// (the app button, checked each tick); env JOBS_WORKER=off is an emergency hard kill.

const schema = require("./schema");
const { runIngest } = require("./ingest");

const HARD_OFF = process.env.JOBS_WORKER === "off";
const TICK_MS = parseInt(process.env.JOBS_WORKER_TICK_MS) || 60 * 60 * 1000; // hourly refresh
const INITIAL_DELAY_MS = parseInt(process.env.JOBS_WORKER_INITIAL_MS) || 30 * 1000; // fill inbox ~30s after boot

let running = false;

async function isEnabled(db) {
  if (HARD_OFF) return false;
  const st = await schema.getWorkerState(db);
  return !!st.enabled;
}

async function tick(db) {
  if (running) return;
  running = true;
  try {
    if (!(await isEnabled(db))) return; // paused via app (or hard-off)
    await runIngest(db);
  } catch (e) {
    console.error(`[jobs-worker] tick: ${e.message}`);
  } finally {
    running = false;
  }
}

function startWorker(db) {
  if (HARD_OFF) { console.log("[jobs-worker] hard-disabled (JOBS_WORKER=off)"); return null; }
  console.log(`[jobs-worker] armed (tick ${Math.round(TICK_MS / 60000)}m); run/pause via app`);
  setTimeout(() => { tick(db).catch(() => {}); }, INITIAL_DELAY_MS); // seed the inbox on boot
  return setInterval(() => { tick(db).catch(() => {}); }, TICK_MS);
}

module.exports = { startWorker, isEnabled, tick };
