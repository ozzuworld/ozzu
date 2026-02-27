// OSINT Continuous Monitoring — persistent scheduling, delta detection, push alerts
const db = require("./db");

let _timers = new Map(); // profileId -> timer
let _broadcastFn = null; // set by server.js

function setBroadcast(fn) {
  _broadcastFn = fn;
}

function broadcast(data) {
  if (_broadcastFn) _broadcastFn(data);
}

// ── Persistent Schedule Loader ──
// Called on startup: loads schedules from DB, sets up per-profile timers

async function loadSchedules(scanFn) {
  try {
    const schedules = await db.getOsintSchedules();
    console.log(`[osint-monitor] Loading ${schedules.length} schedule(s) from DB`);

    for (const sched of schedules) {
      if (!sched.is_active) continue;
      setupTimer(sched, scanFn);
    }

    // Cleanup old read alerts on startup
    await db.cleanupOldAlerts(30);
    console.log("[osint-monitor] Old alerts cleaned up");
  } catch (err) {
    console.error("[osint-monitor] Failed to load schedules:", err.message);
  }
}

function setupTimer(schedule, scanFn) {
  const profileId = schedule.profile_id;
  const intervalMs = (schedule.interval_hours || 24) * 3600000;

  // Clear existing timer for this profile
  if (_timers.has(profileId)) {
    clearInterval(_timers.get(profileId));
  }

  // Calculate time until next run
  const now = Date.now();
  const nextRun = schedule.next_run ? new Date(schedule.next_run).getTime() : now + intervalMs;
  const delay = Math.max(0, nextRun - now);

  console.log(`[osint-monitor] Schedule: profile ${profileId} every ${schedule.interval_hours}h, next run in ${Math.round(delay / 60000)}m`);

  // First run after calculated delay, then repeat at interval
  const timerId = setTimeout(async () => {
    await runScheduledScan(profileId, scanFn);

    // Set up recurring interval
    const intervalId = setInterval(async () => {
      await runScheduledScan(profileId, scanFn);
    }, intervalMs);

    _timers.set(profileId, intervalId);
  }, delay);

  _timers.set(profileId, timerId);
}

async function runScheduledScan(profileId, scanFn) {
  console.log(`[osint-monitor] Running scheduled scan for profile ${profileId}`);
  try {
    // Get findings before scan for delta detection
    const beforeFindings = await db.getOsintFindingsForDelta(profileId);

    // Run scan
    const result = await scanFn(profileId, "full");

    // Update schedule last_run and next_run
    const schedules = await db.getOsintSchedules();
    const sched = schedules.find((s) => s.profile_id === profileId);
    if (sched) {
      const intervalMs = (sched.interval_hours || 24) * 3600000;
      await db.updateOsintSchedule(sched.id, {
        last_run: new Date(),
        next_run: new Date(Date.now() + intervalMs),
      });
    }

    // Wait for scan to complete (findings are written async), then detect deltas
    setTimeout(async () => {
      try {
        await detectDeltas(profileId, beforeFindings);
      } catch (err) {
        console.error(`[osint-monitor] Delta detection error for profile ${profileId}:`, err.message);
      }
    }, 30000); // Wait 30s for findings to be written
  } catch (err) {
    console.error(`[osint-monitor] Scheduled scan error for profile ${profileId}:`, err.message);
  }
}

// ── Delta Detection ──

async function detectDeltas(profileId, previousFindings) {
  const currentFindings = await db.getOsintFindingsForDelta(profileId);

  // Build lookup by module+title (unique identifier for a finding)
  const prevMap = new Map();
  for (const f of previousFindings) {
    prevMap.set(`${f.module}::${f.title}`, f);
  }

  const currMap = new Map();
  for (const f of currentFindings) {
    currMap.set(`${f.module}::${f.title}`, f);
  }

  // New findings (in current but not in previous)
  const newFindings = [];
  for (const [key, finding] of currMap) {
    if (!prevMap.has(key)) {
      newFindings.push(finding);
    }
  }

  // Resolved findings (in previous but not in current)
  const resolvedFindings = [];
  for (const [key, finding] of prevMap) {
    if (!currMap.has(key)) {
      resolvedFindings.push(finding);
    }
  }

  // Mark current findings as seen
  const currentIds = currentFindings.map((f) => f.id);
  if (currentIds.length > 0) {
    await db.markFindingsSeen(currentIds);
  }

  // Create alerts for new findings
  const profile = await db.getOsintProfile(profileId);
  const profileLabel = profile ? profile.label : `Profile #${profileId}`;

  for (const finding of newFindings) {
    if (finding.severity === "info") continue; // Skip info-level new findings

    // Deduplication: check if same alert exists within 24h
    const recentAlerts = await db.getOsintAlerts({ profileId, limit: 100 });
    const isDuplicate = recentAlerts.some((a) =>
      a.title === finding.title &&
      a.alert_type === "new_finding" &&
      (Date.now() - new Date(a.created_at).getTime()) < 86400000
    );
    if (isDuplicate) continue;

    const alert = await db.createOsintAlert({
      profile_id: profileId,
      alert_type: "new_finding",
      severity: finding.severity,
      title: `New ${finding.severity} finding: ${finding.title}`,
      description: `Module: ${finding.module}\nProfile: ${profileLabel}`,
      finding_id: finding.id,
    });

    if (alert) {
      broadcast({
        type: "osintAlert",
        alert,
      });
    }
  }

  // Alert for resolved findings
  if (resolvedFindings.length > 0) {
    const significantResolved = resolvedFindings.filter((f) => f.severity !== "info");
    if (significantResolved.length > 0) {
      const alert = await db.createOsintAlert({
        profile_id: profileId,
        alert_type: "finding_resolved",
        severity: "info",
        title: `${significantResolved.length} finding(s) no longer detected for ${profileLabel}`,
        description: significantResolved.slice(0, 5).map((f) => f.title).join(", "),
      });

      if (alert) {
        broadcast({ type: "osintAlert", alert });
      }
    }
  }

  // Score delta alert
  if (newFindings.length > 0 || resolvedFindings.length > 0) {
    try {
      const osintEngine = require("./osint-engine");
      const score = await osintEngine.calculateExposureScore();

      // Check recent score history for delta
      const history = await db.getOsintScoreHistory(1); // last day
      if (history.length > 0) {
        const oldScore = history[0].score;
        const delta = score.score - oldScore;

        if (Math.abs(delta) >= 5) {
          const alert = await db.createOsintAlert({
            profile_id: profileId,
            alert_type: delta > 0 ? "score_increase" : "score_decrease",
            severity: delta > 10 ? "high" : "medium",
            title: `Exposure score ${delta > 0 ? "increased" : "decreased"} by ${Math.abs(delta)} points`,
            description: `Score: ${oldScore} → ${score.score}. New findings: ${newFindings.length}, Resolved: ${resolvedFindings.length}`,
          });

          if (alert) {
            broadcast({ type: "osintAlert", alert });
          }
        }
      }
    } catch { /* score calculation may fail */ }
  }

  // Log scan completion alert
  const alert = await db.createOsintAlert({
    profile_id: profileId,
    alert_type: "scan_complete",
    severity: "info",
    title: `Scheduled scan complete for ${profileLabel}`,
    description: `New: ${newFindings.length}, Resolved: ${resolvedFindings.length}, Total: ${currentFindings.length}`,
  });

  if (alert) {
    broadcast({ type: "osintAlert", alert });
  }

  console.log(`[osint-monitor] Delta: profile ${profileId} — ${newFindings.length} new, ${resolvedFindings.length} resolved`);
}

// ── Schedule Management ──

async function addSchedule(profileId, intervalHours, scanFn) {
  const sched = await db.upsertOsintSchedule({
    profile_id: profileId,
    interval_hours: intervalHours,
    is_active: true,
  });
  if (sched) {
    setupTimer(sched, scanFn);
  }
  return sched;
}

async function removeSchedule(profileId) {
  if (_timers.has(profileId)) {
    clearInterval(_timers.get(profileId));
    _timers.delete(profileId);
  }
  const schedules = await db.getOsintSchedules();
  const sched = schedules.find((s) => s.profile_id === profileId);
  if (sched) {
    await db.deleteOsintSchedule(sched.id);
  }
}

function stopAll() {
  for (const [, timer] of _timers) {
    clearInterval(timer);
  }
  _timers.clear();
  console.log("[osint-monitor] All schedules stopped");
}

module.exports = {
  setBroadcast,
  loadSchedules,
  detectDeltas,
  addSchedule,
  removeSchedule,
  stopAll,
};
