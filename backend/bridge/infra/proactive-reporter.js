// proactive-reporter.js — Scheduled daily summary + event-triggered reports via June
// Delivers verbal summaries through sendNotification (June speaks to King Kazuma).
// Daily at configurable hour (default 9 AM ET). Also fires on critical event clusters.

"use strict";

const REPORT_HOUR_ET = 9;  // 9 AM Eastern Time
const REPORT_MINUTE = 0;
const CHECK_INTERVAL_MS = 60 * 1000; // Check every minute if it's time to report

let _ctx = null;
let _timer = null;
let _lastDailyReport = null; // Date string YYYY-MM-DD to avoid double-fire
let _lastEventReport = 0;    // Timestamp of last event-triggered report
const EVENT_REPORT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between event reports

// ── Public API ──

function start(ctx) {
  _ctx = ctx;
  _timer = setInterval(checkSchedule, CHECK_INTERVAL_MS);
  log("Started — daily report scheduled at 9 AM ET");
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  log("Stopped");
}

/**
 * Trigger an event-based report (e.g., multiple services down).
 * Rate-limited to avoid spam.
 */
function triggerEventReport(reason) {
  if (Date.now() - _lastEventReport < EVENT_REPORT_COOLDOWN_MS) {
    log(`Event report suppressed (cooldown): ${reason}`);
    return;
  }
  _lastEventReport = Date.now();
  buildAndDeliver(`event report: ${reason}`);
}

/**
 * Force a daily summary right now (manual trigger).
 */
async function forceDailySummary() {
  return buildAndDeliver("manual trigger");
}

function getStatus() {
  const now = new Date();
  const etTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const todayKey = etTime.toISOString().slice(0, 10);
  return {
    lastDailyReport: _lastDailyReport,
    todayReported: _lastDailyReport === todayKey,
    lastEventReport: _lastEventReport ? new Date(_lastEventReport).toISOString() : null,
    nextDailyAt: `${REPORT_HOUR_ET}:${String(REPORT_MINUTE).padStart(2, "0")} ET`,
    running: !!_timer,
  };
}

// ── Schedule check ──

function checkSchedule() {
  const now = new Date();
  // Convert to ET
  const etTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const todayKey = etTime.toISOString().slice(0, 10);

  if (etTime.getHours() === REPORT_HOUR_ET &&
      etTime.getMinutes() >= REPORT_MINUTE &&
      etTime.getMinutes() < REPORT_MINUTE + 2 &&
      _lastDailyReport !== todayKey) {
    _lastDailyReport = todayKey;
    buildAndDeliver("daily scheduled");
  }
}

// ── Build the summary ──

async function buildAndDeliver(trigger) {
  if (!_ctx) return;

  try {
    const summary = await buildSummary();
    if (!summary) {
      log(`No summary to deliver (trigger: ${trigger})`);
      return;
    }

    log(`Delivering summary (trigger: ${trigger}, ${summary.length} chars)`);

    // Deliver via June
    if (typeof _ctx.sendNotification === "function") {
      _ctx.sendNotification(summary);
    }

    // Also broadcast as WS event for the app
    if (typeof _ctx.broadcastToAll === "function") {
      _ctx.broadcastToAll({
        type: "dailySummary",
        trigger,
        summary,
        ts: new Date().toISOString(),
      });
    }
  } catch (err) {
    log(`Failed to build/deliver summary: ${err.message}`);
  }
}

async function buildSummary() {
  const parts = [];

  // 1. Directive status
  try {
    const directives = _ctx.getDirectives ? _ctx.getDirectives() : [];
    const active = directives.filter(d => ["in_progress", "planning", "planned", "approved", "pending"].includes(d.status));
    const needsAttention = directives.filter(d => ["blocked", "deploy_failed", "failed", "stale"].includes(d.status));
    const completedToday = directives.filter(d => {
      if (d.status !== "completed" || !d.completedAt) return false;
      const completed = new Date(d.completedAt);
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      return completed.getTime() > dayAgo;
    });

    if (needsAttention.length > 0) {
      parts.push(`${needsAttention.length} directive${needsAttention.length > 1 ? "s" : ""} need attention: ${needsAttention.map(d => `${d.title} is ${d.status}`).join(", ")}`);
    }
    if (completedToday.length > 0) {
      parts.push(`${completedToday.length} completed in the last 24 hours: ${completedToday.map(d => d.title).join(", ")}`);
    }
    if (active.length > 0) {
      parts.push(`${active.length} active project${active.length > 1 ? "s" : ""}`);
    }
  } catch {}

  // 2. Service health
  try {
    const watchdog = require("./watchdog");
    const status = watchdog.getStatus();
    const down = Object.entries(status).filter(([, v]) => v?.status === "down").map(([k]) => k);
    const degraded = Object.entries(status).filter(([, v]) => v?.status === "degraded").map(([k]) => k);

    if (down.length > 0) {
      parts.push(`Services DOWN: ${down.join(", ")}`);
    } else if (degraded.length > 0) {
      parts.push(`All services up, ${degraded.length} degraded: ${degraded.join(", ")}`);
    } else {
      parts.push("All services healthy");
    }
  } catch {}

  // 3. GPU status
  try {
    const http = require("http");
    const gpuData = await new Promise((resolve) => {
      const req = http.get("http://127.0.0.1:3333/ops/gpu", { timeout: 5000 }, (res) => {
        let body = ""; res.on("data", c => body += c);
        res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
    });
    if (gpuData?.instance) {
      const cost = gpuData.costSoFar ? `$${gpuData.costSoFar.toFixed(2)}` : "unknown cost";
      const util = gpuData.gpuUtil != null ? `${gpuData.gpuUtil}% utilized` : "utilization unknown";
      parts.push(`GPU: ${util}, ${cost} spent`);
    }
  } catch {}

  // 4. Face DB count
  try {
    const http = require("http");
    const qdrant = await new Promise((resolve) => {
      const req = http.get("http://127.0.0.1:6333/collections/faces", { timeout: 3000, headers: process.env.QDRANT_API_KEY ? { "api-key": process.env.QDRANT_API_KEY } : {} }, (res) => {
        let body = ""; res.on("data", c => body += c);
        res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
    });
    if (qdrant?.result?.points_count) {
      parts.push(`Face DB: ${(qdrant.result.points_count / 1000000).toFixed(1)}M faces`);
    }
  } catch {}

  // 5. Action queue
  try {
    const actionQueue = require("./action-queue");
    const actions = await actionQueue.pull({ limit: 5 });
    if (actions.length > 0) {
      parts.push(`${actions.length} pending action${actions.length > 1 ? "s" : ""} in the queue`);
    }
  } catch {}

  if (parts.length === 0) return null;

  // Build natural summary for June to speak
  return `Good morning King Kazuma. Here's your daily update. ${parts.join(". ")}.`;
}

function log(msg) {
  console.log(`[reporter] ${msg}`);
}

module.exports = { start, stop, triggerEventReport, forceDailySummary, getStatus };
