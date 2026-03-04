"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

module.exports = function directiveRoutes(ctx) {
  const { sendJSON, parseBody, requireAuth, db, log, metrics,
          getDirectives, saveDirectives, findSimilarDirective,
          getApprovals, saveApprovals, expireApprovals,
          getEpics, saveEpics, deriveEpicStatus, getEpicProgress, updateEpicProgress, getNextEpicPhase,
          getRunningAgents, killAgent, smartDeploy,
          buildVerifier, CORS_HEADERS, DIRECTIVE_TEMPLATES,
          _directiveCreationTimestamps,
          engage, sendNotification,
          routeDirective, mergeWorktreeToMain, cleanupWorktree,
          broadcastToAll, setLastRestartReason, getConfig,
          MAX_DIRECTIVES, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, DATA_DIR } = ctx;

  return async function(req, res, pathname, url) {

    if (req.method === "POST" && pathname === "/directives") {
      if (!requireAuth(req, res)) return true;
      // Rate limit: max 10 directives per 5 minutes (sliding window)
      const now = Date.now();
      while (_directiveCreationTimestamps.length > 0 && _directiveCreationTimestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
        _directiveCreationTimestamps.shift();
      }
      if (_directiveCreationTimestamps.length >= RATE_LIMIT_MAX) {
        ctx._rateLimitHits = (ctx._rateLimitHits || 0) + 1;
        const oldestInWindow = _directiveCreationTimestamps[0];
        const retryAfterSec = Math.ceil((oldestInWindow + RATE_LIMIT_WINDOW_MS - now) / 1000);
        res.setHeader("Retry-After", String(retryAfterSec));
        sendJSON(res, 429, { error: `Rate limit exceeded: max ${RATE_LIMIT_MAX} directives per ${RATE_LIMIT_WINDOW_MS / 60000} minutes`, retryAfter: retryAfterSec });
        return true;
      }
      const data = await parseBody(req);
      const validTypes = ["quick", "feature", "explore", "epic"];
      if (!data.type || !validTypes.includes(data.type)) {
        sendJSON(res, 400, { error: "type must be one of: quick, feature, explore, epic" });
        return true;
      }
      if (!data.description) {
        sendJSON(res, 400, { error: "description is required" });
        return true;
      }
      // Duplicate detection
      const existing = findSimilarDirective(data.title);
      if (existing) {
        sendJSON(res, 409, { error: `Similar directive already exists: "${existing.title}" [${existing.status}] (${existing.id})` });
        return true;
      }
      // Validate epicId if provided (must reference an existing epic-type directive)
      if (data.epicId) {
        const epicParent = getDirectives().find(d => d.id === data.epicId);
        if (!epicParent) {
          sendJSON(res, 400, { error: `Epic not found: ${data.epicId}` });
          return true;
        }
        if (epicParent.type !== "epic") {
          sendJSON(res, 400, { error: `Directive ${data.epicId} is not an epic (type: ${epicParent.type})` });
          return true;
        }
      }
      // Validate dependsOn if provided
      const dependsOn = Array.isArray(data.dependsOn) ? data.dependsOn : [];
      if (dependsOn.length > 0) {
        const existingDirectives = getDirectives();
        const invalidIds = dependsOn.filter(id => !existingDirectives.find(d => d.id === id));
        if (invalidIds.length > 0) {
          sendJSON(res, 400, { error: `Unknown dependency IDs: ${invalidIds.join(", ")}` });
          return true;
        }
      }
      // Auto-chain phases: if epicId + phaseOrder > 1, auto-set dependsOn to previous phase
      if (data.epicId && data.phaseOrder && data.phaseOrder > 1) {
        const siblingPhases = getDirectives().filter(d => d.epicId === data.epicId && d.phaseOrder != null);
        const prevPhase = siblingPhases.find(d => d.phaseOrder === data.phaseOrder - 1);
        if (prevPhase && !dependsOn.includes(prevPhase.id)) {
          dependsOn.push(prevPhase.id);
        }
      }

      const priority = [1, 2, 3, 4].includes(data.priority) ? data.priority : 3;
      const directive = {
        id: `dir_${Date.now()}`,
        type: data.type,
        title: data.title || "",
        description: data.description,
        emoji: data.emoji || null,
        status: "pending",
        plan: data.type === "epic" ? (data.plan || null) : null,
        directiveApprovalId: null,
        retryCount: 0,
        failureReason: null,
        priority,
        dependsOn: dependsOn.length > 0 ? dependsOn : null,
        epicId: data.epicId || null,
        phaseOrder: data.phaseOrder || null,
        createdBy: data.createdBy || "King Kazuma",
        activity_log: [{ timestamp: Date.now(), type: "status_change", actor: data.createdBy || "King Kazuma", message: "Directive created with status: pending" }],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // Check if all dependencies are completed
      const depsResolved = !directive.dependsOn || directive.dependsOn.every(depId => {
        const dep = getDirectives().find(d => d.id === depId);
        return dep && dep.status === "completed";
      });

      // Auto-transition quick and explore directives straight to planning (triggers agent spawner)
      // But only if dependencies are resolved
      if ((data.type === "quick" || data.type === "explore") && depsResolved) {
        directive.status = "planning";
      }

      const directives = getDirectives();
      directives.push(directive);
      // Evict oldest terminal directives first (never evict active ones)
      const ACTIVE_STATUSES = new Set(["planning", "planned", "approved", "in_progress", "pending"]);
      while (directives.length > MAX_DIRECTIVES) {
        const evictIdx = directives.findIndex(d => !ACTIVE_STATUSES.has(d.status));
        if (evictIdx === -1) break; // all active — allow overflow rather than lose work
        directives.splice(evictIdx, 1);
      }
      saveDirectives(directives, directive, null, "King Kazuma");
      _directiveCreationTimestamps.push(Date.now());

      // Spawn planning agent for quick directives (already in planning status)
      if (directive.status === "planning") {
        setLastRestartReason(`directive: ${directive.title || directive.id}`);
        routeDirective(directive, "planning");
      }

      sendJSON(res, 200, { ok: true, directive, blockedByDeps: !depsResolved && directive.dependsOn ? true : undefined });
      return true;
    }

    // GET /templates — List directive templates
    if (req.method === "GET" && pathname === "/templates") {
      sendJSON(res, 200, DIRECTIVE_TEMPLATES);
      return true;
    }

    // GET /directives — List directives (optional ?status= filter)
    if (req.method === "GET" && pathname === "/directives") {
      const statusFilter = url.searchParams.get("status");
      let directives = getDirectives();
      if (statusFilter) {
        directives = directives.filter((d) => d.status === statusFilter);
      }
      sendJSON(res, 200, directives);
      return true;
    }

    // GET /directives/stats — Pipeline analytics
    if (req.method === "GET" && pathname === "/directives/stats") {
      const directives = getDirectives();
      const agents = getRunningAgents();
      const now = Date.now();
      const todayStart = new Date().setHours(0, 0, 0, 0);

      // By status
      const byStatus = {};
      for (const d of directives) {
        byStatus[d.status] = (byStatus[d.status] || 0) + 1;
      }

      // By type
      const byType = {};
      for (const d of directives) {
        byType[d.type] = (byType[d.type] || 0) + 1;
      }

      // Average duration (completed directives with timing data)
      const completedWithDuration = directives.filter(d => d.status === "completed" && d.duration);
      const averageDuration = completedWithDuration.length > 0
        ? Math.round(completedWithDuration.reduce((sum, d) => sum + d.duration, 0) / completedWithDuration.length)
        : null;

      // Success rate
      const completed = directives.filter(d => d.status === "completed").length;
      const failed = directives.filter(d => d.status === "failed").length;
      const successRate = (completed + failed) > 0
        ? Math.round((completed / (completed + failed)) * 10000) / 100
        : null;

      // Today stats
      const todayDirectives = directives.filter(d => d.createdAt >= todayStart);
      const todayStats = {
        submitted: todayDirectives.length,
        completed: todayDirectives.filter(d => d.status === "completed").length,
        failed: todayDirectives.filter(d => d.status === "failed").length,
      };

      // Top failure reasons
      const reasonCounts = {};
      for (const d of directives) {
        if (d.status === "failed" && d.failureReason) {
          reasonCounts[d.failureReason] = (reasonCounts[d.failureReason] || 0) + 1;
        }
      }
      const topFailureReasons = Object.entries(reasonCounts)
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count);

      // Agent utilization
      const agentUtilization = {
        active: agents.length,
        max: getConfig().MAX_CONCURRENT_AGENTS,
        utilization: Math.round((agents.length / getConfig().MAX_CONCURRENT_AGENTS) * 10000) / 100,
      };

      sendJSON(res, 200, {
        totalDirectives: directives.length,
        byStatus,
        byType,
        averageDuration,
        successRate,
        todayStats,
        topFailureReasons,
        agentUtilization,
      });
      return true;
    }

    // GET /agents — List running agent subprocesses
    if (req.method === "GET" && pathname === "/agents") {
      sendJSON(res, 200, getRunningAgents());
      return true;
    }

    // DELETE /agents/:directiveId — Kill a running agent
    const agentDeleteMatch = pathname.match(/^\/agents\/([^/]+)$/);
    if (req.method === "DELETE" && agentDeleteMatch) {
      if (!requireAuth(req, res)) return true;
      const directiveId = agentDeleteMatch[1];
      const killed = killAgent(directiveId);
      if (killed) {
        sendJSON(res, 200, { ok: true, message: `Agent for ${directiveId} killed` });
      } else {
        sendJSON(res, 404, { error: `No running agent for ${directiveId}` });
      }
      return true;
    }

    // GET /directives/:id — Single directive with full plan text
    const directiveGetMatch = pathname.match(/^\/directives\/([^/]+)$/);
    if (req.method === "GET" && directiveGetMatch) {
      const id = directiveGetMatch[1];
      const directives = getDirectives();
      const directive = directives.find((d) => d.id === id);
      if (!directive) {
        sendJSON(res, 404, { error: "Directive not found" });
        return true;
      }
      // If this is an epic, include its phases (child directives)
      if (directive.type === "epic") {
        const phases = directives
          .filter(d => d.epicId === id)
          .sort((a, b) => (a.phaseOrder || 0) - (b.phaseOrder || 0));
        sendJSON(res, 200, { ...directive, phases });
      } else {
        sendJSON(res, 200, directive);
      }
      return true;
    }

    // GET /directives/:id/log — View agent log file for a directive
    const directiveLogMatch = pathname.match(/^\/directives\/([^/]+)\/log$/);
    if (req.method === "GET" && directiveLogMatch) {
      const id = directiveLogMatch[1];
      const directives = getDirectives();
      const directive = directives.find((d) => d.id === id);
      if (!directive) {
        res.writeHead(404, { "Content-Type": "text/plain", ...CORS_HEADERS });
        res.end("Directive not found");
        return true;
      }
      // Path traversal protection: sanitize id and verify resolved path stays within DATA_DIR
      const sanitizedId = path.basename(id);
      const logPath = path.resolve(DATA_DIR, `agent-${sanitizedId}.log`);
      if (!logPath.startsWith(DATA_DIR + path.sep) && logPath !== DATA_DIR) {
        res.writeHead(400, { "Content-Type": "text/plain", ...CORS_HEADERS });
        res.end("Invalid directive ID");
        return true;
      }
      const limit = parseInt(url.searchParams.get("limit")) || 200;
      try {
        await fs.promises.access(logPath);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain", ...CORS_HEADERS });
        res.end("Log file not found");
        return true;
      }
      try {
        const content = await fs.promises.readFile(logPath, "utf-8");
        const lines = content.split("\n");
        const output = lines.slice(-limit).join("\n");
        res.writeHead(200, { "Content-Type": "text/plain", ...CORS_HEADERS });
        res.end(output);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain", ...CORS_HEADERS });
        res.end(`Error reading log: ${err.message}`);
      }
      return true;
    }

    // GET /directives/:id/progress — Epic progress (phases completed/total/current/next)
    const directiveProgressMatch = pathname.match(/^\/directives\/([^/]+)\/progress$/);
    if (req.method === "GET" && directiveProgressMatch) {
      const id = directiveProgressMatch[1];
      const directives = getDirectives();
      const directive = directives.find((d) => d.id === id);
      if (!directive) {
        sendJSON(res, 404, { error: "Directive not found" });
        return true;
      }
      if (directive.type !== "epic") {
        sendJSON(res, 400, { error: "Progress is only available for epic-type directives" });
        return true;
      }
      const progress = getEpicProgress(id);
      sendJSON(res, 200, progress);
      return true;
    }

    // PATCH /directives/:id — Update directive (status, plan, title)
    const directivePatchMatch = pathname.match(/^\/directives\/([^/]+)$/);
    if (req.method === "PATCH" && directivePatchMatch) {
      if (!requireAuth(req, res)) return true;
      const id = directivePatchMatch[1];
      const data = await parseBody(req);
      const directives = getDirectives();
      const directive = directives.find((d) => d.id === id);
      if (!directive) {
        sendJSON(res, 404, { error: "Directive not found" });
        return true;
      }

      // Apply updates
      const VALID_STATUSES = new Set(["pending", "planning", "planned", "approved", "in_progress", "completed", "failed", "stale", "cancelled", "blocked", "deploy_failed"]);
      const prevStatus = directive.status;
      if (data.status) {
        if (!VALID_STATUSES.has(data.status)) {
          sendJSON(res, 400, { error: `Invalid status: "${data.status}". Valid: ${[...VALID_STATUSES].join(", ")}` });
          return true;
        }
        directive.status = data.status;
      }
      if (data.plan !== undefined) directive.plan = data.plan;
      if (data.title) directive.title = data.title;
      if (data.type) directive.type = data.type;
      if (data.failureReason !== undefined) directive.failureReason = data.failureReason;
      if (data.retryCount !== undefined) directive.retryCount = data.retryCount;
      if (data.mergeBranch !== undefined) directive.mergeBranch = data.mergeBranch;
      if (data.priority !== undefined && [1, 2, 3, 4].includes(data.priority)) directive.priority = data.priority;
      if (data.buildRuns !== undefined) directive.buildRuns = data.buildRuns;
      if (data.emoji !== undefined) directive.emoji = data.emoji;
      if (data.epicId !== undefined) directive.epicId = data.epicId;
      if (data.phaseOrder !== undefined) directive.phaseOrder = data.phaseOrder;
      directive.updatedAt = Date.now();
      directive.lastActivity = Date.now(); // Track when agent last touched this directive

      // Determine actor: request body can specify, otherwise infer from context
      const patchActor = data.actor || "Cipher";

      // Initialize activity_log if missing (for older directives)
      if (!Array.isArray(directive.activity_log)) directive.activity_log = [];

      // Enforce build verification before marking completed
      if (data.status === "completed" && prevStatus !== "completed") {
        const vr = directive.verification_result;
        const VERIFICATION_VALIDITY_MS = 15 * 60 * 1000; // 15 minutes
        if (!vr || !vr.success || (Date.now() - vr.verified_at) > VERIFICATION_VALIDITY_MS) {
          const reason = !vr ? "no verification run"
            : !vr.success ? `verification failed: ${vr.failure_reason}`
            : "verification expired (older than 15 minutes)";
          directive.activity_log.push({ timestamp: Date.now(), type: "completion_blocked", actor: "system", message: `Completion blocked — ${reason}` });
          saveDirectives(directives, directive, null, "system");
          sendJSON(res, 400, {
            error: `Cannot mark completed without successful build verification. ${reason}. Run POST /directives/${id}/verify first.`,
            verification_required: true,
          });
          // Reset status back since we set it above
          directive.status = prevStatus;
          return true;
        }
      }

      // Auto-log status changes
      if (data.status && data.status !== prevStatus) {
        directive.activity_log.push({ timestamp: Date.now(), type: "status_change", actor: patchActor, message: `Status changed from ${prevStatus} to ${data.status}` });
      }

      // Track execution timing
      if (data.status && (data.status === "planning" || data.status === "in_progress") && !directive.startedAt) {
        directive.startedAt = Date.now();
      }
      if (data.status === "completed" && !directive.completedAt) {
        directive.completedAt = Date.now();
        if (directive.startedAt) {
          directive.duration = directive.completedAt - directive.startedAt;
        }
      }

      // Auto-create plan-approval when a feature directive reaches "planned" with a plan
      if (directive.type === "feature" && directive.status === "planned" && directive.plan) {
        const approvalId = `apr_plan_${directive.id}`;
        const approval = {
          id: approvalId,
          tool: "directive_plan",
          description: `Plan for: ${directive.title || directive.description.substring(0, 80)}`,
          risk: "high",
          directiveId: directive.id,
          resolved: false,
          approved: false,
          createdAt: Date.now(),
        };
        const approvals = getApprovals();
        // Remove any existing approvals with the same ID (e.g. expired duplicates)
        const filtered = approvals.filter((a) => a.id !== approvalId);
        filtered.push(approval);
        saveApprovals(filtered, approval);
        directive.directiveApprovalId = approvalId;

        // Proactively notify June so she can tell the user about the plan
        const planSummary = directive.plan.length > 300
          ? directive.plan.substring(0, 300) + "..."
          : directive.plan;
        setTimeout(() => {
          engage("plan ready notification");
          sendNotification(
            `[SYSTEM — Don't read verbatim, tell King Kazuma conversationally.]\n` +
            `The plan for "${directive.title}" is ready. Quick summary:\n${planSummary}\n\n` +
            `Ask if he wants to approve it. If yes, use approve_action with approval ID "${approvalId}" and needs_user_pin: true.`
          );
        }, 500);
      }

      // Notify active persona about other lifecycle transitions
      if (data.status && data.status !== prevStatus) {
        const title = directive.title;
        const notifyPersona = (msg) => setTimeout(() => {
          engage("directive lifecycle notification");
          sendNotification(msg);
        }, 500);

        if (directive.status === "in_progress" && prevStatus === "approved") {
          notifyPersona(
            `[SYSTEM — Brief update, don't read verbatim.]\n` +
            `"${title}" is being built now.`
          );
        } else if (directive.status === "blocked") {
          const reason = data.failureReason || data.blockedReason || "unknown blocker";
          notifyPersona(
            `[SYSTEM — Tell King Kazuma this needs his attention.]\n` +
            `"${title}" hit a blocker and needs your help: ${reason}\n` +
            `The agent couldn't finish this on its own. Ask King Kazuma if he can resolve it, then the directive can be unblocked.`
          );
        } else if (directive.status === "completed" && prevStatus === "in_progress") {
          // Calculate duration from creation to completion
          const durationMs = Date.now() - (directive.createdAt || Date.now());
          const durationMin = Math.round(durationMs / 60000);
          let durationStr;
          if (durationMin < 60) {
            durationStr = `${durationMin} minute${durationMin !== 1 ? "s" : ""}`;
          } else {
            const hrs = Math.floor(durationMin / 60);
            const mins = durationMin % 60;
            durationStr = `${hrs}h ${mins}m`;
          }

          // Parse changed files from plan field if available
          let changedFilesStr = "";
          const planStr = typeof directive.plan === "string" ? directive.plan : JSON.stringify(directive.plan || "");
          if (planStr) {
            const filePatterns = planStr.match(/(?:[\w./-]+\.(?:js|ts|tsx|jsx|py|json|yml|yaml|md|css|html|sh|sql|env))/g);
            if (filePatterns && filePatterns.length > 0) {
              const uniqueFiles = [...new Set(filePatterns)].slice(0, 10);
              changedFilesStr = ` Files touched: ${uniqueFiles.join(", ")}.`;
            }
          }

          notifyPersona(
            `[SYSTEM — Tell King Kazuma casually, don't read verbatim.]\n` +
            `"${title}" is done. Took ${durationStr}.${changedFilesStr} ` +
            `It's deploying now — devices will update automatically.`
          );
        }
      }

      // Broadcast directive status change to all connected WebSocket clients
      if (data.status && data.status !== prevStatus) {
        broadcastToAll({
          type: "directiveUpdate",
          directiveId: directive.id,
          oldStatus: prevStatus,
          newStatus: data.status,
          title: directive.title,
        });
      }

      saveDirectives(directives, directive, prevStatus, patchActor);

      // ── Dependency resolution ──
      // When a directive completes, unblock any pending directives that depended on it
      const unblockedDirectives = [];
      if (directive.status === "completed" && prevStatus !== "completed") {
        const depMap = new Map(directives.map(d => [d.id, d]));
        for (const d of directives) {
          if (d.status !== "pending" || !d.dependsOn || !d.dependsOn.includes(directive.id)) continue;
          // Check if ALL dependencies are now completed
          const allResolved = d.dependsOn.every(depId => {
            const dep = depMap.get(depId);
            return dep && dep.status === "completed";
          });
          if (allResolved) {
            const prevDStatus = d.status;
            d.status = "planning";
            d.updatedAt = Date.now();
            unblockedDirectives.push(d);
            log.bridge.info(`Dependency resolved: ${d.id} "${d.title}" unblocked — all deps completed`);
          }
        }
        if (unblockedDirectives.length > 0) {
          saveDirectives(directives, null, null, "system");
        }
      }

      // ── Agent spawner hooks ──
      // Auto-spawn planning agent when directive enters "planning"
      if (directive.status === "planning" && prevStatus !== "planning") {
        setLastRestartReason(`directive: ${directive.title || directive.id}`);
        routeDirective(directive, "planning");
      }
      // Auto-spawn implementation agent when directive is approved (with a plan or quick type)
      if (directive.status === "approved" && prevStatus !== "approved") {
        routeDirective(directive, "implementation");
      }
      // Spawn planning agents for any newly unblocked directives (higher priority first)
      unblockedDirectives.sort((a, b) => (a.priority || 3) - (b.priority || 3));
      for (const d of unblockedDirectives) {
        routeDirective(d, "planning");
      }

      // ── Epic status derivation ──
      // If this directive is a phase of an epic, re-derive the epic's status
      if (directive.epicId && data.status && data.status !== prevStatus) {
        deriveEpicStatus(directive.epicId);
      }

      sendJSON(res, 200, { ok: true, directive, unblocked: unblockedDirectives.length > 0 ? unblockedDirectives.map(d => d.id) : undefined });
      return true;
    }

    // POST /directives/:id/comment — Add a manual comment to a directive's activity log
    const directiveCommentMatch = pathname.match(/^\/directives\/([^/]+)\/comment$/);
    if (req.method === "POST" && directiveCommentMatch) {
      if (!requireAuth(req, res)) return true;
      const id = directiveCommentMatch[1];
      const data = await parseBody(req);
      if (!data.message || !data.message.trim()) {
        sendJSON(res, 400, { error: "message is required" });
        return true;
      }
      const directives = getDirectives();
      const directive = directives.find((d) => d.id === id);
      if (!directive) {
        sendJSON(res, 404, { error: "Directive not found" });
        return true;
      }
      if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
      const entry = { timestamp: Date.now(), type: "comment", actor: "King Kazuma", message: data.message.trim() };
      directive.activity_log.push(entry);
      directive.updatedAt = Date.now();
      saveDirectives(directives, directive, null, "King Kazuma");
      sendJSON(res, 200, { ok: true, entry });
      return true;
    }

    // GET /directives/:id/history — Merged audit trail (activity_log + PG directive_history)
    const directiveHistoryMatch = pathname.match(/^\/directives\/([^/]+)\/history$/);
    if (req.method === "GET" && directiveHistoryMatch) {
      const id = directiveHistoryMatch[1];
      const directives = getDirectives();
      const directive = directives.find((d) => d.id === id);
      if (!directive) {
        sendJSON(res, 404, { error: "Directive not found" });
        return true;
      }
      // Merge in-memory activity_log with PG directive_history
      const actLog = Array.isArray(directive.activity_log) ? directive.activity_log : [];
      const timeline = actLog.map(e => ({
        timestamp: e.timestamp,
        type: e.type,
        actor: e.actor || null,
        message: e.message,
        source: "activity_log",
      }));
      // Fetch PG history
      try {
        const pgHistory = await db.getDirectiveHistory(id);
        for (const h of pgHistory) {
          // Avoid duplicating status_change events already in activity_log
          const pgTs = new Date(h.changed_at).getTime();
          const isDuplicate = timeline.some(t =>
            t.type === "status_change" && Math.abs(t.timestamp - pgTs) < 2000 &&
            t.message.includes(h.new_status)
          );
          if (!isDuplicate) {
            timeline.push({
              timestamp: pgTs,
              type: "status_change",
              actor: h.changed_by || null,
              message: `${h.old_status || "new"} → ${h.new_status}${h.notes ? ` (${h.notes})` : ""}`,
              source: "pg_history",
            });
          }
        }
      } catch (err) {
        log.pg.error("getDirectiveHistory failed:", err.message);
      }
      // Sort by timestamp descending (newest first)
      timeline.sort((a, b) => b.timestamp - a.timestamp);
      sendJSON(res, 200, { directive_id: id, createdBy: directive.createdBy || null, timeline });
      return true;
    }

    // POST /directives/:id/activity — Append to activity log (used by orchestrator, agents)
    const directiveActivityMatch = pathname.match(/^\/directives\/([^/]+)\/activity$/);
    if (req.method === "POST" && directiveActivityMatch) {
      const id = directiveActivityMatch[1];
      const data = await parseBody(req);
      if (!data.type || !data.message) {
        sendJSON(res, 400, { error: "type and message required" });
        return true;
      }
      const directives = getDirectives();
      const directive = directives.find((d) => d.id === id);
      if (!directive) {
        sendJSON(res, 404, { error: "Directive not found" });
        return true;
      }
      if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
      const entry = { timestamp: data.timestamp || Date.now(), type: data.type, actor: data.actor || "Cipher", message: data.message };
      directive.activity_log.push(entry);
      directive.lastActivity = entry.timestamp;
      saveDirectives(directives, directive, null, data.actor || "Cipher");
      sendJSON(res, 200, { ok: true });
      return true;
    }

    // POST /directives/:id/build-run — Register a CI build run on a directive
    const buildRunMatch = pathname.match(/^\/directives\/([^/]+)\/build-run$/);
    if (req.method === "POST" && buildRunMatch) {
      const id = buildRunMatch[1];
      const data = await parseBody(req);
      const directives = getDirectives();
      const directive = directives.find((d) => d.id === id);
      if (!directive) {
        sendJSON(res, 404, { error: "Directive not found" });
        return true;
      }
      if (!data.platform || !data.runId) {
        sendJSON(res, 400, { error: "platform and runId are required" });
        return true;
      }
      if (!Array.isArray(directive.buildRuns)) directive.buildRuns = [];
      // Dedup: skip if this (platform, runId) already registered
      const alreadyExists = directive.buildRuns.some(
        (br) => br.platform === data.platform && br.runId === data.runId
      );
      if (alreadyExists) {
        sendJSON(res, 200, { ok: true, duplicate: true, buildRuns: directive.buildRuns });
        return true;
      }
      directive.buildRuns.push({
        platform: data.platform,
        runId: data.runId,
        triggeredAt: Date.now(),
        status: "queued",
        conclusion: null,
        url: `https://github.com/ozzuworld/ozzu/actions/runs/${data.runId}`,
        lastChecked: null,
      });
      if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
      directive.activity_log.push({ timestamp: Date.now(), type: "ci_build", actor: "system", message: `CI build triggered: ${data.platform} (run #${data.runId})` });
      directive.updatedAt = Date.now();
      saveDirectives(directives, directive);
      sendJSON(res, 200, { ok: true, buildRuns: directive.buildRuns });
      return true;
    }

    // GET /directives/:id/build-status — Get fresh build status for a directive's CI runs
    const directiveBuildStatusMatch = pathname.match(/^\/directives\/([^/]+)\/build-status$/);
    if (req.method === "GET" && directiveBuildStatusMatch) {
      const id = directiveBuildStatusMatch[1];
      const directives = getDirectives();
      const directive = directives.find((d) => d.id === id);
      if (!directive) {
        sendJSON(res, 404, { error: "Directive not found" });
        return true;
      }
      if (!Array.isArray(directive.buildRuns) || directive.buildRuns.length === 0) {
        sendJSON(res, 200, { buildRuns: [] });
        return true;
      }

      const { execFile } = require("child_process");
      const { promisify } = require("util");
      const execFileAsync = promisify(execFile);
      const TERMINAL_STATUSES = new Set(["completed"]);

      for (const run of directive.buildRuns) {
        // Skip terminal runs or recently checked runs (within 30s)
        if (TERMINAL_STATUSES.has(run.status) && run.conclusion) continue;
        if (run.lastChecked && (Date.now() - run.lastChecked) < 30000) continue;

        try {
          const result = await execFileAsync("gh", ["run", "view", String(run.runId), "--json", "status,conclusion,url", "-R", "ozzuworld/ozzu"], { timeout: 10000 });
          const ghData = JSON.parse(result.stdout);
          run.status = ghData.status || run.status;
          run.conclusion = ghData.conclusion || null;
          if (ghData.url) run.url = ghData.url;
          run.lastChecked = Date.now();
        } catch (err) {
          log.bridge.warn(`[build-status] Failed to fetch run ${run.runId}: ${err.message}`);
          run.lastChecked = Date.now();
        }
      }
      saveDirectives(directives, directive);
      sendJSON(res, 200, { buildRuns: directive.buildRuns });
      return true;
    }

    // GET /directives/:id/artifacts — List downloadable CI artifacts for a directive
    const directiveArtifactsMatch = pathname.match(/^\/directives\/([^/]+)\/artifacts$/);
    if (req.method === "GET" && directiveArtifactsMatch) {
      const id = directiveArtifactsMatch[1];
      const directives = getDirectives();
      const directive = directives.find((d) => d.id === id);
      if (!directive) { sendJSON(res, 404, { error: "Directive not found" }); return true; }
      if (!Array.isArray(directive.buildRuns) || directive.buildRuns.length === 0) {
        sendJSON(res, 200, { artifacts: [] }); return true;
      }
      const { execFile } = require("child_process");
      const { promisify } = require("util");
      const execFileAsync = promisify(execFile);
      const artifacts = [];
      for (const run of directive.buildRuns) {
        if (run.status !== "completed" || run.conclusion !== "success") continue;
        try {
          const result = await execFileAsync("gh", [
            "api", `repos/ozzuworld/ozzu/actions/runs/${run.runId}/artifacts`,
            "--jq", ".artifacts[] | {id: .id, name: .name, size_in_bytes: .size_in_bytes}",
          ], { timeout: 10000 });
          const lines = result.stdout.trim().split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const a = JSON.parse(line);
              artifacts.push({
                artifactId: a.id,
                runId: run.runId,
                platform: run.platform,
                name: a.name,
                sizeBytes: a.size_in_bytes,
              });
            } catch (_) {
              log.bridge.warn(`[artifacts] Failed to parse artifact line: ${line}`);
            }
          }
        } catch (err) {
          log.bridge.warn(`[artifacts] Failed to fetch artifacts for run ${run.runId}: ${err.message}`);
        }
      }
      sendJSON(res, 200, { artifacts });
      return true;
    }

    // POST /api/artifacts/:artifactId/deploy — Download artifact and deploy to devices
    const artifactDeployMatch = pathname.match(/^\/api\/artifacts\/(\d+)\/deploy$/);
    if (req.method === "POST" && artifactDeployMatch) {
      if (!requireAuth(req, res)) return true;
      const artifactId = artifactDeployMatch[1];
      const { exec } = require("child_process");
      // Download artifact via gh, then deploy
      const scriptDir = path.resolve(__dirname, "../../scripts");
      exec(
        `cd ${scriptDir} && gh api repos/ozzuworld/ozzu/actions/artifacts/${artifactId}/zip > /tmp/artifact-${artifactId}.zip && ` +
        `unzip -o /tmp/artifact-${artifactId}.zip -d /tmp/artifact-${artifactId}/ && ` +
        `ls /tmp/artifact-${artifactId}/*.apk 2>/dev/null && ./deploy.sh --local /tmp/artifact-${artifactId}/*.apk`,
        { timeout: 120000 },
        (err, stdout, stderr) => {
          if (err) {
            log.bridge.warn(`[artifact-deploy] Failed: ${err.message}`);
            sendJSON(res, 500, { ok: false, error: err.message });
          } else {
            sendJSON(res, 200, { ok: true, message: `Artifact ${artifactId} deployed`, output: stdout.slice(-500) });
          }
        }
      );
      return true;
    }

    // GET /api/artifacts/:artifactId/download — Download artifact file directly (IPA/APK)
    const artifactDownloadMatch = pathname.match(/^\/api\/artifacts\/(\d+)\/download$/);
    if (req.method === "GET" && artifactDownloadMatch) {
      const artifactId = artifactDownloadMatch[1];
      const { execSync } = require("child_process");

      try {
        const tmpZip = `/tmp/artifact-dl-${artifactId}.zip`;
        const tmpDir = `/tmp/artifact-dl-${artifactId}`;

        // Download artifact zip from GitHub
        execSync(`gh api repos/ozzuworld/ozzu/actions/artifacts/${artifactId}/zip > ${tmpZip}`, { timeout: 60000 });
        execSync(`rm -rf ${tmpDir} && mkdir -p ${tmpDir} && unzip -o ${tmpZip} -d ${tmpDir}`, { timeout: 30000 });

        // Find IPA or APK
        const files = fs.readdirSync(tmpDir);
        const ipa = files.find((f) => f.endsWith(".ipa"));
        const apk = files.find((f) => f.endsWith(".apk"));
        const targetFile = ipa || apk;

        if (!targetFile) {
          sendJSON(res, 404, { error: "No IPA or APK found in artifact" });
          return true;
        }

        const filePath = `${tmpDir}/${targetFile}`;
        const stat = fs.statSync(filePath);
        const ext = targetFile.endsWith(".ipa") ? "ipa" : "apk";
        const contentType = ext === "ipa" ? "application/octet-stream" : "application/vnd.android.package-archive";

        // Cache locally for future direct downloads
        const artifactsDir = "/home/gcp/ozzu/artifacts";
        try {
          if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });
          const cacheName = ext === "ipa" ? "ozzu-latest.ipa" : "ozzu-latest.apk";
          fs.copyFileSync(filePath, path.join(artifactsDir, cacheName));
          log.bridge.info(`[artifact-download] Cached ${cacheName} (${(stat.size / 1048576).toFixed(1)} MB)`);
        } catch { /* cache failure is non-fatal */ }

        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${targetFile}"`,
          "Content-Length": stat.size,
          ...CORS_HEADERS,
        });
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
      } catch (err) {
        log.bridge.warn(`[artifact-download] GitHub fetch failed: ${err.message}`);
        sendJSON(res, 500, { error: `Download failed: ${err.message}` });
      }
      return true;
    }

    // GET /api/artifacts/latest/:type — Download latest cached IPA or APK directly
    const latestArtifactMatch = pathname.match(/^\/api\/artifacts\/latest\/(ipa|apk)$/);
    if (req.method === "GET" && latestArtifactMatch) {
      const type = latestArtifactMatch[1];
      const artifactsDir = "/home/gcp/ozzu/artifacts";
      const fileName = type === "ipa" ? "ozzu-latest.ipa" : "ozzu-latest.apk";
      const filePath = path.join(artifactsDir, fileName);

      if (!fs.existsSync(filePath)) {
        sendJSON(res, 404, { error: `No cached ${type.toUpperCase()} available. Wait for a CI build to complete.` });
        return true;
      }

      const stat = fs.statSync(filePath);
      const contentType = type === "ipa" ? "application/octet-stream" : "application/vnd.android.package-archive";
      const age = Date.now() - stat.mtimeMs;
      const ageHours = (age / 3600000).toFixed(1);

      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": stat.size,
        "X-Artifact-Age-Hours": ageHours,
        "X-Artifact-Cached-At": new Date(stat.mtimeMs).toISOString(),
        ...CORS_HEADERS,
      });
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      return true;
    }

    // POST /directives/:id/verify — Run build verification before marking completed
    const directiveVerifyMatch = pathname.match(/^\/directives\/([^/]+)\/verify$/);
    if (req.method === "POST" && directiveVerifyMatch) {
      const id = directiveVerifyMatch[1];
      const directives = getDirectives();
      const directive = directives.find((d) => d.id === id);
      if (!directive) {
        sendJSON(res, 404, { error: "Directive not found" });
        return true;
      }

      if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
      directive.activity_log.push({ timestamp: Date.now(), type: "verification_started", actor: "Cipher", message: "Running build verification" });
      saveDirectives(directives, directive, null, "Cipher");

      try {
        const result = await buildVerifier.verify(directive);

        // Store verification result on directive (in-memory)
        directive.verification_result = {
          verified_at: Date.now(),
          success: result.success,
          verification_log: result.verification_log,
          change_type: result.change_type,
          failure_reason: result.failure_reason || null,
        };

        const logType = result.success ? "verification_success" : "verification_failure";
        const logMsg = result.success
          ? `Build verification passed (${result.change_type}, ${result.duration_ms}ms)`
          : `Build verification failed: ${result.failure_reason} (${result.duration_ms}ms)`;
        directive.activity_log.push({ timestamp: Date.now(), type: logType, actor: "system", message: logMsg });
        saveDirectives(directives, directive, null, "system");

        sendJSON(res, 200, {
          success: result.success,
          verification_log: result.verification_log,
          can_complete: result.success,
          failure_reason: result.failure_reason || null,
          change_type: result.change_type,
          duration_ms: result.duration_ms,
        });
      } catch (err) {
        log.directive.error(`Verification error for ${id}: ${err.message}`);
        directive.activity_log.push({ timestamp: Date.now(), type: "verification_failure", actor: "system", message: `Verification error: ${err.message}` });
        saveDirectives(directives, directive, null, "system");
        sendJSON(res, 500, { success: false, error: err.message });
      }
      return true;
    }

    // POST /directives/:id/merge-and-deploy — Cipher merges branch + deploys
    // Replaces the old worker→reviewAndMerge→smartDeploy flow
    const directiveMergeMatch = pathname.match(/^\/directives\/([^/]+)\/merge-and-deploy$/);
    if (req.method === "POST" && directiveMergeMatch) {
      const id = directiveMergeMatch[1];
      const directives = getDirectives();
      const directive = directives.find((d) => d.id === id);
      if (!directive) {
        sendJSON(res, 404, { error: "Directive not found" });
        return true;
      }
      if (directive.status !== "in_progress") {
        sendJSON(res, 400, { error: `Directive is "${directive.status}" — must be in_progress to merge. ${directive.status === "completed" ? "Create a new directive for further changes." : ""}` });
        return true;
      }

      const data = await parseBody(req);
      // Accept branch from request body or directive's mergeBranch field
      const branch = data.branch || directive.mergeBranch;
      if (!branch) {
        // Try to detect branch from git
        try {
          const { execSync } = require("child_process");
          const currentBranch = execSync("git branch --show-current", { cwd: "/home/gcp/ozzu", encoding: "utf8", timeout: 5000 }).trim();
          if (currentBranch.startsWith("cipher/") || currentBranch.startsWith("agent/")) {
            // Use detected branch — but we need to be on main to merge
            sendJSON(res, 400, { error: `No branch specified. Detected current branch: ${currentBranch}. Pass {"branch":"${currentBranch}"} in request body.` });
            return true;
          }
        } catch (err) {
          log.directive.warn(`[merge-and-deploy] Branch auto-detect failed: ${err.message}`);
        }
        sendJSON(res, 400, { error: "No branch specified. Pass {\"branch\":\"cipher/dir_xxx\"} in request body or set mergeBranch on directive." });
        return true;
      }

      if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
      const prevStatus = directive.status;

      // Step 1: Run verification
      directive.activity_log.push({ timestamp: Date.now(), type: "merge_deploy_started", actor: "Cipher", message: `Merge-and-deploy started for branch ${branch}` });
      saveDirectives(directives, directive, null, "Cipher");

      log.directive.info(`merge-and-deploy: ${id} branch=${branch} — running verification`);

      try {
        const verifyResult = await buildVerifier.verify(directive);
        directive.verification_result = {
          verified_at: Date.now(),
          success: verifyResult.success,
          verification_log: verifyResult.verification_log,
          change_type: verifyResult.change_type,
          failure_reason: verifyResult.failure_reason || null,
        };

        if (!verifyResult.success) {
          directive.activity_log.push({ timestamp: Date.now(), type: "verification_failure", actor: "system", message: `Verification failed: ${verifyResult.failure_reason}` });
          saveDirectives(directives, directive, null, "system");
          sendJSON(res, 400, {
            success: false,
            step: "verification",
            error: `Verification failed: ${verifyResult.failure_reason}`,
            verification_log: verifyResult.verification_log,
          });
          return true;
        }

        directive.activity_log.push({ timestamp: Date.now(), type: "verification_success", actor: "system", message: `Verification passed (${verifyResult.change_type})` });
        saveDirectives(directives, directive, null, "system");
      } catch (err) {
        log.directive.error(`merge-and-deploy verification error for ${id}: ${err.message}`);
        sendJSON(res, 500, { success: false, step: "verification", error: err.message });
        return true;
      }

      // Step 2: Merge branch to main
      log.directive.info(`merge-and-deploy: ${id} — merging ${branch} to main`);
      const mergeOk = mergeWorktreeToMain(id, branch);

      if (!mergeOk) {
        directive.status = "deploy_failed";
        directive.failureReason = `Merge failed for branch ${branch}`;
        directive.mergeBranch = branch;
        directive.activity_log.push({ timestamp: Date.now(), type: "merge_failed", actor: "system", message: directive.failureReason });
        saveDirectives(directives, directive, prevStatus, "system");
        sendJSON(res, 500, { success: false, step: "merge", error: directive.failureReason });
        return true;
      }

      directive.activity_log.push({ timestamp: Date.now(), type: "merged", actor: "Cipher", message: `Branch ${branch} merged to main` });

      // Step 3: Mark completed
      directive.status = "completed";
      directive.completedAt = Date.now();
      directive.activity_log.push({ timestamp: Date.now(), type: "status_change", actor: "Cipher", message: `Status changed from ${prevStatus} to completed` });
      saveDirectives(directives, directive, prevStatus, "Cipher");

      log.directive.info(`merge-and-deploy: ${id} — merged and completed, triggering smartDeploy`);

      // Step 4: Trigger smartDeploy (async, non-blocking)
      try {
        smartDeploy(directive);
      } catch (err) {
        log.directive.error(`smartDeploy error for ${id}: ${err.message}`);
      }

      // Clean up the branch (best-effort)
      try {
        cleanupWorktree(id, branch);
      } catch {}

      sendJSON(res, 200, {
        success: true,
        message: `Directive ${id} merged from ${branch}, marked completed, deploy triggered`,
        directive,
      });
      return true;
    }

    // POST /directives/:id/unblock — Force-skip dependency check (manual override)
    const directiveUnblockMatch = pathname.match(/^\/directives\/([^/]+)\/unblock$/);
    if (req.method === "POST" && directiveUnblockMatch) {
      if (!requireAuth(req, res)) return true;
      const id = directiveUnblockMatch[1];
      const directives = getDirectives();
      const directive = directives.find((d) => d.id === id);
      if (!directive) {
        sendJSON(res, 404, { error: "Directive not found" });
        return true;
      }
      if (directive.status === "blocked") {
        // Unblock a blocked directive — retry implementation
        const prevStatus = directive.status;
        log.bridge.info(`Unblock: ${directive.id} "${directive.title}" — was blocked: ${directive.failureReason || "unknown"}`);
        directive.status = "approved";
        directive.failureReason = null;
        directive.updatedAt = Date.now();
        if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
        directive.activity_log.push({ timestamp: Date.now(), type: "unblocked", actor: "King Kazuma", message: `Unblocked by King Kazuma — retrying implementation` });
        saveDirectives(directives, directive, prevStatus, "King Kazuma");
        routeDirective(directive, "implementation");
        sendJSON(res, 200, { ok: true, directive, message: "Directive unblocked and moved to approved for retry" });
        return true;
      }
      if (directive.status !== "pending") {
        sendJSON(res, 400, { error: `Directive is "${directive.status}", not pending or blocked — nothing to unblock` });
        return true;
      }
      if (!directive.dependsOn) {
        sendJSON(res, 400, { error: "Directive has no dependencies — nothing to unblock" });
        return true;
      }
      // Clear dependencies and transition to planning
      log.bridge.info(`Manual unblock: ${directive.id} "${directive.title}" — skipping deps: ${directive.dependsOn.join(", ")}`);
      directive.dependsOn = null;
      directive.status = "planning";
      directive.updatedAt = Date.now();
      saveDirectives(directives, directive, "pending", "King Kazuma");
      routeDirective(directive, "planning");
      sendJSON(res, 200, { ok: true, directive, message: "Directive unblocked and moved to planning" });
      return true;
    }

    // POST /directives/:id/cancel — Cancel a directive (kills agent if running)
    const directiveCancelMatch = pathname.match(/^\/directives\/([^/]+)\/cancel$/);
    if (req.method === "POST" && directiveCancelMatch) {
      if (!requireAuth(req, res)) return true;
      const id = directiveCancelMatch[1];
      const directives = getDirectives();
      const directive = directives.find((d) => d.id === id);
      if (!directive) {
        sendJSON(res, 404, { error: "Directive not found" });
        return true;
      }
      const terminalStatuses = ["completed", "failed", "cancelled"];
      if (terminalStatuses.includes(directive.status)) {
        sendJSON(res, 409, { error: `Directive is already "${directive.status}" — cannot cancel` });
        return true;
      }
      // Kill agent if one is running for this directive
      const agentKilled = killAgent(id);
      // Clean up branch/worktree if no agent was running (exit handler won't fire)
      if (!agentKilled) {
        const agentSpawner = require("./agent-spawner");
        const branch = directive.mergeBranch || `agent/${id}`;
        agentSpawner.cleanupWorktree(id, branch);
      }
      const prevStatus = directive.status;
      directive.status = "cancelled";
      directive.updatedAt = Date.now();
      if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
      directive.activity_log.push({ timestamp: Date.now(), type: "cancelled", actor: "King Kazuma", message: `Cancelled from dashboard (was ${prevStatus})` });
      // If cancelling an epic, cascade cancel to all pending/active child phases
      const cancelledChildren = [];
      if (directive.type === "epic") {
        const nonTerminal = new Set(["pending", "planning", "planned", "approved", "in_progress", "blocked"]);
        for (const d of directives) {
          if (d.epicId === id && nonTerminal.has(d.status)) {
            const childPrev = d.status;
            d.status = "cancelled";
            d.updatedAt = Date.now();
            if (!Array.isArray(d.activity_log)) d.activity_log = [];
            d.activity_log.push({ timestamp: Date.now(), type: "cancelled", actor: "system", message: `Cancelled — parent epic cancelled` });
            cancelledChildren.push(d.id);
            killAgent(d.id);
          }
        }
      }
      saveDirectives(directives, directive, prevStatus, "King Kazuma");
      log.bridge.info(`Directive cancelled: ${id} "${directive.title}" (was ${prevStatus}, agent killed: ${agentKilled}${cancelledChildren.length > 0 ? `, cascaded to ${cancelledChildren.length} children` : ""})`);
      sendJSON(res, 200, { ok: true, directive, agentKilled, cancelledChildren: cancelledChildren.length > 0 ? cancelledChildren : undefined });
      return true;
    }

    // POST /directives/:id/retry — Retry a failed/stale/cancelled directive
    const directiveRetryMatch = pathname.match(/^\/directives\/([^/]+)\/retry$/);
    if (req.method === "POST" && directiveRetryMatch) {
      if (!requireAuth(req, res)) return true;
      const id = directiveRetryMatch[1];
      const directives = getDirectives();
      const directive = directives.find((d) => d.id === id);
      if (!directive) {
        sendJSON(res, 404, { error: "Directive not found" });
        return true;
      }
      const activeStatuses = ["planning", "in_progress", "approved"];
      if (activeStatuses.includes(directive.status)) {
        sendJSON(res, 409, { error: `Directive is "${directive.status}" — already active, cannot retry` });
        return true;
      }
      const retryableStatuses = ["failed", "stale", "cancelled", "deploy_failed"];
      if (!retryableStatuses.includes(directive.status)) {
        sendJSON(res, 409, { error: `Directive is "${directive.status}" — cannot retry from this state` });
        return true;
      }
      const prevStatus = directive.status;
      directive.status = "approved";
      directive.retryCount = (directive.retryCount || 0) + 1;
      directive.failureReason = null;
      directive.updatedAt = Date.now();
      if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
      directive.activity_log.push({ timestamp: Date.now(), type: "retry", actor: "King Kazuma", message: `Retried from dashboard (was ${prevStatus}, retry #${directive.retryCount})` });
      saveDirectives(directives, directive, prevStatus, "King Kazuma");
      log.bridge.info(`Directive retried: ${id} "${directive.title}" (${prevStatus} → approved, retry #${directive.retryCount})`);
      sendJSON(res, 200, { ok: true, directive });
      return true;
    }

    // POST /directives/:id/escalate — Escalate a failing directive to Cipher for direct takeover
    const directiveEscalateMatch = pathname.match(/^\/directives\/([^/]+)\/escalate$/);
    if (req.method === "POST" && directiveEscalateMatch) {
      const id = directiveEscalateMatch[1];
      const directives = getDirectives();
      const directive = directives.find((d) => d.id === id);
      if (!directive) {
        sendJSON(res, 404, { error: "Directive not found" });
        return true;
      }
      const escalatableStatuses = ["failed", "stale", "blocked", "deploy_failed"];
      if (!escalatableStatuses.includes(directive.status)) {
        sendJSON(res, 409, { error: `Directive is "${directive.status}" — can only escalate from: ${escalatableStatuses.join(", ")}` });
        return true;
      }
      const body = await parseBody(req);
      const { escalatedBy, reason } = body || {};
      const prevStatus = directive.status;

      // Preserve current failure into workerAttempts history
      if (!Array.isArray(directive.workerAttempts)) directive.workerAttempts = [];
      if (directive.failureReason) {
        directive.workerAttempts.push({
          attempt: directive.workerAttempts.length + 1,
          failureReason: directive.failureReason,
          timestamp: directive.updatedAt || Date.now(),
        });
      }

      // Set escalation fields
      directive.escalatedAt = Date.now();
      directive.escalatedBy = escalatedBy || "King Kazuma";
      directive.escalationReason = reason || `escalated from ${prevStatus} (${directive.workerAttempts.length} worker attempt(s))`;

      // Transition to in_progress, clear failure
      directive.status = "in_progress";
      directive.failureReason = null;
      directive.updatedAt = Date.now();

      // Activity log
      if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
      directive.activity_log.push({
        timestamp: Date.now(),
        type: "escalation",
        actor: directive.escalatedBy,
        message: `Escalated to Cipher: ${directive.escalationReason} (was ${prevStatus}, ${directive.workerAttempts.length} worker attempt(s))`,
      });

      saveDirectives(directives, directive, prevStatus, directive.escalatedBy);
      log.bridge.info(`Directive escalated: ${id} "${directive.title}" (${prevStatus} → in_progress, by ${directive.escalatedBy})`);
      sendJSON(res, 200, { ok: true, directive, workerHistory: directive.workerAttempts });
      return true;
    }

    // POST /directives/:id/retry-merge — Re-attempt merge for deploy_failed directives
    const retryMergeMatch = pathname.match(/^\/directives\/([^/]+)\/retry-merge$/);
    if (req.method === "POST" && retryMergeMatch) {
      const id = retryMergeMatch[1];
      const directives = getDirectives();
      const directive = directives.find((d) => d.id === id);
      if (!directive) {
        sendJSON(res, 404, { error: "Directive not found" });
        return true;
      }
      if (directive.status !== "deploy_failed") {
        sendJSON(res, 409, { error: `Directive is "${directive.status}" — retry-merge only works for deploy_failed` });
        return true;
      }
      const branch = directive.mergeBranch;
      if (!branch) {
        sendJSON(res, 400, { error: "No mergeBranch recorded — cannot retry merge" });
        return true;
      }
      try {
        const agentSpawner = require("./agent-spawner");
        const mergeOk = agentSpawner.mergeWorktreeToMain(id, branch);
        if (mergeOk) {
          const prevStatus = directive.status;
          directive.status = "completed";
          directive.completedAt = Date.now();
          if (directive.startedAt) directive.duration = directive.completedAt - directive.startedAt;
          directive.failureReason = null;
          directive.updatedAt = Date.now();
          if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
          directive.activity_log.push({ timestamp: Date.now(), type: "status_change", actor: "King Kazuma", message: `Merge retried successfully from dashboard (branch ${branch})` });
          saveDirectives(directives, directive, prevStatus, "King Kazuma");
          agentSpawner.cleanupWorktree(id, branch);
          agentSpawner.smartDeploy(directive);
          log.bridge.info(`Merge retry succeeded for ${id} — branch cleaned up, deploying`);
          sendJSON(res, 200, { ok: true, message: "Merge succeeded, branch cleaned up, deploying now" });
        } else {
          directive.updatedAt = Date.now();
          directive.failureReason = `Merge retry failed for branch ${branch}`;
          if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
          directive.activity_log.push({ timestamp: Date.now(), type: "status_change", actor: "King Kazuma", message: `Merge retry failed again (branch ${branch})` });
          saveDirectives(directives, directive, directive.status, "King Kazuma");
          sendJSON(res, 500, { ok: false, error: "Merge failed again — branch preserved for manual resolution" });
        }
      } catch (err) {
        log.bridge.error(`Merge retry error for ${id}: ${err.message}`);
        sendJSON(res, 500, { ok: false, error: err.message });
      }
      return true;
    }

    // GET /approvals/details — Pending approvals enriched with directive info
    if (req.method === "GET" && pathname === "/approvals/details") {
      const approvals = expireApprovals(getApprovals());
      const pending = approvals.filter((a) => !a.resolved);
      const directives = getDirectives();
      const enriched = pending.map((a) => {
        const directive = directives.find((d) => d.directiveApprovalId === a.id);
        return {
          ...a,
          directiveTitle: directive ? directive.title : null,
          directivePlan: directive ? directive.plan : null,
          directiveDescription: directive ? directive.description : null,
          directiveId: directive ? directive.id : null,
        };
      });
      sendJSON(res, 200, enriched);
      return true;
    }

    // GET /uploads — List persisted uploads
    if (req.method === "GET" && pathname === "/uploads") {
      try {
        const uploadsDir = "/tmp/ozzu-bridge/uploads";
        const files = require("fs").readdirSync(uploadsDir).filter(f => f.endsWith(".meta.json")).sort().reverse();
        const limit = parseInt(new URL(req.url, "http://localhost").searchParams.get("limit") || "50");
        const metas = files.slice(0, limit).map(f => {
          try { return JSON.parse(require("fs").readFileSync(`${uploadsDir}/${f}`, "utf8")); } catch { return null; }
        }).filter(Boolean);
        sendJSON(res, 200, metas);
      } catch {
        sendJSON(res, 200, []);
      }
      return true;
    }

    // DELETE /directives/:id — Permanently remove a directive (only terminal statuses)
    const directiveDeleteMatch = pathname.match(/^\/directives\/([^/]+)$/);
    if (req.method === "DELETE" && directiveDeleteMatch) {
      if (!requireAuth(req, res)) return true;
      const id = directiveDeleteMatch[1];
      const directives = getDirectives();
      const idx = directives.findIndex((d) => d.id === id);
      if (idx === -1) {
        sendJSON(res, 404, { error: "Directive not found" });
        return true;
      }
      const directive = directives[idx];
      const terminalStatuses = ["completed", "failed", "cancelled"];
      if (!terminalStatuses.includes(directive.status)) {
        sendJSON(res, 409, { error: `Directive is "${directive.status}" — cancel it first before deleting` });
        return true;
      }
      // Clean up any lingering branch/worktree for this directive
      const agentSpawner = require("./agent-spawner");
      const branch = directive.mergeBranch || `agent/${id}`;
      agentSpawner.cleanupWorktree(id, branch);

      directives.splice(idx, 1);
      saveDirectives(directives, null, null);
      log.bridge.info(`Directive deleted: ${id} "${directive.title}" (branch cleanup attempted for ${branch})`);
      sendJSON(res, 200, { ok: true, message: `Directive ${id} deleted` });
      return true;
    }

    // POST /directives/bulk — Perform the same action on multiple directives
    if (req.method === "POST" && pathname === "/directives/bulk") {
      if (!requireAuth(req, res)) return true;
      const data = await parseBody(req);
      const validActions = ["cancel", "retry", "delete"];
      if (!data.action || !validActions.includes(data.action)) {
        sendJSON(res, 400, { error: "action must be one of: cancel, retry, delete" });
        return true;
      }
      if (!Array.isArray(data.ids) || data.ids.length === 0) {
        sendJSON(res, 400, { error: "ids must be a non-empty array of directive IDs" });
        return true;
      }
      const directives = getDirectives();
      const succeeded = [];
      const failed = [];
      const deletePending = [];

      for (const id of data.ids) {
        const directive = directives.find((d) => d.id === id);
        if (!directive) {
          failed.push({ id, error: "Directive not found" });
          continue;
        }

        if (data.action === "cancel") {
          const terminalStatuses = ["completed", "failed", "cancelled"];
          if (terminalStatuses.includes(directive.status)) {
            failed.push({ id, error: `Directive is already "${directive.status}" — cannot cancel` });
            continue;
          }
          const agentKilled = killAgent(id);
          // Clean up branch/worktree if no agent was running (exit handler won't fire)
          if (!agentKilled) {
            const agentSpawner = require("./agent-spawner");
            const branch = directive.mergeBranch || `agent/${id}`;
            agentSpawner.cleanupWorktree(id, branch);
          }
          const prevStatus = directive.status;
          directive.status = "cancelled";
          directive.updatedAt = Date.now();
          if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
          directive.activity_log.push({ timestamp: Date.now(), type: "cancelled", actor: "King Kazuma", message: `Bulk cancelled from dashboard (was ${prevStatus})` });
          saveDirectives(directives, directive, prevStatus, "King Kazuma");
          log.bridge.info(`Bulk cancel: ${id} "${directive.title}" (was ${prevStatus}, agent killed: ${agentKilled})`);
          succeeded.push(id);
        } else if (data.action === "retry") {
          const activeStatuses = ["planning", "in_progress", "approved"];
          if (activeStatuses.includes(directive.status)) {
            failed.push({ id, error: `Directive is "${directive.status}" — already active, cannot retry` });
            continue;
          }
          const retryableStatuses = ["failed", "stale", "cancelled"];
          if (!retryableStatuses.includes(directive.status)) {
            failed.push({ id, error: `Directive is "${directive.status}" — cannot retry from this state` });
            continue;
          }
          const prevStatus = directive.status;
          directive.status = "approved";
          directive.retryCount = (directive.retryCount || 0) + 1;
          directive.failureReason = null;
          directive.updatedAt = Date.now();
          if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
          directive.activity_log.push({ timestamp: Date.now(), type: "retry", actor: "King Kazuma", message: `Bulk retried from dashboard (was ${prevStatus}, retry #${directive.retryCount})` });
          saveDirectives(directives, directive, prevStatus, "King Kazuma");
          log.bridge.info(`Bulk retry: ${id} "${directive.title}" (${prevStatus} → approved, retry #${directive.retryCount})`);
          succeeded.push(id);
        } else if (data.action === "delete") {
          const terminalStatuses = ["completed", "failed", "cancelled"];
          if (!terminalStatuses.includes(directive.status)) {
            failed.push({ id, error: `Directive is "${directive.status}" — cancel it first before deleting` });
            continue;
          }
          deletePending.push(id);
          log.bridge.info(`Bulk delete: ${id} "${directive.title}"`);
          succeeded.push(id);
        }
      }

      // Batch-apply deletes in a single pass (avoids index shifting and redundant saves)
      if (deletePending.length > 0) {
        const deleteSet = new Set(deletePending);
        // Clean up branches for deleted directives before removing them
        const agentSpawner = require("./agent-spawner");
        for (const d of directives) {
          if (deleteSet.has(d.id)) {
            const branch = d.mergeBranch || `agent/${d.id}`;
            agentSpawner.cleanupWorktree(d.id, branch);
          }
        }
        const filtered = directives.filter(d => !deleteSet.has(d.id));
        directives.length = 0;
        directives.push(...filtered);
        saveDirectives(directives, null, null);
      }

      log.bridge.info(`Bulk ${data.action}: ${succeeded.length} succeeded, ${failed.length} failed`);
      sendJSON(res, 200, { ok: true, action: data.action, succeeded, failed });
      return true;
    }

    return false;
  };
};
