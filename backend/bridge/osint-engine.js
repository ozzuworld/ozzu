// OSINT Scanner Engine — module registry, rate limiter, scan orchestration, score calculation
const db = require("./db");
const correlator = require("./osint-correlator");

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
    try {
      await db.updateOsintScan(scanId, { status: "running" });

      for (const mod of modules) {
        try {
          const findings = await mod.scan(profile, _rateLimiter);
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
          }
        } catch (err) {
          console.error(`[osint] Module ${mod.name} error:`, err.message);
        }
      }

      await db.updateOsintScan(scanId, {
        status: "completed",
        findings_count: totalFindings,
      });

      // Run entity correlation after scan completes
      try {
        await correlator.correlateScanResults(profileId, scanId);
      } catch (corrErr) {
        console.error(`[osint] Correlation error for scan ${scanId}:`, corrErr.message);
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

// ── Scheduled Scanning ──
let _scheduleTimer = null;
let _scheduleIntervalMs = 0; // 0 = disabled

function startScheduledScans(intervalHours) {
  stopScheduledScans();
  if (!intervalHours || intervalHours <= 0) return;

  _scheduleIntervalMs = intervalHours * 60 * 60 * 1000;
  console.log(`[osint] Scheduled scans enabled: every ${intervalHours}h`);

  _scheduleTimer = setInterval(async () => {
    console.log("[osint] Running scheduled scan-all...");
    try {
      const result = await runScanAll();
      console.log(`[osint] Scheduled scan complete: ${result.profilesScanned} profiles, ${result.scans.length} scans`);

      // Record score snapshot after scheduled scan
      setTimeout(() => recordScoreSnapshot(), 30000); // Wait 30s for scans to finish
    } catch (err) {
      console.error("[osint] Scheduled scan failed:", err.message);
    }
  }, _scheduleIntervalMs);
}

function stopScheduledScans() {
  if (_scheduleTimer) {
    clearInterval(_scheduleTimer);
    _scheduleTimer = null;
    _scheduleIntervalMs = 0;
    console.log("[osint] Scheduled scans disabled");
  }
}

function getScheduleStatus() {
  return {
    enabled: _scheduleTimer !== null,
    intervalMs: _scheduleIntervalMs,
    intervalHours: _scheduleIntervalMs > 0 ? _scheduleIntervalMs / (60 * 60 * 1000) : 0,
  };
}

module.exports = {
  registerModule,
  getModulesForProfile,
  runScan,
  runScanAll,
  calculateExposureScore,
  recordScoreSnapshot,
  startScheduledScans,
  stopScheduledScans,
  getScheduleStatus,
  RateLimiter,
};
