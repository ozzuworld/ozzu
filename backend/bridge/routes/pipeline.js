// routes/pipeline.js — Pipeline violations, build status, crash reports (extracted from server.js)

module.exports = function createPipelineRoutes(ctx) {
  const { log, sendJSON, parseBody, metrics, requireAuth,
          getDirectives, saveDirectives } = ctx;

  return async function handlePipelineRoutes(req, res, pathname, url) {
  if (req.method === "POST" && pathname === "/api/post-merge-deploy") {
    try {
      const body = await parseBody(req);
      const agentSpawner = require("./agent-spawner");

      // Check if smartDeploy already ran recently (within last 60s) to avoid double-trigger
      const lastDeployTime = agentSpawner._lastSmartDeployTime || 0;
      const elapsed = Date.now() - lastDeployTime;
      if (elapsed < 60000) {
        log(`[post-merge] smartDeploy already ran ${Math.round(elapsed / 1000)}s ago — skipping (triggered by ${body.trigger || "unknown"})`);
        sendJSON(res, 200, { ok: true, skipped: true, reason: "smartDeploy ran recently" });
        return;
      }

      log(`[post-merge] Safety net triggered by ${body.trigger || "unknown"} — running smartDeploy`);
      // Find the most recent completed directive to pass context
      const directives = getDirectives().filter((d) => d.status === "completed").sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
      const latestDirective = directives[0] || { id: "manual_merge", title: "Manual merge to main" };
      agentSpawner.smartDeploy(latestDirective);
      agentSpawner._lastSmartDeployTime = Date.now();
      sendJSON(res, 200, { ok: true, triggered: true, directive: latestDirective.id });
    } catch (err) {
      log(`[post-merge] Deploy trigger failed: ${err.message}`);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── Pipeline Violations API ──

  // POST /api/pipeline-violations — Record a violation (called by git hook or scanner)
  if (req.method === "POST" && pathname === "/api/pipeline-violations") {
    const data = await parseBody(req);
    const counter = ctx._pipelineViolationIdCounter;
    ctx._pipelineViolationIdCounter = counter + 1;
    const violation = {
      id: counter,
      timestamp: Date.now(),
      commitHash: data.commitHash || null,
      branch: data.branch || "unknown",
      author: data.author || "unknown",
      message: data.message || "",
      violationType: data.violationType || "unknown",
      directiveId: data.directiveId || null,
      resolved: false,
    };
    ctx._pipelineViolations.push(violation);
    if (ctx._pipelineViolations.length > 100) {
      ctx._pipelineViolations.shift();
    }
    metrics.trackPipelineViolation();
    log.directive.warn(`Pipeline violation: ${violation.violationType} by ${violation.author} on ${violation.branch}`);

    // Log to directive activity_log if we can infer one
    if (violation.directiveId) {
      const directives = getDirectives();
      const dir = directives.find(d => d.id === violation.directiveId);
      if (dir) {
        if (!Array.isArray(dir.activity_log)) dir.activity_log = [];
        dir.activity_log.push({
          timestamp: Date.now(),
          type: "pipeline_violation",
          actor: "system",
          message: `Pipeline violation detected: ${violation.violationType} by ${violation.author}`,
        });
        saveDirectives(directives);
      }
    }

    // Notify King Kazuma
    setTimeout(() => {
      try {
        ctx.engage("system notification");
        ctx.sendNotification(
          `[SYSTEM — Tell King Kazuma casually.]\nPipeline bypass detected: ${violation.violationType} by ${violation.author} on branch "${violation.branch}". Message: "${(violation.message || "").slice(0, 80)}"`
        );
      } catch (err) {
        log.directive.warn(`[pipeline-violation] Failed to send notification: ${err.message}`);
      }
    }, 500);

    sendJSON(res, 200, { ok: true, violation });
    return;
  }

  // GET /api/build-status — Latest GitHub Actions CI build status for Android and iOS
  if (req.method === "GET" && pathname === "/api/build-status") {
    // Return cached result if fresh
    const cacheTTL = ctx.BUILD_STATUS_CACHE_TTL || 120000;
    if (ctx._buildStatusCache && (Date.now() - ctx._buildStatusCacheTime) < cacheTTL) {
      sendJSON(res, 200, ctx._buildStatusCache);
      return;
    }

    const { execFile } = require("child_process");
    const { promisify } = require("util");
    const execFileAsync = promisify(execFile);
    const fields = "databaseId,status,conclusion,createdAt,headBranch,name,url";
    const ghArgs = (workflow) => ["run", "list", "--workflow=" + workflow, "-R", "ozzuworld/ozzu", "--limit", "3", "--json", fields];

    const results = { android: [], ios: [], cachedAt: Date.now() };
    try {
      const [androidResult, iosResult] = await Promise.all([
        execFileAsync("gh", ghArgs("build-android.yml"), { timeout: 15000 }).catch(err => ({ error: err.message })),
        execFileAsync("gh", ghArgs("build-ios.yml"), { timeout: 15000 }).catch(err => ({ error: err.message })),
      ]);
      if (androidResult.error) {
        log.bridge.warn(`[build-status] Failed to fetch android CI status: ${androidResult.error}`);
      } else {
        results.android = JSON.parse(androidResult.stdout).map(r => ({
          databaseId: r.databaseId,
          status: r.status,
          conclusion: r.conclusion || null,
          createdAt: r.createdAt,
          headBranch: r.headBranch,
          name: r.name,
          url: r.url,
        }));
      }
      if (iosResult.error) {
        log.bridge.warn(`[build-status] Failed to fetch ios CI status: ${iosResult.error}`);
      } else {
        results.ios = JSON.parse(iosResult.stdout).map(r => ({
          databaseId: r.databaseId,
          status: r.status,
          conclusion: r.conclusion || null,
          createdAt: r.createdAt,
          headBranch: r.headBranch,
          name: r.name,
          url: r.url,
        }));
      }
    } catch (err) {
      log.bridge.warn(`[build-status] Unexpected error: ${err.message}`);
      results.error = err.message;
    }
    ctx._buildStatusCache = results;
    ctx._buildStatusCacheTime = Date.now();
    sendJSON(res, 200, results);
    return;
  }

  if (req.method === "GET" && pathname === "/api/pipeline-violations") {
    const resolved = url.searchParams.get("resolved");
    let results = [...ctx._pipelineViolations].reverse();
    if (resolved === "false") {
      results = results.filter(v => !v.resolved);
    } else if (resolved === "true") {
      results = results.filter(v => v.resolved);
    }
    sendJSON(res, 200, results);
    return;
  }

  // POST /api/pipeline-violations/:id/resolve — Mark a violation as resolved
  if (req.method === "POST" && pathname.match(/^\/api\/pipeline-violations\/(\d+)\/resolve$/)) {
    if (!requireAuth(req, res)) return;
    const violationId = parseInt(RegExp.$1, 10);
    const violation = ctx._pipelineViolations.find(v => v.id === violationId);
    if (!violation) {
      sendJSON(res, 404, { error: "Violation not found" });
      return;
    }
    violation.resolved = true;
    violation.resolvedAt = Date.now();
    metrics.trackPipelineViolationResolved();
    sendJSON(res, 200, { ok: true, violation });
    return;
  }

  // ── Crash Reports ──

  // In-memory ring buffer for crash reports (last 200)
  if (!global._crashLogs) global._crashLogs = [];
  const crashLogs = global._crashLogs;
  const CRASH_LOG_MAX = 200;

  // POST /api/crash-reports — receive crash report from device
  if (req.method === "POST" && pathname === "/api/crash-reports") {
    try {
      const data = await parseBody(req);
      const entry = {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        deviceId: data.deviceId || "unknown",
        deviceType: data.deviceType || "unknown",
        platform: data.platform || "unknown",
        error: data.error || "Unknown error",
        stack: data.stack || null,
        componentStack: data.componentStack || null,
        context: data.context || null,
        appVersion: data.appVersion || null,
      };
      crashLogs.push(entry);
      if (crashLogs.length > CRASH_LOG_MAX) crashLogs.shift();
      console.error(`[crash-report] ${entry.deviceId} (${entry.platform}): ${entry.error}`);
      if (entry.stack) console.error(`[crash-report] Stack: ${entry.stack.split("\n").slice(0, 5).join("\n")}`);
      sendJSON(res, 200, { ok: true, id: entry.id });
    } catch (err) {
      sendJSON(res, 400, { error: err.message });
    }
    return;
  }

  // GET /api/crash-logs — query crash reports (for Cipher)
  if (req.method === "GET" && pathname === "/api/crash-logs") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const deviceId = url.searchParams.get("deviceId");
    const since = url.searchParams.get("since"); // ISO timestamp
    let logs = [...crashLogs].reverse(); // newest first
    if (deviceId) logs = logs.filter(l => l.deviceId === deviceId);
    if (since) {
      const sinceMs = new Date(since).getTime();
      logs = logs.filter(l => new Date(l.timestamp).getTime() >= sinceMs);
    }
    sendJSON(res, 200, { ok: true, count: logs.length, logs: logs.slice(0, limit) });
    return;
  }

  // DELETE /api/crash-logs — clear crash logs
  if (req.method === "DELETE" && pathname === "/api/crash-logs") {
    crashLogs.length = 0;
    sendJSON(res, 200, { ok: true, message: "Crash logs cleared" });
    return;
  }

    return false;
  };
};
