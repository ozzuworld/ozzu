// routes/pipeline.js — Pipeline violations, build status, crash reports, system health, OTA (extracted from server.js)

module.exports = function createPipelineRoutes(ctx) {
  const { log, sendJSON, parseBody, metrics, requireAuth,
          getDirectives, saveDirectives, getRunningAgents, getConfig, setConfig, getLogRing,
          anthropicUsage, db, redis, fs, path, crypto,
          CORS_HEADERS, PORT, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS,
          UPDATES_DIR, GEMINI_MODEL } = ctx;

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
    return true;
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
    return true;
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
    return true;
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
    return true;
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
    return true;
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
    return true;
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
    return true;
  }

  // DELETE /api/crash-logs — clear crash logs
  if (req.method === "DELETE" && pathname === "/api/crash-logs") {
    crashLogs.length = 0;
    sendJSON(res, 200, { ok: true, message: "Crash logs cleared" });
    return true;
  }

  // ── System / Infrastructure routes ──

  // GET / — root health check
  if (req.method === "GET" && pathname === "/") {
    const pgHealth = await db.healthCheck();
    sendJSON(res, 200, {
      service: "ozzu-bridge",
      uptime: process.uptime(),
      redis: ctx._redisConnected,
      postgres: pgHealth,
      gemini: !!ctx.geminiReady,
      devices: ctx.devices ? ctx.devices.size : 0,
      persona: ctx.currentPersona,
    });
    return true;
  }

  // GET /logs — serve recent bridge logs from in-memory ring buffer
  if (req.method === "GET" && pathname === "/logs") {
    const lines = Math.min(Math.max(parseInt(url.searchParams.get("lines")) || 100, 1), 500);
    const sinceParam = url.searchParams.get("since");
    let filtered = getLogRing();
    if (sinceParam) {
      const match = sinceParam.match(/^(\d+)([hms])$/);
      if (match) {
        const amount = parseInt(match[1]);
        const unit = match[2];
        const ms = unit === "h" ? amount * 3600000 : unit === "m" ? amount * 60000 : amount * 1000;
        const cutoff = new Date(Date.now() - ms).toISOString();
        filtered = filtered.filter(e => e.ts >= cutoff);
      }
    }
    const result = filtered.slice(-lines).map(e => `[${e.ts}] ${e.line}`).join("\n");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS });
    res.end(result || "(no logs captured yet)\n");
    return true;
  }

  // GET /config — read-only view of runtime configuration
  if (req.method === "GET" && pathname === "/config") {
    const cfg = getConfig();
    sendJSON(res, 200, {
      ...cfg,
      persona: ctx.currentPersona,
    });
    return true;
  }

  // PATCH /config — update safe runtime settings
  if (req.method === "PATCH" && pathname === "/config") {
    if (!requireAuth(req, res)) return true;
    const data = await parseBody(req);
    const errors = [];
    const updated = {};

    if (data.MAX_CONCURRENT_AGENTS !== undefined) {
      const v = parseInt(data.MAX_CONCURRENT_AGENTS);
      if (isNaN(v) || v < 1 || v > 4) {
        errors.push("MAX_CONCURRENT_AGENTS must be 1-4");
      } else {
        setConfig("MAX_CONCURRENT_AGENTS", v);
        updated.MAX_CONCURRENT_AGENTS = v;
      }
    }

    if (data.AGENT_TIMEOUT_MS !== undefined) {
      const v = parseInt(data.AGENT_TIMEOUT_MS);
      if (isNaN(v) || v < 300000 || v > 7200000) {
        errors.push("AGENT_TIMEOUT_MS must be 300000-7200000 (5min-2hr)");
      } else {
        setConfig("AGENT_TIMEOUT_MS", v);
        updated.AGENT_TIMEOUT_MS = v;
      }
    }

    if (data.LOG_LEVEL !== undefined) {
      const valid = ["debug", "info", "warn", "error"];
      if (!valid.includes(data.LOG_LEVEL)) {
        errors.push(`LOG_LEVEL must be one of: ${valid.join(", ")}`);
      } else {
        setConfig("LOG_LEVEL", data.LOG_LEVEL);
        updated.LOG_LEVEL = data.LOG_LEVEL;
      }
    }

    if (errors.length > 0) {
      sendJSON(res, 400, { error: "Validation failed", details: errors });
      return true;
    }

    if (Object.keys(updated).length === 0) {
      sendJSON(res, 400, { error: "No valid writable settings provided. Writable: MAX_CONCURRENT_AGENTS, AGENT_TIMEOUT_MS, LOG_LEVEL" });
      return true;
    }

    log.bridge.info(`Config updated: ${JSON.stringify(updated)}`);
    sendJSON(res, 200, { updated, config: { ...getConfig(), persona: ctx.currentPersona } });
    return true;
  }

  // GET /health — Full health check endpoint
  if (req.method === "GET" && pathname === "/health") {
    const pgHealth = await db.healthCheck();

    let redisHealthy = false;
    try {
      if (ctx._redisConnected) {
        await redis.ping();
        redisHealthy = true;
      }
    } catch { redisHealthy = false; }

    const directives = getDirectives();
    const dirStats = { pending: 0, planning: 0, planned: 0, approved: 0, in_progress: 0, completed: 0, failed: 0, stale: 0, blocked: 0 };
    const recentFailures = [];
    let totalRetries = 0;
    for (const d of directives) {
      if (dirStats[d.status] !== undefined) dirStats[d.status]++;
      if (d.retryCount) totalRetries += d.retryCount;
      if (d.failureReason && (d.status === "failed" || d.status === "stale")) {
        recentFailures.push({ id: d.id, title: d.title, status: d.status, failureReason: d.failureReason, retryCount: d.retryCount || 0 });
      }
    }

    const agents = getRunningAgents();
    const healthy = pgHealth.connected && redisHealthy;

    const deviceList = ctx.devices ? [...ctx.devices.values()].map(d => ({ deviceId: d.deviceId, role: d.role })) : [];

    sendJSON(res, healthy ? 200 : 503, {
      status: healthy ? "healthy" : "degraded",
      service: "ozzu-bridge",
      uptime: process.uptime(),
      serverStartedAt: ctx._serverStartedAt,
      restartCount: ctx._restartCount,
      lastRestartReason: ctx._lastRestartReason,
      previousStartedAt: ctx._previousStartedAt,
      agents: { active: agents.length, maxConcurrent: getConfig().MAX_CONCURRENT_AGENTS, details: agents.map(a => ({ directiveId: a.directiveId, type: a.type, pid: a.pid })) },
      directives: { ...dirStats, totalRetries, recentFailures },
      rateLimit: { windowMinutes: RATE_LIMIT_WINDOW_MS / 60000, max: RATE_LIMIT_MAX, recentCreations: ctx._directiveCreationTimestamps.filter(t => t > Date.now() - RATE_LIMIT_WINDOW_MS).length, totalHits: ctx._rateLimitHits },
      redis: { connected: redisHealthy },
      postgres: pgHealth,
      gemini: { connected: !!ctx.geminiReady, model: GEMINI_MODEL },
      voice: {
        deepgram: { configured: !!(process.env.DEEPGRAM_API_KEY && process.env.DEEPGRAM_API_KEY.trim()) },
        cartesia: { configured: !!(process.env.CARTESIA_API_KEY && process.env.CARTESIA_API_KEY.trim()) },
      },
      devices: deviceList,
      persona: ctx.currentPersona,
      cipherMode: ctx.cipherMode,
    });
    return true;
  }

  // GET /health/dev01 — check dev-01 (iOS deploy server) health
  if (req.method === "GET" && pathname === "/health/dev01") {
    const { execFile } = require("child_process");
    const { promisify } = require("util");
    const execFileAsync = promisify(execFile);
    try {
      const { stdout } = await execFileAsync("bash", [
        "/home/gcp/ozzu/scripts/deploy-ios.sh", "--check",
      ], { timeout: 15000, env: { ...process.env, PATH: process.env.PATH } });
      const lines = stdout.trim().split("\n");
      const jsonLine = lines[lines.length - 1];
      const health = JSON.parse(jsonLine);
      const ready = health.ssh && health.altserver;
      sendJSON(res, ready ? 200 : 503, { ready, ...health });
    } catch (err) {
      sendJSON(res, 503, { ready: false, ssh: false, altserver: false, iphone: false, error: err.message });
    }
    return true;
  }

  // GET /api/usage — aggregated usage metrics for dashboard
  if (req.method === "GET" && pathname === "/api/usage") {
    try {
      const snapshot = metrics.getSnapshot();
      const history = await metrics.getHistory(7);

      const connectedDevices = ctx.devices ? [...ctx.devices.values()] : [];
      const agents = getRunningAgents();
      metrics.setActiveAgents(agents.length);

      const directives = getDirectives();
      const dirStats = { completed: 0, failed: 0, totalDuration: 0, durationCount: 0 };
      const todayStr = new Date().toISOString().slice(0, 10);
      const todayDirStats = { submitted: 0, completed: 0, failed: 0 };
      for (const d of directives) {
        if (d.status === "completed") dirStats.completed++;
        if (d.status === "failed") dirStats.failed++;
        if (d.duration) { dirStats.totalDuration += d.duration; dirStats.durationCount++; }
        const dDate = new Date(d.createdAt).toISOString().slice(0, 10);
        if (dDate === todayStr) {
          todayDirStats.submitted++;
          if (d.status === "completed") todayDirStats.completed++;
          if (d.status === "failed") todayDirStats.failed++;
        }
      }
      const successRate = (dirStats.completed + dirStats.failed) > 0
        ? Math.round((dirStats.completed / (dirStats.completed + dirStats.failed)) * 100)
        : null;
      const avgDurationMs = dirStats.durationCount > 0
        ? Math.round(dirStats.totalDuration / dirStats.durationCount)
        : null;

      sendJSON(res, 200, {
        today: snapshot,
        history,
        live: {
          voiceLatency: ctx._latencyStats,
          activeDevices: connectedDevices.map(d => ({
            deviceId: d.deviceId,
            deviceType: d.deviceType,
            role: d.role,
            zone: d.zone,
          })),
          memoryMB: {
            heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
          },
          uptimeSeconds: Math.round(process.uptime()),
          persona: ctx.currentPersona,
          cipherMode: ctx.cipherMode,
          agents: {
            active: agents.length,
            max: getConfig().MAX_CONCURRENT_AGENTS,
            details: agents.map(a => ({ directiveId: a.directiveId, type: a.type, pid: a.pid })),
          },
          directives: {
            successRate,
            avgDurationMs,
            today: todayDirStats,
          },
        },
      });
    } catch (err) {
      log.bridge.error("Usage metrics error:", err.message);
      sendJSON(res, 500, { error: "Failed to collect usage metrics" });
    }
    return true;
  }

  // GET /api/anthropic-usage — Anthropic Admin API usage data
  if (req.method === "GET" && pathname === "/api/anthropic-usage") {
    try {
      if (!anthropicUsage.isConfigured()) {
        sendJSON(res, 200, {
          isConfigured: false,
          rateLimits: null,
          daily: null,
          hourly: null,
          costs: null,
        });
        return true;
      }

      const [daily, hourly, costs] = await Promise.all([
        anthropicUsage.fetchDailyUsage(),
        anthropicUsage.fetchHourlyUsage(),
        anthropicUsage.fetchCostReport(),
      ]);

      const rateLimits = anthropicUsage.getRateLimits();

      sendJSON(res, 200, {
        isConfigured: true,
        rateLimits,
        daily,
        hourly,
        costs,
      });
    } catch (err) {
      log.bridge.error("Anthropic usage fetch error:", err.message);
      sendJSON(res, 500, { error: "Failed to fetch Anthropic usage data" });
    }
    return true;
  }

  // ── OTA Update endpoints ──

  // GET /api/manifest — Expo Updates protocol v1
  if (req.method === "GET" && pathname === "/api/manifest") {
    const platform = req.headers["expo-platform"] || "android";
    const runtimeVersion = req.headers["expo-runtime-version"] || "1.0.0";
    const currentUpdateId = req.headers["expo-current-update-id"];

    const updateDir = path.join(UPDATES_DIR, runtimeVersion);
    const metadataPath = path.join(updateDir, "metadata.json");

    let metadataExists = true;
    try { await fs.promises.access(metadataPath); } catch { metadataExists = false; }
    if (!metadataExists) {
      const boundary = "ota-boundary";
      res.writeHead(200, {
        "expo-protocol-version": "1",
        "expo-sfv-version": "0",
        "cache-control": "private, max-age=0",
        "content-type": `multipart/mixed; boundary=${boundary}`,
        ...CORS_HEADERS,
      });
      res.end(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="directive"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        `{"type":"noUpdateAvailable"}\r\n` +
        `--${boundary}--\r\n`
      );
      return true;
    }

    let metadata, metaRaw;
    try {
      metaRaw = await fs.promises.readFile(metadataPath, "utf8");
      metadata = JSON.parse(metaRaw);
    } catch (err) {
      log.bridge.error(`OTA metadata parse failed: ${err.message}`);
      sendJSON(res, 500, { error: "Corrupt OTA metadata" });
      return true;
    }
    // iPhone NEVER receives OTA updates
    if (platform === "ios") {
      const boundary = "ota-boundary";
      res.writeHead(200, {
        "expo-protocol-version": "1",
        "expo-sfv-version": "0",
        "cache-control": "private, max-age=0",
        "content-type": `multipart/mixed; boundary=${boundary}`,
        ...CORS_HEADERS,
      });
      res.end(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="directive"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        `{"type":"noUpdateAvailable"}\r\n` +
        `--${boundary}--\r\n`
      );
      return true;
    }

    const platformMeta = metadata.fileMetadata?.[platform];
    if (!platformMeta) {
      sendJSON(res, 404, { error: `No ${platform} update found` });
      return true;
    }

    const metaHash = crypto.createHash("sha256").update(metaRaw).digest("hex");
    const updateId = `${metaHash.slice(0,8)}-${metaHash.slice(8,12)}-${metaHash.slice(12,16)}-${metaHash.slice(16,20)}-${metaHash.slice(20,32)}`;

    if (currentUpdateId === updateId) {
      const boundary = "ota-boundary";
      res.writeHead(200, {
        "expo-protocol-version": "1",
        "expo-sfv-version": "0",
        "cache-control": "private, max-age=0",
        "content-type": `multipart/mixed; boundary=${boundary}`,
        ...CORS_HEADERS,
      });
      res.end(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="directive"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        `{"type":"noUpdateAvailable"}\r\n` +
        `--${boundary}--\r\n`
      );
      return true;
    }

    const bundlePath = path.join(updateDir, platformMeta.bundle);
    let bundleData;
    try {
      bundleData = await fs.promises.readFile(bundlePath);
    } catch (err) {
      log.bridge.error(`OTA bundle missing: ${platformMeta.bundle} — returning noUpdateAvailable`);
      const boundary = "ota-boundary";
      res.writeHead(200, {
        "expo-protocol-version": "1",
        "expo-sfv-version": "0",
        "cache-control": "private, max-age=0",
        "content-type": `multipart/mixed; boundary=${boundary}`,
        ...CORS_HEADERS,
      });
      res.end(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="directive"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        `{"type":"noUpdateAvailable"}\r\n` +
        `--${boundary}--\r\n`
      );
      return true;
    }
    const bundleHash = crypto.createHash("sha256").update(bundleData).digest("base64url");
    const bundleKey = crypto.createHash("md5").update(bundleData).digest("hex");

    const baseUrl = `http://10.8.0.1:${PORT}/api/assets?runtimeVersion=${runtimeVersion}&platform=${platform}`;

    const launchAsset = {
      hash: bundleHash,
      key: bundleKey,
      fileExtension: ".bundle",
      contentType: "application/javascript",
      url: `${baseUrl}&asset=${encodeURIComponent(platformMeta.bundle)}`,
    };

    const assetResults = await Promise.all((platformMeta.assets || []).map(async (a) => {
      const assetPath = path.join(updateDir, a.path);
      try {
        const assetData = await fs.promises.readFile(assetPath);
        return {
          hash: crypto.createHash("sha256").update(assetData).digest("base64url"),
          key: crypto.createHash("md5").update(assetData).digest("hex"),
          fileExtension: `.${a.ext}`,
          contentType: a.ext === "png" ? "image/png" : a.ext === "jpg" ? "image/jpeg" : "application/octet-stream",
          url: `${baseUrl}&asset=${encodeURIComponent(a.path)}`,
        };
      } catch (err) {
        log.bridge.error(`OTA asset missing: ${a.path} — skipping`);
        return null;
      }
    }));
    const assets = assetResults.filter(Boolean);

    const expoConfigPath = path.join(updateDir, "expoConfig.json");
    let expoClient = {};
    try { expoClient = JSON.parse(await fs.promises.readFile(expoConfigPath, "utf8")); } catch (err) {
      if (err.code !== "ENOENT") log.bridge.warn(`[OTA] Failed to parse expoConfig.json: ${err.message}`);
    }

    const stat = await fs.promises.stat(metadataPath);
    const createdAt = stat.mtime.toISOString();

    const manifest = {
      id: updateId,
      createdAt,
      runtimeVersion,
      launchAsset,
      assets,
      metadata: {},
      extra: { expoClient },
    };

    const boundary = "ota-boundary";
    const manifestJson = JSON.stringify(manifest);
    const extensionsJson = JSON.stringify({ assetRequestHeaders: {} });

    res.writeHead(200, {
      "expo-protocol-version": "1",
      "expo-sfv-version": "0",
      "cache-control": "private, max-age=0",
      "content-type": `multipart/mixed; boundary=${boundary}`,
      ...CORS_HEADERS,
    });
    res.end(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="manifest"\r\n` +
      `Content-Type: application/json; charset=utf-8\r\n\r\n` +
      `${manifestJson}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="extensions"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${extensionsJson}\r\n` +
      `--${boundary}--\r\n`
    );
    return true;
  }

  // GET /api/assets — Serve OTA update assets
  if (req.method === "GET" && pathname === "/api/assets") {
    const runtimeVersion = url.searchParams.get("runtimeVersion") || "1.0.0";
    const assetPath = url.searchParams.get("asset");
    if (!assetPath) {
      sendJSON(res, 400, { error: "Missing asset parameter" });
      return true;
    }

    const allowedBase = path.resolve(UPDATES_DIR, runtimeVersion);
    const filePath = path.resolve(UPDATES_DIR, runtimeVersion, assetPath);
    if (!filePath.startsWith(allowedBase + path.sep) && filePath !== allowedBase) {
      sendJSON(res, 403, { error: "Forbidden" });
      return true;
    }

    try { await fs.promises.access(filePath); } catch {
      sendJSON(res, 404, { error: "Asset not found" });
      return true;
    }

    const ext = path.extname(assetPath).toLowerCase();
    const contentTypes = {
      ".hbc": "application/javascript",
      ".bundle": "application/javascript",
      ".js": "application/javascript",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".gif": "image/gif",
    };

    res.writeHead(200, {
      "Content-Type": contentTypes[ext] || "application/octet-stream",
      ...CORS_HEADERS,
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

    return false;
  };
};
