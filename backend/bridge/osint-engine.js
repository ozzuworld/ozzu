// OSINT Scanner Engine — module registry, rate limiter, scan orchestration, score calculation
const db = require("./db");
const correlator = require("./osint-correlator");
const remEngine = require("./osint-remediation-engine");
const { runIdentityClustering } = require("./osint-identity-cluster");
const pivotEngine = require("./osint-pivot-engine");
const ekfEngine = require("./osint-ekf-engine");

// ── Rate Limiter ──
class RateLimiter {
  constructor(maxConcurrent = 5, delayMs = 300) {
    this._max = maxConcurrent;
    this._delay = delayMs;
    this._active = 0;
    this._queue = [];
  }

  acquire() {
    return new Promise((resolve) => {
      const tryRun = () => {
        if (this._active < this._max) {
          this._active++;
          resolve(() => {
            this._active--;
            if (this._queue.length > 0) {
              const next = this._queue.shift();
              if (typeof next === "function") setTimeout(next, this._delay);
            }
          });
        } else {
          this._queue.push(tryRun);
        }
      };
      tryRun();
    });
  }
}

// ── Module Registry ──
const _modules = [];

function registerModule(mod) {
  if (!mod.name || !mod.profileTypes || !mod.scan) {
    throw new Error(`Invalid OSINT module: missing name, profileTypes, or scan`);
  }
  _modules.push(mod);
  console.log(`[osint] Registered module: ${mod.name} (${mod.profileTypes.join(", ")})`);
}

function getModulesForProfile(profileType) {
  return _modules.filter((m) => m.profileTypes.includes(profileType));
}

// ── Scan Orchestration ──
const _rateLimiter = new RateLimiter(5, 300);

async function runScan(profileId, scanType = "full") {
  const profile = await db.getOsintProfile(profileId);
  if (!profile) throw new Error(`Profile ${profileId} not found`);

  const modules = scanType === "full"
    ? getModulesForProfile(profile.profile_type)
    : _modules.filter((m) => m.name === scanType && m.profileTypes.includes(profile.profile_type));

  if (modules.length === 0) {
    throw new Error(`No modules available for profile type '${profile.profile_type}'${scanType !== "full" ? ` and scan type '${scanType}'` : ""}`);
  }

  const scanId = await db.createOsintScan(profileId, scanType, modules.map((m) => m.name));
  if (!scanId) throw new Error("Failed to create scan record");

  // Run async — don't block the response
  setImmediate(async () => {
    let totalFindings = 0;
    const scanStartTime = Date.now();
    const moduleResults = [];
    try {
      // Get score before scan for delta calculation
      let scoreBefore = 0;
      try {
        const preScore = await calculateExposureScore();
        scoreBefore = preScore.score;
      } catch (e) { /* ignore */ }

      await db.updateOsintScan(scanId, { status: "running" });

      for (const mod of modules) {
        const modStart = Date.now();
        let modFindings = 0;
        let modStatus = "success";
        let modError = null;
        try {
          const findings = await mod.scan(profile, _rateLimiter, { db });
          for (const finding of findings) {
            await db.upsertOsintFinding({
              scan_id: scanId,
              profile_id: profileId,
              module: mod.name,
              category: finding.category,
              severity: finding.severity,
              title: finding.title,
              description: finding.description,
              source_url: finding.sourceUrl || null,
              raw_data: finding.rawData || null,
              remediation: finding.remediation || null,
            });
            totalFindings++;
            modFindings++;
          }
        } catch (err) {
          console.error(`[osint] Module ${mod.name} error:`, err.message);
          modStatus = "error";
          modError = err.message;
        }
        const modDuration = Date.now() - modStart;
        moduleResults.push({ module: mod.name, duration: modDuration, findings: modFindings, status: modStatus, error: modError });
      }

      await db.updateOsintScan(scanId, {
        status: "completed",
        findings_count: totalFindings,
      });

      // Record operational metrics
      try {
        const totalDuration = Date.now() - scanStartTime;
        await db.recordOsintMetric(scanId, profileId, "scan_timing", totalDuration, { modules: modules.length, findings: totalFindings });
        for (const mr of moduleResults) {
          await db.recordOsintMetric(scanId, profileId, "module_perf", mr.findings, { module: mr.module, duration: mr.duration, status: mr.status, success: mr.status === "success", error: mr.error });
        }
        const postScore = await calculateExposureScore();
        const scoreDelta = postScore.score - scoreBefore;
        await db.recordOsintMetric(scanId, profileId, "score_delta", scoreDelta, { before: scoreBefore, after: postScore.score });
      } catch (metricErr) {
        console.error(`[osint] Metrics recording error:`, metricErr.message);
      }

      // Run entity correlation after scan completes
      try {
        await correlator.correlateScanResults(profileId, scanId);
      } catch (corrErr) {
        console.error(`[osint] Correlation error for scan ${scanId}:`, corrErr.message);
      }

      // Auto-remediation: triage noise + generate remediations + store stats
      try {
        const remResult = await remEngine.autoRemediate(profileId, scanId);
        console.log(`[osint] Auto-remediation: ${remResult.acknowledged} ack, ${remResult.falsePositives} FP, ${remResult.remediationsGenerated} remediations, ${remResult.remainingNew} remaining`);
        await db.updateOsintScan(scanId, {
          triage_stats: {
            autoAcked: remResult.acknowledged,
            autoFP: remResult.falsePositives,
            remediationsGenerated: remResult.remediationsGenerated,
            remainingNew: remResult.remainingNew,
          },
        });
      } catch (remErr) {
        console.error(`[osint] Auto-remediation error:`, remErr.message);
      }

      // Identity clustering — group entities into "same person" clusters
      try {
        await runIdentityClustering(profileId);
      } catch (clusterErr) {
        console.error(`[osint] Identity clustering error:`, clusterErr.message);
      }

      // EKF fusion — update state estimate with new observations
      try {
        const ekfState = await ekfEngine.fuseScanResults(profileId, scanId);
        if (ekfState) {
          console.log(`[osint] EKF fusion: ${ekfState.observationCount} observations, identity certainty: ${(ekfState.x[ekfEngine.STATE.IDENTITY_CERTAINTY] * 100).toFixed(1)}%`);
        }
      } catch (ekfErr) {
        console.error(`[osint] EKF fusion error:`, ekfErr.message);
      }

      // Pivot engine — auto-create profiles from identity discoveries (image profiles only)
      try {
        const profile_ = await db.getOsintProfile(profileId);
        if (profile_?.profile_type === "image") {
          const pivotResult = await pivotEngine.executePivots(profileId, scanId, { runScan });
          if (pivotResult.pivoted > 0) {
            console.log(`[osint] Pivot engine: created ${pivotResult.pivoted} new profiles from image scan`);
          }
        }
      } catch (pivotErr) {
        console.error(`[osint] Pivot engine error:`, pivotErr.message);
      }

      // Delta detection + alert generation
      try {
        await detectDeltasAndAlert(profileId, scanId, scoreBefore);
      } catch (deltaErr) {
        console.error(`[osint] Delta/alert error for scan ${scanId}:`, deltaErr.message);
      }

      // Auto-generate intelligence assessment (only for image profiles — they aggregate pivot data)
      try {
        const profile_ = await db.getOsintProfile(profileId);
        if (profile_?.profile_type === "image") {
          const analysisEngine = require("./osint-analysis-engine");
          const assessment = await analysisEngine.generateAssessment(profileId);
          console.log(`[osint] Auto-assessment: ${assessment.identityConfidence} confidence, ${assessment.keyFindings?.length || 0} key findings, exposure: ${assessment.exposureScore?.overall || 0}/100`);
        }
      } catch (assessErr) {
        console.error(`[osint] Auto-assessment error:`, assessErr.message);
      }
    } catch (err) {
      console.error(`[osint] Scan ${scanId} failed:`, err.message);
      await db.updateOsintScan(scanId, {
        status: "failed",
        error_message: err.message,
      });
    }
  });

  return { scanId, modulesQueued: modules.map((m) => m.name) };
}

// ── Scan All Profiles ──
async function runScanAll() {
  const profiles = await db.getOsintProfiles();
  if (!profiles || profiles.length === 0) {
    return { scans: [], message: "No active profiles to scan" };
  }

  const scans = [];
  for (const profile of profiles) {
    try {
      const result = await runScan(profile.id, "full");
      scans.push({ profileId: profile.id, label: profile.label, ...result });
    } catch (err) {
      scans.push({ profileId: profile.id, label: profile.label, error: err.message });
    }
  }

  return { scans, profilesScanned: profiles.length };
}

// ── Exposure Score Calculation ──
const SEVERITY_WEIGHTS = { critical: 10, high: 5, medium: 2, low: 1, info: 0 };

async function calculateExposureScore() {
  const counts = await db.getOsintFindingCounts();
  if (!counts) return { score: 0, breakdown: {}, totalFindings: 0 };

  let rawScore = 0;
  let totalFindings = 0;
  const breakdown = {};

  for (const row of counts) {
    const weight = SEVERITY_WEIGHTS[row.severity] || 0;
    const count = parseInt(row.count, 10);
    rawScore += weight * count;
    totalFindings += count;
    breakdown[row.severity] = count;
  }

  // Logarithmic normalize to 0-100
  const score = rawScore === 0 ? 0 : Math.min(100, Math.round(Math.log(rawScore + 1) * 20));

  return { score, breakdown, totalFindings };
}

// ── Score History + Snapshot ──
async function recordScoreSnapshot() {
  try {
    const { score, breakdown, totalFindings } = await calculateExposureScore();
    const profiles = await db.getOsintProfiles();
    await db.recordOsintScore(score, breakdown, totalFindings, profiles ? profiles.length : 0);
    console.log(`[osint] Score snapshot recorded: ${score}/100 (${totalFindings} findings)`);
    return { score, breakdown, totalFindings };
  } catch (err) {
    console.error("[osint] Failed to record score snapshot:", err.message);
    return null;
  }
}

// ── Delta Detection + Alerts ──

// Callback for broadcasting alerts (set by server.js)
let _alertBroadcast = null;
function setAlertBroadcast(fn) { _alertBroadcast = fn; }

async function detectDeltasAndAlert(profileId, scanId, scoreBefore) {
  // Get all findings for this scan (upsert updates scan_id on existing rows)
  const currentScanFindings = await db.getOsintFindings({ profileId, scanId, limit: 1000 });
  if (!currentScanFindings || currentScanFindings.length === 0) return;

  let newCount = 0;
  for (const f of currentScanFindings) {
    // A finding is genuinely new if it has no first_seen_at (never seen before)
    const isNew = !f.first_seen_at;
    if (isNew) {
      newCount++;
      // Update is_new flag
      try {
        await db.query(`UPDATE osint_findings SET is_new = true, first_seen_at = NOW() WHERE id = $1`, [f.id]);
      } catch {}

      // Generate alert for new critical/high findings (dedup handled in createOsintAlert)
      if (f.severity === "critical" || f.severity === "high") {
        const alert = await db.createOsintAlert({
          profile_id: profileId,
          alert_type: f.severity === "critical" ? "critical_finding" : "high_finding",
          severity: f.severity,
          title: `New ${f.severity}: ${f.title}`,
          description: f.description || f.title,
          finding_id: f.id,
        });
        if (alert && _alertBroadcast) {
          _alertBroadcast({ type: "osint_alert", alert });
        }
      }
    } else {
      // Update last_seen_at for existing findings
      try {
        await db.query(`UPDATE osint_findings SET is_new = false, last_seen_at = NOW() WHERE id = $1`, [f.id]);
      } catch {}
    }
  }

  // Score change alert
  try {
    const postScore = await calculateExposureScore();
    const delta = postScore.score - scoreBefore;
    if (delta > 10) {
      const alert = await db.createOsintAlert({
        profile_id: profileId,
        alert_type: "score_increase",
        severity: delta > 20 ? "high" : "medium",
        title: `Risk score increased by ${delta} points (${scoreBefore} → ${postScore.score})`,
        description: `${newCount} new finding(s) detected`,
      });
      if (alert && _alertBroadcast) {
        _alertBroadcast({ type: "osint_alert", alert });
      }
    }
  } catch {}
}

// ── Persistent Scheduled Scanning ──
let _scheduleTimer = null;
let _scheduleCheckInterval = null;

async function initScheduler() {
  // Check for due schedules every 5 minutes
  if (_scheduleCheckInterval) clearInterval(_scheduleCheckInterval);

  _scheduleCheckInterval = setInterval(async () => {
    try {
      await runDueSchedules();
    } catch (err) {
      console.error("[osint] Scheduler check error:", err.message);
    }
  }, 5 * 60 * 1000);

  // Run once on startup
  setTimeout(async () => {
    try { await runDueSchedules(); } catch {}
  }, 30000); // Wait 30s for DB to be ready

  console.log("[osint] Persistent scheduler initialized (checking every 5 min)");
}

async function runDueSchedules() {
  const schedules = await db.getOsintSchedules();
  const now = new Date();

  for (const sched of schedules) {
    if (!sched.is_active) continue;
    if (sched.next_run && new Date(sched.next_run) > now) continue;

    console.log(`[osint] Running scheduled scan for ${sched.profile_id ? `profile #${sched.profile_id}` : "all profiles"}`);
    try {
      if (sched.profile_id) {
        await runScan(sched.profile_id, "full");
      } else {
        await runScanAll();
      }

      // Update schedule
      const nextRun = new Date(Date.now() + sched.interval_hours * 3600000);
      await db.updateOsintSchedule(sched.id, { last_run: now, next_run: nextRun });

      // Record score snapshot 30s after
      setTimeout(() => recordScoreSnapshot(), 30000);
    } catch (err) {
      console.error(`[osint] Scheduled scan failed for schedule #${sched.id}:`, err.message);
    }
  }
}

// Legacy API compatibility
function startScheduledScans(intervalHours) {
  stopScheduledScans();
  if (!intervalHours || intervalHours <= 0) return;

  // Create a global schedule (null profile_id = scan all)
  db.upsertOsintSchedule({ profile_id: null, interval_hours: intervalHours }).catch(() => {});
  initScheduler();
}

function stopScheduledScans() {
  if (_scheduleCheckInterval) {
    clearInterval(_scheduleCheckInterval);
    _scheduleCheckInterval = null;
  }
  if (_scheduleTimer) {
    clearInterval(_scheduleTimer);
    _scheduleTimer = null;
  }
  console.log("[osint] Scheduled scans disabled");
}

function getScheduleStatus() {
  return {
    enabled: _scheduleCheckInterval !== null,
    persistent: true,
  };
}

function getRegisteredModules() {
  return _modules.map((m) => ({
    name: m.name,
    profileTypes: m.profileTypes,
    isCli: m.name.endsWith("-cli"),
  }));
}

module.exports = {
  registerModule,
  getModulesForProfile,
  getRegisteredModules,
  runScan,
  runScanAll,
  calculateExposureScore,
  recordScoreSnapshot,
  startScheduledScans,
  stopScheduledScans,
  getScheduleStatus,
  initScheduler,
  setAlertBroadcast,
  RateLimiter,
};
