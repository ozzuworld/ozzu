"use strict";

module.exports = function dashboardRoutes(ctx) {
  const { sendJSON, db, getDirectives, getRunningAgents, getLogRing, CORS_HEADERS, _pipelineViolations, _serverStartedAt, _restartCount, _latencyStats, metrics, escapeHtml, escapeJsString, geminiReady, DIRECTIVE_TEMPLATES, expireApprovals, getApprovals, _redisConnected, redis } = ctx;

  return async function(req, res, pathname, url) {
    if (req.method === "GET" && pathname === "/dashboard") {
      const directives = getDirectives();
      const agents = getRunningAgents();
      const pgHealth = await db.healthCheck();
      let redisHealthy = false;
      try { if (_redisConnected) { await redis.ping(); redisHealthy = true; } } catch { redisHealthy = false; }
      const uptime = process.uptime();
      const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`;

      const statusColors = {
        pending: "#6b7280", planning: "#8b5cf6", planned: "#3b82f6",
        approved: "#06b6d4", in_progress: "#f59e0b", completed: "#10b981", blocked: "#ef4444",
        failed: "#ef4444", stale: "#f97316", cancelled: "#78716c", deploy_failed: "#dc2626",
      };

      const agentRows = agents.map(a => {
        const runtime = Math.floor((Date.now() - new Date(a.startedAt).getTime()) / 1000);
        const rtStr = `${Math.floor(runtime / 60)}m ${runtime % 60}s`;
        return `<tr><td>${escapeHtml(a.directiveId)}</td><td>${escapeHtml(a.type)}</td><td>${a.pid}</td><td>${rtStr}</td></tr>`;
      }).join("");

      const priorityLabels = { 1: "critical", 2: "high", 3: "normal", 4: "low" };
      const priorityColors = { 1: "#ef4444", 2: "#f97316", 3: "#6b7280", 4: "#9ca3af" };

      function formatDuration(ms) {
        if (!ms && ms !== 0) return "-";
        const totalSec = Math.floor(ms / 1000);
        if (totalSec < 60) return `${totalSec}s`;
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        if (mins < 60) return `${mins}m ${secs}s`;
        const hrs = Math.floor(mins / 60);
        const remMins = mins % 60;
        return `${hrs}h ${remMins}m`;
      }

      // Summary stats
      const completedDirectives = directives.filter(d => d.status === "completed");
      const failedDirectives = directives.filter(d => d.status === "failed" || d.status === "deploy_failed");
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const completedToday = completedDirectives.filter(d => d.completedAt && d.completedAt >= todayStart.getTime()).length;
      const completedWithDuration = completedDirectives.filter(d => d.duration);
      const avgDuration = completedWithDuration.length > 0
        ? Math.round(completedWithDuration.reduce((sum, d) => sum + d.duration, 0) / completedWithDuration.length)
        : null;
      const totalFinished = completedDirectives.length + failedDirectives.length;
      const successRate = totalFinished > 0 ? Math.round((completedDirectives.length / totalFinished) * 100) : null;

      // Pending approvals for banner
      const pendingApprovals = expireApprovals(getApprovals()).filter(a => !a.resolved);
      const plannedDirectives = directives.filter(d => d.status === "planned");
      const approvalBannerItems = pendingApprovals.map(a => {
        const directive = directives.find(d => d.directiveApprovalId === a.id);
        return { approval: a, directive };
      }).filter(item => item.directive);

      // Needs-action directives: planned, blocked, deploy_failed
      const needsActionStatuses = ["planned", "blocked", "deploy_failed"];
      const needsActionCount = directives.filter(d => needsActionStatuses.includes(d.status)).length;

      // Build pipeline violations section (only shown when unresolved violations exist)
      const unresolvedViolations = _pipelineViolations.filter(v => !v.resolved);
      const violationsHtml = unresolvedViolations.length > 0 ? unresolvedViolations.slice(-10).reverse().map(v => {
        const typeClass = escapeHtml(v.violationType || "unknown");
        const hashStr = v.commitHash ? v.commitHash.slice(0, 8) : "-";
        return `<div class="violation-item">
        <div class="violation-info">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="violation-type ${typeClass}">${escapeHtml((v.violationType || "unknown").replace(/_/g, " "))}</span>
            <code style="color:#64748b;font-size:11px;">${escapeHtml(hashStr)}</code>
            <span style="font-size:11px;color:#94a3b8;">${escapeHtml(v.author || "unknown")}</span>
          </div>
          <div class="violation-msg">${escapeHtml(v.message || "")}</div>
          <div class="violation-meta"><span data-ts="${v.timestamp}">${escapeHtml(String(v.timestamp))}</span></div>
        </div>
        <button class="btn-resolve" onclick="resolveViolation(${v.id})">Resolve</button>
      </div>`;
      }).join("") : "";

      // Build directive lookup map
      const directiveMap = new Map(directives.map(d => [d.id, d]));

      // Build directive cards (newest first)
      const directiveCards = [...directives].reverse().map(d => {
        const color = statusColors[d.status] || "#6b7280";
        const pri = d.priority || 3;
        const priLabel = priorityLabels[pri] || "normal";
        const priColor = priorityColors[pri] || "#6b7280";
        const createdByBadge = d.createdBy ? `<span class="actor-badge actor-${(d.createdBy || "").toLowerCase().replace(/\s/g, "-")}">${escapeHtml(d.createdBy)}</span>` : "";

        // Latest activity message
        const actLog = Array.isArray(d.activity_log) ? d.activity_log : [];
        const lastEntry = actLog.length > 0 ? actLog[actLog.length - 1] : null;
        const lastActivityHtml = lastEntry
          ? `<div class="card-activity">${escapeHtml(lastEntry.message)}</div>`
          : "";

        // Inline audit trail for active directives (last 5 entries)
        const isActive = !["completed", "cancelled"].includes(d.status);
        let inlineAuditHtml = "";
        if (isActive && actLog.length > 0) {
          const recentEntries = actLog.slice(-5).reverse();
          const entriesHtml = recentEntries.map(e => {
            const actorClass = ({ "King Kazuma": "king-kazuma", "June": "june", "Cipher": "cipher" })[e.actor] || "system";
            const actorBadge = e.actor ? `<span class="actor-badge actor-${actorClass}">${escapeHtml(e.actor)}</span>` : "";
            return `<div class="inline-trail-entry"><span class="trail-time" data-ts="${e.timestamp}">${escapeHtml(String(e.timestamp))}</span>${actorBadge}<span class="trail-msg">${escapeHtml(e.message)}</span></div>`;
          }).join("");
          const showAllBtn = actLog.length > 5 ? `<div class="trail-show-all"><a href="#" onclick="toggleActivityLog('${escapeHtml(escapeJsString(d.id))}');return false;">Show all ${actLog.length} entries</a></div>` : "";
          inlineAuditHtml = `<div class="inline-audit-trail">${entriesHtml}${showAllBtn}</div>`;
        }

        // Dependencies
        let depsHtml = "";
        if (d.dependsOn && d.dependsOn.length > 0) {
          depsHtml = `<div class="card-deps">${d.dependsOn.map(depId => {
            const dep = directiveMap.get(depId);
            const depColor = dep ? (dep.status === "completed" ? "#10b981" : "#f59e0b") : "#6b7280";
            const checkmark = dep && dep.status === "completed" ? "&#10003;" : "&#9679;";
            return `<span style="color:${depColor};font-size:11px;" title="${escapeHtml(depId)}">${checkmark} ${escapeHtml(dep ? (dep.title || depId) : depId)}</span>`;
          }).join(" ")}</div>`;
        }

        // Contextual action buttons
        let actionsHtml = "";
        const eid = escapeHtml(escapeJsString(d.id));
        if (d.status === "planned") {
          actionsHtml = `<button class="card-btn btn-approve" onclick="openApprovalModal('${eid}')">Approve</button>
          <button class="card-btn btn-deny" onclick="denyDirective('${eid}')">Deny</button>`;
        } else if (d.status === "deploy_failed") {
          actionsHtml = `<button class="card-btn btn-retry-merge" onclick="retryMerge('${eid}')">Retry Merge</button>
          <button class="card-btn btn-retry" onclick="retryDirective('${eid}')">Retry Full</button>
          <button class="card-btn btn-escalate" onclick="escalateDirective('${eid}')">Escalate to Cipher</button>`;
        } else if (d.status === "blocked") {
          actionsHtml = `<button class="card-btn btn-unblock" onclick="unblockDirective('${eid}')">Unblock</button>
          <button class="card-btn btn-escalate" onclick="escalateDirective('${eid}')">Escalate to Cipher</button>
          <button class="card-btn btn-cancel" onclick="cancelDirective('${eid}')">Cancel</button>`;
        } else if (["failed", "stale"].includes(d.status)) {
          actionsHtml = `<button class="card-btn btn-retry" onclick="retryDirective('${eid}')">Retry</button>
          <button class="card-btn btn-escalate" onclick="escalateDirective('${eid}')">Escalate to Cipher</button>`;
        } else if (d.status === "cancelled") {
          actionsHtml = `<button class="card-btn btn-retry" onclick="retryDirective('${eid}')">Retry</button>`;
        } else if (!["completed"].includes(d.status)) {
          actionsHtml = `<button class="card-btn btn-cancel" onclick="cancelDirective('${eid}')">Cancel</button>`;
        }
        actionsHtml += ` <button class="card-btn btn-comment" onclick="toggleCommentInput('${eid}')">Comment</button>`;
        actionsHtml += ` <button class="card-btn btn-log" onclick="toggleActivityLog('${eid}')">Log</button>`;

        // Build status badges for this directive
        let buildStatusHtml = "";
        if (Array.isArray(d.buildRuns) && d.buildRuns.length > 0) {
          const badges = d.buildRuns.map(run => {
            const isActive = run.status === "in_progress" || run.status === "queued";
            const succeeded = run.status === "completed" && run.conclusion === "success";
            const failed = run.status === "completed" && (run.conclusion === "failure" || run.conclusion === "cancelled");
            const badgeColor = isActive ? "#3b82f6" : succeeded ? "#10b981" : failed ? "#ef4444" : "#6b7280";
            const label = run.platform === "android" ? "Android" : run.platform === "ios" ? "iOS" : escapeHtml(run.platform);
            const statusText = isActive ? (run.status === "in_progress" ? "building" : "queued") : run.conclusion || run.status;
            const dot = isActive ? "&#9679;" : succeeded ? "&#10003;" : failed ? "&#10007;" : "&#9679;";
            return `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:4px;background:${badgeColor}18;border:1px solid ${badgeColor};color:${badgeColor};font-size:11px;font-weight:bold;" title="Run #${run.runId}">${dot} ${label}: ${escapeHtml(statusText)}</span>`;
          }).join(" ");
          buildStatusHtml = `<div class="card-build-status" data-directive-id="${escapeHtml(d.id)}" style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">${badges}</div>`;
        }

        return `<div class="directive-card" data-status="${escapeHtml(d.status)}" data-title="${escapeHtml((d.title || d.id).toLowerCase())}" data-id="${escapeHtml(d.id)}" style="border-left:4px solid ${color};">
        <div class="card-header">
          <div class="card-header-left">
            <span class="status-badge" style="background:${color};">${escapeHtml(d.status.replace("_", " "))}</span>
            ${d.escalatedAt ? '<span class="status-badge escalated-badge" style="background:#dc2626;">ESCALATED</span>' : ""}
            <span class="card-title">${escapeHtml(d.title || d.id)}</span>
            ${createdByBadge}
          </div>
          <div class="card-header-right">
            <span class="card-meta" style="color:${priColor};font-weight:${pri <= 2 ? "bold" : "normal"};">${priLabel}</span>
            <span class="card-meta">${escapeHtml(d.type || "-")}</span>
            <span class="card-meta card-time" data-ts="${d.createdAt}">${escapeHtml(String(d.createdAt))}</span>
            ${d.duration ? `<span class="card-meta">${formatDuration(d.duration)}</span>` : ""}
          </div>
        </div>
        ${d.failureReason ? `<div class="card-failure">${escapeHtml(d.failureReason)}</div>` : ""}
        ${buildStatusHtml}
        ${lastActivityHtml}
        ${depsHtml}
        ${inlineAuditHtml}
        <div class="card-actions">${actionsHtml}</div>
        <div class="card-comment-input" id="comment-wrap-${escapeHtml(d.id)}" style="display:none;">
          <input type="text" id="comment-input-${escapeHtml(d.id)}" placeholder="Add a comment..." onkeydown="if(event.key==='Enter'){addComment('${eid}');}">
          <button onclick="addComment('${eid}')">Add</button>
        </div>
        <div class="card-full-log" id="log-${escapeHtml(d.id)}" style="display:none;">
          <div id="timeline-${escapeHtml(d.id)}" class="full-timeline"><span style="color:#475569;font-style:italic;">Loading...</span></div>
        </div>
      </div>`;
      }).join("");

      // ── Execution Timeline (last 24h) ──
      const now24 = Date.now();
      const h24ago = now24 - 24 * 60 * 60 * 1000;
      const timelineDirectives = directives.filter(d => d.startedAt && d.startedAt >= h24ago);
      const tlBarColors = { completed: "#10b981", failed: "#ef4444", in_progress: "#3b82f6", stale: "#f59e0b", deploy_failed: "#dc2626" };
      const timelineBars = timelineDirectives.map(d => {
        const endTs = d.completedAt || now24;
        const leftPct = Math.max(0, ((d.startedAt - h24ago) / (now24 - h24ago)) * 100);
        const widthPct = Math.max(0.3, ((endTs - d.startedAt) / (now24 - h24ago)) * 100);
        const color = tlBarColors[d.status] || "#6b7280";
        const label = escapeHtml(d.title || d.id);
        const startTime = new Date(d.startedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" });
        const endTime = d.completedAt ? new Date(d.completedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" }) : "ongoing";
        return `<div style="display:flex;align-items:center;height:28px;gap:8px;">
        <div style="width:180px;flex-shrink:0;font-size:11px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${label}">${label}</div>
        <div style="flex:1;position:relative;height:20px;background:#1e293b;border-radius:3px;">
          <div style="position:absolute;left:${leftPct}%;width:${widthPct}%;top:2px;height:16px;background:${color};border-radius:3px;min-width:3px;" title="${label}\n${startTime} — ${endTime}\nStatus: ${escapeHtml(d.status)}"></div>
        </div>
      </div>`;
      }).join("");

      const tlHourMarkers = [];
      for (let h = 0; h < 24; h++) {
        const markerTs = h24ago + h * 60 * 60 * 1000;
        const pct = (h / 24) * 100;
        const hLabel = new Date(markerTs).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" });
        tlHourMarkers.push(`<span style="position:absolute;left:${pct}%;transform:translateX(-50%);font-size:10px;color:#475569;white-space:nowrap;">${hLabel}</span>`);
      }
      const tlHourMarkersHtml = tlHourMarkers.join("");

      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ozzu Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f172a; color: #e2e8f0; font-family: "SF Mono", "Fira Code", monospace; padding: 24px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .subtitle { color: #64748b; font-size: 13px; margin-bottom: 8px; }
  .refresh-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
  .refresh-bar .countdown { color: #64748b; font-size: 12px; }
  .refresh-btn { background: #334155; color: #e2e8f0; border: 1px solid #475569; border-radius: 6px; padding: 6px 14px; font-size: 12px; font-family: inherit; cursor: pointer; transition: background 0.2s; }
  .refresh-btn:hover { background: #475569; }
  .refresh-btn:active { background: #1e293b; }
  .stat-cards { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
  .stat-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px 20px; min-width: 140px; }
  .stat-card .label { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; }
  .stat-card .value { font-size: 24px; font-weight: bold; margin-top: 4px; }
  .stat-card .value.ok { color: #10b981; }
  .stat-card .value.warn { color: #f59e0b; }
  .stat-card .value.bad { color: #ef4444; }
  section { margin-bottom: 28px; }
  h2 { font-size: 16px; margin-bottom: 10px; border-bottom: 1px solid #334155; padding-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #1e293b; }
  th { color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
  tr:hover { background: #1e293b; }
  .empty { color: #475569; font-style: italic; padding: 12px; }
  .updating { opacity: 0.6; transition: opacity 0.15s; }

  /* Approval banner */
  .approval-banner { background: linear-gradient(135deg, #1e3a5f 0%, #1e293b 100%); border: 1px solid #3b82f6; border-radius: 10px; padding: 16px 20px; margin-bottom: 24px; }
  .approval-banner h3 { color: #60a5fa; font-size: 14px; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; }
  .approval-item { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  .approval-item:last-child { margin-bottom: 0; }
  .approval-info { flex: 1; }
  .approval-title { font-size: 14px; font-weight: 600; color: #e2e8f0; }
  .approval-desc { font-size: 12px; color: #94a3b8; margin-top: 4px; max-width: 600px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .approval-actions { display: flex; gap: 8px; flex-shrink: 0; }
  .approval-actions button { padding: 8px 16px; border: none; border-radius: 6px; font-size: 13px; font-family: inherit; cursor: pointer; font-weight: 600; }
  .approval-actions .btn-approve-banner { background: #10b981; color: #fff; }
  .approval-actions .btn-approve-banner:hover { background: #059669; }
  .approval-actions .btn-deny-banner { background: #475569; color: #e2e8f0; }
  .approval-actions .btn-deny-banner:hover { background: #64748b; }

  /* Approval modal */
  .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 1000; justify-content: center; align-items: center; }
  .modal-overlay.active { display: flex; }
  .modal { background: #1e293b; border: 1px solid #475569; border-radius: 12px; padding: 24px; max-width: 600px; width: 90%; max-height: 80vh; overflow-y: auto; }
  .modal h3 { font-size: 16px; margin-bottom: 16px; color: #e2e8f0; }
  .modal .plan-text { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 16px; font-size: 13px; color: #94a3b8; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-wrap: break-word; margin-bottom: 16px; line-height: 1.5; }
  .modal .pin-row { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .modal .pin-row label { font-size: 13px; color: #94a3b8; flex-shrink: 0; }
  .modal .pin-row input { background: #0f172a; color: #e2e8f0; border: 1px solid #475569; border-radius: 6px; padding: 8px 12px; font-family: inherit; font-size: 16px; width: 120px; text-align: center; letter-spacing: 4px; }
  .modal .modal-actions { display: flex; gap: 12px; justify-content: flex-end; }
  .modal .modal-actions button { padding: 10px 20px; border: none; border-radius: 6px; font-size: 14px; font-family: inherit; cursor: pointer; font-weight: 600; }
  .modal .btn-approve-modal { background: #10b981; color: #fff; }
  .modal .btn-approve-modal:hover { background: #059669; }
  .modal .btn-cancel-modal { background: #475569; color: #e2e8f0; }
  .modal .btn-cancel-modal:hover { background: #64748b; }
  .modal .modal-error { color: #f87171; font-size: 13px; margin-top: 8px; }

  /* Filter bar */
  .filter-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .filter-bar input[type="text"] { background: #0f172a; color: #e2e8f0; border: 1px solid #475569; border-radius: 6px; padding: 6px 12px; font-family: inherit; font-size: 13px; width: 240px; }
  .filter-bar input[type="text"]::placeholder { color: #475569; }
  .filter-pills { display: flex; gap: 6px; flex-wrap: wrap; }
  .filter-pill { background: #334155; color: #94a3b8; border: 1px solid #475569; border-radius: 16px; padding: 4px 12px; font-size: 12px; font-family: inherit; cursor: pointer; transition: all 0.15s; }
  .filter-pill:hover { background: #475569; color: #e2e8f0; }
  .filter-pill.active { background: #3b82f6; color: #fff; border-color: #3b82f6; }
  .filter-pill .pill-count { background: rgba(255,255,255,0.2); padding: 1px 5px; border-radius: 8px; font-size: 10px; margin-left: 4px; }

  /* Directive cards */
  .directive-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; margin-bottom: 10px; transition: border-color 0.15s; }
  .directive-card:hover { border-color: #475569; }
  .card-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .card-header-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .card-header-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .status-badge { color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 11px; text-transform: capitalize; white-space: nowrap; }
  .card-title { font-size: 14px; font-weight: 600; color: #e2e8f0; }
  .card-meta { font-size: 12px; color: #64748b; }
  .card-time { }
  .card-failure { margin-top: 8px; padding: 8px 12px; background: #450a0a; border: 1px solid #7f1d1d; border-radius: 6px; color: #fca5a5; font-size: 12px; }
  .card-activity { margin-top: 6px; font-size: 12px; color: #94a3b8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card-deps { margin-top: 6px; display: flex; gap: 8px; flex-wrap: wrap; }
  .card-actions { margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap; }
  .card-btn { padding: 4px 10px; border: 1px solid #475569; border-radius: 4px; font-size: 11px; font-family: inherit; cursor: pointer; background: #334155; color: #e2e8f0; transition: all 0.15s; }
  .card-btn:hover { background: #475569; }
  .btn-approve { background: #065f46; border-color: #10b981; color: #6ee7b7; }
  .btn-approve:hover { background: #10b981; color: #fff; }
  .btn-deny { background: #450a0a; border-color: #ef4444; color: #fca5a5; }
  .btn-deny:hover { background: #ef4444; color: #fff; }
  .btn-retry { background: #1e3a5f; border-color: #3b82f6; color: #93c5fd; }
  .btn-retry:hover { background: #3b82f6; color: #fff; }
  .btn-retry-merge { background: #422006; border-color: #f59e0b; color: #fcd34d; }
  .btn-retry-merge:hover { background: #f59e0b; color: #000; }
  .btn-unblock { background: #2e1065; border-color: #8b5cf6; color: #c4b5fd; }
  .btn-unblock:hover { background: #8b5cf6; color: #fff; }
  .btn-escalate { background: #7f1d1d; border-color: #dc2626; color: #fca5a5; }
  .btn-escalate:hover { background: #dc2626; color: #fff; }
  .escalated-badge { animation: escalated-pulse 2s ease-in-out infinite; }
  @keyframes escalated-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
  .btn-cancel { background: #450a0a; border-color: #dc2626; color: #fca5a5; }
  .btn-cancel:hover { background: #dc2626; color: #fff; }
  .btn-comment { background: transparent; border-color: #475569; color: #64748b; }
  .btn-comment:hover { color: #e2e8f0; }
  .btn-log { background: transparent; border-color: #475569; color: #64748b; }
  .btn-log:hover { color: #e2e8f0; }

  /* Inline audit trail */
  .inline-audit-trail { margin-top: 8px; padding: 8px 0 0; border-top: 1px solid #334155; }
  .inline-trail-entry { display: flex; gap: 6px; align-items: baseline; font-size: 11px; padding: 2px 0; color: #94a3b8; }
  .trail-time { color: #475569; flex-shrink: 0; min-width: 50px; }
  .trail-msg { color: #94a3b8; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .trail-show-all { margin-top: 4px; }
  .trail-show-all a { color: #3b82f6; font-size: 11px; text-decoration: none; }
  .trail-show-all a:hover { text-decoration: underline; }

  /* Card comment input */
  .card-comment-input { margin-top: 8px; display: flex; gap: 6px; }
  .card-comment-input input { flex: 1; background: #0f172a; color: #e2e8f0; border: 1px solid #475569; border-radius: 4px; padding: 6px 10px; font-size: 12px; font-family: inherit; }
  .card-comment-input button { background: #10b981; color: #fff; border: none; border-radius: 4px; padding: 6px 12px; font-size: 12px; font-family: inherit; cursor: pointer; }
  .card-comment-input button:hover { background: #059669; }

  /* Full log panel inside card */
  .card-full-log { margin-top: 8px; padding-top: 8px; border-top: 1px solid #334155; }
  .full-timeline { max-height: 300px; overflow-y: auto; border-left: 2px solid #334155; margin-left: 4px; padding-left: 12px; }

  .load-more-wrap { text-align: center; padding: 12px 0; }
  .load-more-btn { background: #334155; color: #e2e8f0; border: 1px solid #475569; border-radius: 6px; padding: 8px 20px; font-size: 13px; font-family: inherit; cursor: pointer; transition: background 0.2s; }
  .load-more-btn:hover { background: #475569; }

  /* Actor badges */
  .actor-badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 600; letter-spacing: 0.5px; white-space: nowrap; }
  .actor-king-kazuma { background: #7c3aed22; color: #a78bfa; border: 1px solid #7c3aed44; }
  .actor-june { background: #06b6d422; color: #67e8f9; border: 1px solid #06b6d444; }
  .actor-cipher { background: #10b98122; color: #6ee7b7; border: 1px solid #10b98144; }
  .actor-system { background: #6b728022; color: #9ca3af; border: 1px solid #6b728044; }

  /* Timeline entries in full log */
  .timeline-entry { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; border-bottom: 1px solid #1e293b; position: relative; }
  .timeline-entry::before { content: ""; position: absolute; left: -16px; top: 10px; width: 8px; height: 8px; border-radius: 50%; background: #334155; border: 1px solid #475569; }
  .timeline-entry.type-status_change::before { background: #3b82f6; border-color: #60a5fa; }
  .timeline-entry.type-comment::before { background: #10b981; border-color: #34d399; }
  .timeline-entry.type-cancelled::before { background: #ef4444; border-color: #f87171; }
  .timeline-entry.type-retry::before { background: #f59e0b; border-color: #fbbf24; }
  .timeline-entry.type-unblocked::before { background: #8b5cf6; border-color: #a78bfa; }
  .timeline-entry.type-pm_note::before { background: #06b6d4; border-color: #22d3ee; }
  .timeline-entry.type-pm_update::before { background: #06b6d4; border-color: #22d3ee; }

  /* New directive form */
  .new-directive { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; }
  .new-directive h2 { border-color: #475569; }
  .new-directive label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 4px; margin-top: 12px; text-transform: uppercase; letter-spacing: 1px; }
  .new-directive input, .new-directive textarea, .new-directive select { width: 100%; background: #0f172a; color: #e2e8f0; border: 1px solid #475569; border-radius: 6px; padding: 8px 12px; font-family: inherit; font-size: 14px; }
  .new-directive textarea { min-height: 80px; resize: vertical; }
  .new-directive select { appearance: auto; }
  .new-directive .submit-btn { margin-top: 16px; background: #3b82f6; color: #fff; border: none; border-radius: 6px; padding: 10px 20px; font-size: 14px; font-family: inherit; cursor: pointer; transition: background 0.2s; }
  .new-directive .submit-btn:hover { background: #2563eb; }
  .new-directive .submit-btn:disabled { background: #475569; cursor: not-allowed; }
  .new-directive .form-msg { margin-top: 10px; font-size: 13px; padding: 8px 12px; border-radius: 6px; }
  .new-directive .form-msg.ok { background: #064e3b; color: #6ee7b7; }
  .new-directive .form-msg.err { background: #450a0a; color: #fca5a5; }

  /* Pipeline violations */
  .violations-section { background: #1e293b; border: 2px solid #ef4444; border-radius: 10px; padding: 16px 20px; margin-bottom: 24px; }
  .violations-section h3 { color: #f87171; font-size: 14px; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; display: flex; align-items: center; gap: 8px; }
  .violations-count { background: #ef4444; color: #fff; padding: 2px 8px; border-radius: 10px; font-size: 11px; }
  .violation-item { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .violation-item:last-child { margin-bottom: 0; }
  .violation-info { flex: 1; }
  .violation-type { font-size: 11px; padding: 2px 6px; border-radius: 3px; font-weight: 600; }
  .violation-type.direct_commit_main { background: #ef444422; color: #fca5a5; border: 1px solid #ef444444; }
  .violation-type.orphan_commit { background: #f59e0b22; color: #fcd34d; border: 1px solid #f59e0b44; }
  .violation-type.hook_bypassed { background: #8b5cf622; color: #c4b5fd; border: 1px solid #8b5cf644; }
  .violation-msg { font-size: 12px; color: #94a3b8; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 500px; }
  .violation-meta { font-size: 11px; color: #475569; margin-top: 2px; }
  .btn-resolve { padding: 4px 10px; border: 1px solid #475569; border-radius: 4px; font-size: 11px; font-family: inherit; cursor: pointer; background: #334155; color: #e2e8f0; transition: all 0.15s; }
  .btn-resolve:hover { background: #10b981; color: #fff; border-color: #10b981; }

  /* Mobile responsive */
  @media (max-width: 768px) {
    body { padding: 12px; }
    h1 { font-size: 18px; }
    .stat-cards { gap: 8px; }
    .stat-card { min-width: unset; padding: 10px 14px; flex: 1; }
    .stat-card .value { font-size: 18px; }
    section { margin-bottom: 20px; }
    .card-header { flex-direction: column; align-items: flex-start; }
    .card-header-right { gap: 8px; }
    .approval-item { flex-direction: column; gap: 8px; }
    .filter-bar { gap: 8px; }
    .filter-bar input[type="text"] { width: 100%; }
    .modal { width: 95%; padding: 16px; }
    .new-directive { padding: 14px; }
    .new-directive input, .new-directive textarea, .new-directive select { font-size: 16px; padding: 10px 12px; }
    .new-directive .submit-btn { width: 100%; padding: 12px; font-size: 16px; }
    .refresh-bar { flex-wrap: wrap; gap: 8px; }
  }
</style>
</head><body>
<h1>Ozzu Pipeline Dashboard</h1>
<p class="subtitle">Bridge server on 10.128.0.8:3333 &mdash; refreshed <span id="refreshed-at">${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}</span></p>

<div class="refresh-bar">
  <button class="refresh-btn" onclick="refreshNow()">Refresh Now</button>
  <a href="/logs" target="_blank" class="refresh-btn" style="text-decoration:none;">View Logs</a>
  <span class="countdown" id="countdown">Next refresh in 10s</span>
</div>

<div id="dashboard-content">

${approvalBannerItems.length > 0 ? `<div class="approval-banner">
<h3>Pending Approvals (${approvalBannerItems.length})</h3>
${approvalBannerItems.map(item => `<div class="approval-item">
  <div class="approval-info">
    <div class="approval-title">${escapeHtml(item.directive.title || item.directive.id)}</div>
    <div class="approval-desc">${escapeHtml(item.directive.plan ? item.directive.plan.slice(0, 200) : item.directive.description || "")}</div>
  </div>
  <div class="approval-actions">
    <button class="btn-approve-banner" onclick="openApprovalModal('${escapeHtml(escapeJsString(item.directive.id))}')">Approve</button>
    <button class="btn-deny-banner" onclick="denyDirective('${escapeHtml(escapeJsString(item.directive.id))}')">Deny</button>
  </div>
</div>`).join("")}
</div>` : ""}

<div class="stat-cards">
  <div class="stat-card"><div class="label">Uptime</div><div class="value">${uptimeStr}</div></div>
  <div class="stat-card"><div class="label">PostgreSQL</div><div class="value ${pgHealth.connected ? "ok" : "bad"}">${pgHealth.connected ? "Connected" : "Down"}</div></div>
  <div class="stat-card"><div class="label">Redis</div><div class="value ${redisHealthy ? "ok" : "bad"}">${redisHealthy ? "Connected" : "Down"}</div></div>
  <div class="stat-card"><div class="label">Gemini</div><div class="value ${geminiReady ? "ok" : "warn"}">${geminiReady ? "Connected" : "Down"}</div></div>
  <div class="stat-card"><div class="label">Active Agents</div><div class="value ${agents.length > 0 ? "warn" : "ok"}">${agents.length}</div></div>
  <div class="stat-card"><div class="label">Completed Today</div><div class="value ok">${completedToday}</div></div>
  <div class="stat-card"><div class="label">Success Rate</div><div class="value ${successRate !== null && successRate >= 80 ? "ok" : successRate !== null && successRate >= 50 ? "warn" : successRate !== null ? "bad" : ""}">${successRate !== null ? successRate + "%" : "N/A"}</div></div>
  <div class="stat-card"><div class="label">Avg Duration</div><div class="value">${avgDuration !== null ? formatDuration(avgDuration) : "N/A"}</div></div>
</div>

<div id="build-status-section">
<h2>CI Build Status</h2>
<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:24px;">
  <div class="stat-card" id="build-android" style="flex:1;min-width:260px;border-left:3px solid #6b7280;">
    <div class="label">Android CI Build</div>
    <div class="value" id="build-android-status" style="font-size:16px;">Loading...</div>
    <div id="build-android-meta" style="font-size:11px;color:#64748b;margin-top:4px;"></div>
  </div>
  <div class="stat-card" id="build-ios" style="flex:1;min-width:260px;border-left:3px solid #6b7280;">
    <div class="label">iOS CI Build</div>
    <div class="value" id="build-ios-status" style="font-size:16px;">Loading...</div>
    <div id="build-ios-meta" style="font-size:11px;color:#64748b;margin-top:4px;"></div>
  </div>
</div>
</div>

${unresolvedViolations.length > 0 ? `<div class="violations-section">
<h3>Pipeline Violations <span class="violations-count">${unresolvedViolations.length}</span></h3>
${violationsHtml}
</div>` : ""}

<section>
<h2>Running Agents</h2>
${agents.length > 0 ? `<table><tr><th>Directive</th><th>Type</th><th>PID</th><th>Runtime</th></tr>${agentRows}</table>` : `<p class="empty">No agents currently running.</p>`}
</section>

${timelineDirectives.length > 0 ? `<section>
<h2>Execution Timeline (Last 24h)</h2>
<div style="display:flex;gap:6px;margin-bottom:10px;font-size:11px;">
  <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#10b981;display:inline-block;"></span> Completed</span>
  <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#ef4444;display:inline-block;"></span> Failed</span>
  <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#3b82f6;display:inline-block;"></span> In Progress</span>
  <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#f59e0b;display:inline-block;"></span> Stale</span>
  <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#dc2626;display:inline-block;"></span> Deploy Failed</span>
</div>
<div style="display:flex;gap:8px;">
  <div style="width:180px;flex-shrink:0;"></div>
  <div style="flex:1;position:relative;height:18px;margin-bottom:4px;">${tlHourMarkersHtml}</div>
</div>
<div style="display:flex;flex-direction:column;gap:2px;">
  ${timelineBars}
</div>
</section>` : ""}

<section>
<h2>Directives</h2>
<div class="filter-bar">
  <input type="text" id="directive-search" placeholder="Search directives..." oninput="applyFilters()">
  <div class="filter-pills">
    <button class="filter-pill active" data-filter="all" onclick="setStatusFilter('all',this)">All <span class="pill-count">${directives.length}</span></button>
    <button class="filter-pill" data-filter="active" onclick="setStatusFilter('active',this)">Active</button>
    <button class="filter-pill" data-filter="needs_action" onclick="setStatusFilter('needs_action',this)">Needs Action${needsActionCount > 0 ? ` <span class="pill-count">${needsActionCount}</span>` : ""}</button>
    <button class="filter-pill" data-filter="completed" onclick="setStatusFilter('completed',this)">Completed</button>
    <button class="filter-pill" data-filter="failed" onclick="setStatusFilter('failed',this)">Failed</button>
  </div>
</div>
<div id="directive-list">
${directives.length > 0 ? directiveCards : `<p class="empty">No directives.</p>`}
</div>
<div class="load-more-wrap" id="load-more-wrap"><button class="load-more-btn" id="load-more-btn" onclick="loadMore()">Load More</button><span id="load-more-count" style="color:#64748b;font-size:12px;margin-left:8px;"></span></div>
</section>

</div>

<!-- Approval Modal -->
<div class="modal-overlay" id="approval-modal">
  <div class="modal">
    <h3 id="modal-title">Approve Directive</h3>
    <div class="plan-text" id="modal-plan">Loading plan...</div>
    <div class="pin-row">
      <label for="modal-pin">PIN</label>
      <input type="password" id="modal-pin" maxlength="8" placeholder="Enter PIN" onkeydown="if(event.key==='Enter')submitApproval();">
    </div>
    <div class="modal-actions">
      <button class="btn-cancel-modal" onclick="closeApprovalModal()">Cancel</button>
      <button class="btn-approve-modal" id="modal-approve-btn" onclick="submitApproval()">Approve</button>
    </div>
    <div class="modal-error" id="modal-error"></div>
  </div>
</div>

<section class="new-directive">
<h2>New Quick Directive</h2>
<form id="directive-form" onsubmit="return submitDirective(event)">
  <label for="d-template">Template</label>
  <select id="d-template" onchange="applyTemplate(this.value)">
    <option value="">— None —</option>
${DIRECTIVE_TEMPLATES.map((t, i) => `    <option value="${i}">${escapeHtml(t.name)} (${escapeHtml(t.type)})</option>`).join("\n")}
  </select>
  <label for="d-title">Title</label>
  <input type="text" id="d-title" name="title" placeholder="Short description of the task" required>
  <label for="d-desc">Description</label>
  <textarea id="d-desc" name="description" placeholder="Detailed description of what needs to be done..."></textarea>
  <label for="d-type">Type</label>
  <select id="d-type" name="type">
    <option value="quick">Quick</option>
    <option value="feature">Feature</option>
    <option value="explore">Explore</option>
  </select>
  <label for="d-priority">Priority</label>
  <select id="d-priority" name="priority">
    <option value="1">Critical</option>
    <option value="2">High</option>
    <option value="3" selected>Normal</option>
    <option value="4">Low</option>
  </select>
  <button type="submit" class="submit-btn" id="submit-btn">Submit Directive</button>
  <div id="form-msg"></div>
</form>
</section>

<script>
// ── Utilities ──
function timeAgo(dateStr) {
  if (!dateStr) return "-";
  var d = new Date(typeof dateStr === "number" ? dateStr : dateStr);
  if (isNaN(d.getTime())) return String(dateStr);
  var now = Date.now();
  var diff = Math.floor((now - d.getTime()) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

function convertTimestamps() {
  document.querySelectorAll("[data-ts]").forEach(function(el) {
    var ts = el.getAttribute("data-ts");
    if (ts) { el.textContent = timeAgo(ts); el.title = ts; }
  });
}
convertTimestamps();

function escapeText(str) {
  if (!str) return "";
  var div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Filtering ──
var currentStatusFilter = "all";
var pageSize = 20;
var visibleCount = pageSize;

var activeStatuses = ["pending", "planning", "planned", "approved", "in_progress", "blocked"];
var failedStatuses = ["failed", "stale", "deploy_failed"];
var needsActionStatuses = ["planned", "blocked", "deploy_failed"];

function applyFilters() {
  var searchEl = document.getElementById("directive-search");
  var query = searchEl ? searchEl.value.toLowerCase().trim() : "";
  var cards = document.querySelectorAll(".directive-card");
  var matchCount = 0;
  var shownCount = 0;

  cards.forEach(function(card) {
    var status = card.getAttribute("data-status");
    var title = card.getAttribute("data-title") || "";

    var statusMatch = false;
    if (currentStatusFilter === "all") statusMatch = true;
    else if (currentStatusFilter === "active") statusMatch = activeStatuses.indexOf(status) !== -1;
    else if (currentStatusFilter === "completed") statusMatch = status === "completed";
    else if (currentStatusFilter === "failed") statusMatch = failedStatuses.indexOf(status) !== -1;
    else if (currentStatusFilter === "needs_action") statusMatch = needsActionStatuses.indexOf(status) !== -1;

    var searchMatch = !query || title.indexOf(query) !== -1;

    if (statusMatch && searchMatch) {
      matchCount++;
      if (matchCount <= visibleCount) {
        card.style.display = "";
        shownCount++;
      } else {
        card.style.display = "none";
      }
    } else {
      card.style.display = "none";
    }
  });

  var wrap = document.getElementById("load-more-wrap");
  var countEl = document.getElementById("load-more-count");
  if (wrap) {
    if (matchCount > shownCount) {
      wrap.style.display = "";
      if (countEl) countEl.textContent = "Showing " + shownCount + " of " + matchCount;
    } else {
      wrap.style.display = "none";
    }
  }
}

function setStatusFilter(filter, btn) {
  currentStatusFilter = filter;
  visibleCount = pageSize;
  document.querySelectorAll(".filter-pill").forEach(function(p) { p.classList.remove("active"); });
  if (btn) btn.classList.add("active");
  applyFilters();
}

function loadMore() { visibleCount += pageSize; applyFilters(); }
applyFilters();

// ── Auto-refresh ──
var refreshInterval = 10;
var countdown = refreshInterval;
var countdownEl = document.getElementById("countdown");
var contentEl = document.getElementById("dashboard-content");
var refreshedEl = document.getElementById("refreshed-at");

function refreshNow() {
  countdown = refreshInterval;
  contentEl.classList.add("updating");
  fetch("/dashboard")
    .then(function(r) { return r.text(); })
    .then(function(html) {
      var parser = new DOMParser();
      var doc = parser.parseFromString(html, "text/html");
      var newContent = doc.getElementById("dashboard-content");
      var newRefreshed = doc.getElementById("refreshed-at");
      var searchVal = "";
      var searchEl = document.getElementById("directive-search");
      if (searchEl) searchVal = searchEl.value;
      // Preserve open log panels
      var openLogs = [];
      document.querySelectorAll(".card-full-log").forEach(function(el) {
        if (el.style.display !== "none") openLogs.push(el.id);
      });
      if (newContent) contentEl.innerHTML = newContent.innerHTML;
      if (newRefreshed) refreshedEl.textContent = newRefreshed.textContent;
      var newSearchEl = document.getElementById("directive-search");
      if (newSearchEl) newSearchEl.value = searchVal;
      document.querySelectorAll(".filter-pill").forEach(function(p) {
        p.classList.remove("active");
        if (p.getAttribute("data-filter") === currentStatusFilter) p.classList.add("active");
      });
      openLogs.forEach(function(logId) {
        var el = document.getElementById(logId);
        if (el) el.style.display = "";
      });
      convertTimestamps();
      applyFilters();
      contentEl.classList.remove("updating");
    })
    .catch(function() { contentEl.classList.remove("updating"); });
}

setInterval(function() {
  countdown--;
  if (countdown <= 0) { refreshNow(); }
  else { countdownEl.textContent = "Next refresh in " + countdown + "s"; }
}, 1000);

// ── Directive Actions ──
function resolveViolation(id) {
  fetch("/api/pipeline-violations/" + id + "/resolve", { method: "POST" })
    .then(function(r) { return r.json(); })
    .then(function(data) { if (data.ok) refreshNow(); else alert("Error: " + (data.error || "Unknown")); })
    .catch(function(err) { alert("Network error: " + err.message); });
}

function cancelDirective(id) {
  if (!confirm("Cancel this directive?")) return;
  fetch("/directives/" + id + "/cancel", { method: "POST" })
    .then(function(r) { return r.json(); })
    .then(function(data) { if (data.ok) refreshNow(); else alert("Error: " + (data.error || "Unknown")); })
    .catch(function(err) { alert("Network error: " + err.message); });
}

function retryDirective(id) {
  if (!confirm("Retry this directive?")) return;
  fetch("/directives/" + id + "/retry", { method: "POST" })
    .then(function(r) { return r.json(); })
    .then(function(data) { if (data.ok) refreshNow(); else alert("Error: " + (data.error || "Unknown")); })
    .catch(function(err) { alert("Network error: " + err.message); });
}

function retryMerge(id) {
  if (!confirm("Retry merge for this directive?")) return;
  fetch("/directives/" + id + "/retry-merge", { method: "POST" })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) { alert("Merge succeeded! Deploying now."); refreshNow(); }
      else { alert("Merge failed: " + (data.error || "Unknown")); refreshNow(); }
    })
    .catch(function(err) { alert("Network error: " + err.message); });
}

function escalateDirective(id) {
  if (!confirm("Escalate this directive to Cipher for direct takeover?")) return;
  fetch("/directives/" + id + "/escalate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ escalatedBy: "King Kazuma", reason: "Manual escalation from dashboard" })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) { alert("Escalated to Cipher! Worker history preserved."); refreshNow(); }
      else { alert("Escalation failed: " + (data.error || "Unknown")); }
    })
    .catch(function(err) { alert("Network error: " + err.message); });
}

function unblockDirective(id) {
  if (!confirm("Unblock this directive?")) return;
  fetch("/directives/" + id + "/unblock", { method: "POST" })
    .then(function(r) { return r.json(); })
    .then(function(data) { if (data.ok) refreshNow(); else alert("Error: " + (data.error || "Unknown")); })
    .catch(function(err) { alert("Network error: " + err.message); });
}

// ── Comments ──
function toggleCommentInput(id) {
  var wrap = document.getElementById("comment-wrap-" + id);
  if (!wrap) return;
  wrap.style.display = wrap.style.display === "none" ? "flex" : "none";
  if (wrap.style.display === "flex") {
    var input = document.getElementById("comment-input-" + id);
    if (input) input.focus();
  }
}

function addComment(id) {
  var input = document.getElementById("comment-input-" + id);
  if (!input) return;
  var msg = input.value.trim();
  if (!msg) return;
  input.disabled = true;
  fetch("/directives/" + id + "/comment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: msg })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      input.disabled = false;
      if (data.ok) { input.value = ""; refreshNow(); }
      else alert("Error: " + (data.error || "Unknown"));
    })
    .catch(function(err) { input.disabled = false; alert("Network error: " + err.message); });
}

// ── Activity Log ──
function toggleActivityLog(id) {
  var panel = document.getElementById("log-" + id);
  if (!panel) return;
  var isHidden = panel.style.display === "none";
  panel.style.display = isHidden ? "" : "none";
  if (!isHidden) return;

  var container = document.getElementById("timeline-" + id);
  if (!container) return;
  container.innerHTML = '<span style="color:#475569;font-style:italic;">Loading audit trail...</span>';

  fetch("/directives/" + id + "/history")
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.timeline || data.timeline.length === 0) {
        container.innerHTML = '<span style="color:#475569;font-style:italic;">No activity yet.</span>';
        return;
      }
      var actorColors = { "King Kazuma": "king-kazuma", "June": "june", "Cipher": "cipher", "system": "system" };
      var html = data.timeline.map(function(e) {
        var actorClass = actorColors[e.actor] || "system";
        var actorBadge = e.actor ? '<span class="actor-badge actor-' + actorClass + '">' + escapeText(e.actor) + '</span>' : '';
        var sourceTag = e.source === "pg_history" ? ' <span style="font-size:9px;color:#475569;border:1px solid #334155;padding:0 3px;border-radius:2px;">PG</span>' : '';
        return '<div class="timeline-entry type-' + escapeText(e.type) + '">' +
          '<span style="color:#64748b;font-size:11px;flex-shrink:0;">' + timeAgo(e.timestamp) + '</span>' +
          actorBadge +
          '<span style="font-size:12px;color:#e2e8f0;flex:1;">' + escapeText(e.message) + '</span>' +
          sourceTag + '</div>';
      }).join("");
      container.innerHTML = html;
    })
    .catch(function(err) {
      container.innerHTML = '<span style="color:#ef4444;">Failed to load: ' + err.message + '</span>';
    });
}

// ── Approval Modal ──
var currentApprovalDirectiveId = null;

function openApprovalModal(directiveId) {
  currentApprovalDirectiveId = directiveId;
  var modal = document.getElementById("approval-modal");
  var titleEl = document.getElementById("modal-title");
  var planEl = document.getElementById("modal-plan");
  var pinEl = document.getElementById("modal-pin");
  var errEl = document.getElementById("modal-error");

  titleEl.textContent = "Loading...";
  planEl.textContent = "Loading plan details...";
  pinEl.value = "";
  errEl.textContent = "";
  modal.classList.add("active");

  // Fetch enriched approval details
  fetch("/approvals/details")
    .then(function(r) { return r.json(); })
    .then(function(approvals) {
      var match = approvals.find(function(a) { return a.directiveId === directiveId; });
      if (match) {
        titleEl.textContent = "Approve: " + (match.directiveTitle || directiveId);
        planEl.textContent = match.directivePlan || match.directiveDescription || "No plan text available.";
      } else {
        titleEl.textContent = "Approve: " + directiveId;
        planEl.textContent = "Could not load plan details. The directive may already be resolved.";
      }
      pinEl.focus();
    })
    .catch(function() {
      titleEl.textContent = "Approve: " + directiveId;
      planEl.textContent = "Failed to load plan details.";
      pinEl.focus();
    });
}

function closeApprovalModal() {
  document.getElementById("approval-modal").classList.remove("active");
  currentApprovalDirectiveId = null;
}

function submitApproval() {
  var pin = document.getElementById("modal-pin").value;
  var errEl = document.getElementById("modal-error");
  var btn = document.getElementById("modal-approve-btn");
  if (!pin) { errEl.textContent = "PIN is required."; return; }

  btn.disabled = true;
  btn.textContent = "Approving...";
  errEl.textContent = "";

  // Find the approval ID for this directive
  fetch("/approvals/details")
    .then(function(r) { return r.json(); })
    .then(function(approvals) {
      var match = approvals.find(function(a) { return a.directiveId === currentApprovalDirectiveId; });
      if (!match) { throw new Error("Approval not found — may already be resolved"); }
      return fetch("/approvals/" + match.id + "/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true, pin: pin })
      });
    })
    .then(function(r) { return r.json().then(function(d) { return { status: r.status, data: d }; }); })
    .then(function(res) {
      if (res.data.ok) {
        closeApprovalModal();
        refreshNow();
      } else {
        errEl.textContent = res.data.error || "Approval failed";
      }
    })
    .catch(function(err) { errEl.textContent = err.message; })
    .finally(function() { btn.disabled = false; btn.textContent = "Approve"; });
}

function denyDirective(directiveId) {
  if (!confirm("Deny this directive plan?")) return;
  fetch("/approvals/details")
    .then(function(r) { return r.json(); })
    .then(function(approvals) {
      var match = approvals.find(function(a) { return a.directiveId === directiveId; });
      if (!match) { alert("No pending approval found for this directive."); return; }
      // Deny doesn't require PIN — use a dummy to satisfy the endpoint
      return fetch("/approvals/" + match.id + "/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: false, pin: "" })
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.ok || data.error === "Invalid PIN") {
            // For deny, we also need the PIN — cancel the directive instead
            return fetch("/directives/" + directiveId + "/cancel", { method: "POST" })
              .then(function(r) { return r.json(); })
              .then(function() { refreshNow(); });
          }
          refreshNow();
        });
    })
    .catch(function(err) { alert("Error: " + err.message); });
}

// ── Template + Submit ──
var directiveTemplates = ${JSON.stringify(DIRECTIVE_TEMPLATES)};
function applyTemplate(idx) {
  if (idx === "") return;
  var t = directiveTemplates[parseInt(idx, 10)];
  if (!t) return;
  document.getElementById("d-title").value = t.titleTemplate;
  document.getElementById("d-desc").value = t.descriptionTemplate;
  document.getElementById("d-type").value = t.type;
}

function submitDirective(e) {
  e.preventDefault();
  var title = document.getElementById("d-title").value.trim();
  var desc = document.getElementById("d-desc").value.trim();
  var type = document.getElementById("d-type").value;
  var priority = parseInt(document.getElementById("d-priority").value, 10) || 3;
  var msgEl = document.getElementById("form-msg");
  var btn = document.getElementById("submit-btn");

  if (!title) { msgEl.className = "form-msg err"; msgEl.textContent = "Title is required."; return false; }

  btn.disabled = true;
  btn.textContent = "Submitting...";
  msgEl.textContent = "";
  msgEl.className = "form-msg";

  fetch("/directives", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: type, title: title, description: desc || title, priority: priority })
  })
    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
    .then(function(res) {
      if (res.ok) {
        msgEl.className = "form-msg ok";
        msgEl.textContent = "Directive created: " + (res.data.id || "success");
        document.getElementById("d-title").value = "";
        document.getElementById("d-desc").value = "";
        document.getElementById("d-template").value = "";
        setTimeout(refreshNow, 1000);
      } else {
        msgEl.className = "form-msg err";
        msgEl.textContent = "Error: " + (res.data.error || "Unknown error");
      }
    })
    .catch(function(err) {
      msgEl.className = "form-msg err";
      msgEl.textContent = "Network error: " + err.message;
    })
    .finally(function() {
      btn.disabled = false;
      btn.textContent = "Submit Directive";
    });

  return false;
}

// Close modal on escape key or clicking overlay
document.addEventListener("keydown", function(e) {
  if (e.key === "Escape") closeApprovalModal();
});
document.getElementById("approval-modal").addEventListener("click", function(e) {
  if (e.target === this) closeApprovalModal();
});

// ── Build Status Polling ──
var buildPollTimer = null;
var buildPollInterval = 30000;
var buildHasActive = false;

function renderBuildCard(platform, runs) {
  var statusEl = document.getElementById("build-" + platform + "-status");
  var metaEl = document.getElementById("build-" + platform + "-meta");
  var cardEl = document.getElementById("build-" + platform);
  if (!statusEl || !metaEl || !cardEl) return;

  if (!runs || !Array.isArray(runs) || runs.length === 0) {
    statusEl.textContent = "No runs";
    statusEl.className = "value";
    metaEl.textContent = "";
    cardEl.style.borderLeftColor = "#6b7280";
    return;
  }

  var data = runs[0]; // Latest run
  var isActive = data.status === "in_progress" || data.status === "queued" || data.status === "waiting";
  var succeeded = data.conclusion === "success";
  var failed = data.conclusion === "failure" || data.conclusion === "cancelled";

  if (isActive) {
    buildHasActive = true;
    statusEl.textContent = data.status === "in_progress" ? "Building..." : data.status === "queued" ? "Queued" : "Waiting";
    statusEl.className = "value warn";
    cardEl.style.borderLeftColor = "#f59e0b";
  } else if (succeeded) {
    statusEl.textContent = "Success";
    statusEl.className = "value ok";
    cardEl.style.borderLeftColor = "#10b981";
  } else if (failed) {
    statusEl.textContent = data.conclusion === "cancelled" ? "Cancelled" : "Failed";
    statusEl.className = "value bad";
    cardEl.style.borderLeftColor = "#ef4444";
  } else {
    statusEl.textContent = data.status || "Unknown";
    statusEl.className = "value";
    cardEl.style.borderLeftColor = "#6b7280";
  }

  var meta = timeAgo(data.createdAt);
  if (data.headBranch) meta = '<span style="color:#94a3b8;">' + escapeText(data.headBranch) + '</span> &middot; ' + meta;
  if (data.url) {
    meta = '<a href="' + escapeText(data.url) + '" target="_blank" style="color:#3b82f6;text-decoration:none;">' + meta + ' &rarr; View</a>';
  }
  metaEl.innerHTML = meta;
}

function fetchBuildStatus() {
  fetch("/api/build-status")
    .then(function(r) { return r.json(); })
    .then(function(data) {
      buildHasActive = false;
      renderBuildCard("android", data.android);
      renderBuildCard("ios", data.ios);

      // Poll faster when builds are active
      clearInterval(buildPollTimer);
      buildPollTimer = setInterval(fetchBuildStatus, buildHasActive ? buildPollInterval : 120000);
    })
    .catch(function() {});
}

fetchBuildStatus();
buildPollTimer = setInterval(fetchBuildStatus, buildPollInterval);

// ── Per-directive build status polling ──
var directiveBuildPollTimer = null;
function pollDirectiveBuildStatus() {
  var buildBadges = document.querySelectorAll(".card-build-status[data-directive-id]");
  buildBadges.forEach(function(el) {
    var dirId = el.getAttribute("data-directive-id");
    if (!dirId) return;
    // Only poll for directives with active (non-terminal) builds
    var hasActive = el.innerHTML.indexOf("building") !== -1 || el.innerHTML.indexOf("queued") !== -1;
    if (!hasActive) return;

    fetch("/directives/" + dirId + "/build-status")
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.buildRuns || !data.buildRuns.length) return;
        var html = "";
        data.buildRuns.forEach(function(run) {
          var isActive = run.status === "in_progress" || run.status === "queued";
          var succeeded = run.status === "completed" && run.conclusion === "success";
          var failed = run.status === "completed" && (run.conclusion === "failure" || run.conclusion === "cancelled");
          var badgeColor = isActive ? "#3b82f6" : succeeded ? "#10b981" : failed ? "#ef4444" : "#6b7280";
          var label = run.platform === "android" ? "Android" : run.platform === "ios" ? "iOS" : escapeText(run.platform);
          var statusText = isActive ? (run.status === "in_progress" ? "building" : "queued") : (run.conclusion || run.status);
          var dot = isActive ? "&#9679;" : succeeded ? "&#10003;" : failed ? "&#10007;" : "&#9679;";
          html += '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:4px;background:' + badgeColor + '18;border:1px solid ' + badgeColor + ';color:' + badgeColor + ';font-size:11px;font-weight:bold;" title="Run #' + run.runId + '">' + dot + ' ' + label + ': ' + escapeText(statusText) + '</span> ';
        });
        el.innerHTML = html;
      })
      .catch(function() {});
  });
}
directiveBuildPollTimer = setInterval(pollDirectiveBuildStatus, 15000);
</script>

</body></html>`;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS });
      res.end(html);
      return true;
    }
    return false;
  };
};
