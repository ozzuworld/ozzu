// routes/mcp.js — MCP (Model Context Protocol) server for Claude Code
// Exposes directive management as native Claude Code tools
// Spec: https://modelcontextprotocol.io/specification/2025-03-26

"use strict";

module.exports = function mcpRoutes(ctx) {
  const { sendJSON, parseBody, db, log: logObj, getDirectives, saveDirectives,
          broadcastToAll, sendNotification } = ctx;
  const log = typeof logObj === "function" ? logObj : (...args) => (logObj?.bridge?.info?.(...args) || console.log(...args));

  const watchdog = (() => { try { return require("../watchdog"); } catch { return null; } })();
  const buildVerifier = (() => { try { return require("../build-verifier"); } catch { return null; } })();
  const { mergeWorktreeToMain, smartDeploy } = (() => {
    try { return require("../agent-spawner"); } catch { return {}; }
  })();

  // ── Tool definitions ──

  const TOOLS = [
    {
      name: "list_directives",
      description: "List all directives with their current status. Returns id, title, status, emoji, work_summary for each.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status (completed, in_progress, approved, planning, deploy_failed, blocked). Omit for all." },
        },
      },
    },
    {
      name: "create_directive",
      description: "Create a new directive to track a code change. MUST be called before writing any code.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title describing the change" },
          description: { type: "string", description: "Detailed description of what will be done" },
          type: { type: "string", enum: ["quick", "feature"], description: "quick = fix/refactor (no approval needed), feature = new functionality (needs PIN approval)" },
          emoji: { type: "string", description: "Single emoji representing this work" },
        },
        required: ["title", "description", "type", "emoji"],
      },
    },
    {
      name: "update_directive",
      description: "Update a directive's status, working_state, or work_summary.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Directive ID (dir_XXXXX)" },
          status: { type: "string", enum: ["in_progress", "blocked", "planning", "planned"], description: "New status" },
          work_summary: { type: "string", description: "Summary of work done so far" },
          working_state: { type: "object", description: "Structured state (progress, blockers, etc.)" },
          failureReason: { type: "string", description: "Why this directive is blocked/failed" },
        },
        required: ["id"],
      },
    },
    {
      name: "merge_and_deploy",
      description: "Verify, merge branch to main, and trigger deploy. The final step after code is committed.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Directive ID" },
          branch: { type: "string", description: "Branch name to merge (e.g. cipher/dir_XXXXX)" },
        },
        required: ["id", "branch"],
      },
    },
    {
      name: "check_pipeline",
      description: "Check the health of the entire pipeline — stuck directives, failed deploys, service status.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_service_status",
      description: "Get real-time health status of all monitored services (postgres, redis, nginx, etc.).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "send_email",
      description: "Send an email from eng.ozzu@gmail.com (Skyline Capital). Use for contacting suppliers, buyers, business communications. Always draft first and show to King Kazuma before sending unless he says otherwise.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address" },
          subject: { type: "string", description: "Email subject line" },
          text: { type: "string", description: "Plain text body" },
          html: { type: "string", description: "HTML body (optional, for professional formatting)" },
          cc: { type: "string", description: "CC recipients (comma-separated)" },
          contactId: { type: "number", description: "Link to a business contact ID" },
          directiveId: { type: "string", description: "Link to a directive ID" },
        },
        required: ["to", "subject", "text"],
      },
    },
    {
      name: "list_emails",
      description: "List sent emails and drafts from the business email log.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["sent", "draft"], description: "Filter by status" },
          limit: { type: "number", description: "Max results (default 20)" },
        },
      },
    },
  ];

  // ── Tool handlers ──

  async function handleTool(name, args) {
    switch (name) {
      case "list_directives": {
        const directives = getDirectives();
        let filtered = directives;
        if (args.status) {
          filtered = directives.filter(d => d.status === args.status);
        }
        const summary = filtered.map(d => ({
          id: d.id, title: d.title, status: d.status, emoji: d.emoji, type: d.type,
          work_summary: d.work_summary || null,
          failureReason: d.failureReason || null,
          createdAt: d.createdAt,
        }));
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      }

      case "create_directive": {
        const id = `dir_${Date.now()}`;
        const directive = {
          id, type: args.type, title: args.title, description: args.description,
          emoji: args.emoji, status: args.type === "quick" ? "in_progress" : "pending",
          plan: null, directiveApprovalId: null, retryCount: 0, failureReason: null,
          priority: 3, dependsOn: null, epicId: null, phaseOrder: null,
          createdBy: "cipher", working_state: null, work_summary: null, handoff_context: null,
          activity_log: [{ timestamp: Date.now(), type: "status_change", actor: "cipher", message: `Directive created with status: ${args.type === "quick" ? "in_progress" : "pending"}` }],
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        if (args.type === "quick") {
          directive.startedAt = Date.now();
        }
        const directives = getDirectives();
        directives.push(directive);
        saveDirectives(directives);
        try { await db.saveDirective(directive); } catch {}
        return { content: [{ type: "text", text: `Created directive ${id} (${args.type}): ${args.title}\nStatus: ${directive.status}\nBranch: cipher/${id}` }] };
      }

      case "update_directive": {
        const directives = getDirectives();
        const d = directives.find(dd => dd.id === args.id);
        if (!d) return { content: [{ type: "text", text: `Error: directive ${args.id} not found` }], isError: true };
        if (args.status) {
          const prev = d.status;
          d.status = args.status;
          d.activity_log = d.activity_log || [];
          d.activity_log.push({ timestamp: Date.now(), type: "status_change", actor: "Cipher", message: `Status changed from ${prev} to ${args.status}` });
          if (args.status === "in_progress" && !d.startedAt) d.startedAt = Date.now();
        }
        if (args.work_summary) d.work_summary = args.work_summary;
        if (args.working_state) d.working_state = args.working_state;
        if (args.failureReason) d.failureReason = args.failureReason;
        d.updatedAt = Date.now();
        d.lastActivity = Date.now();
        saveDirectives(directives);
        try { await db.saveDirective(d); } catch {}
        return { content: [{ type: "text", text: `Updated ${args.id}: status=${d.status}` }] };
      }

      case "merge_and_deploy": {
        const directives = getDirectives();
        const d = directives.find(dd => dd.id === args.id);
        if (!d) return { content: [{ type: "text", text: `Error: directive ${args.id} not found` }], isError: true };
        if (d.status !== "in_progress") {
          return { content: [{ type: "text", text: `Error: directive must be in_progress (currently ${d.status})` }], isError: true };
        }

        // Verify
        let verifyResult = { success: true };
        if (buildVerifier) {
          try {
            verifyResult = await buildVerifier.verify(d);
          } catch (err) {
            return { content: [{ type: "text", text: `Verification error: ${err.message}` }], isError: true };
          }
        }
        if (!verifyResult.success) {
          return { content: [{ type: "text", text: `Verification FAILED: ${verifyResult.failure_reason || "unknown"}\n${(verifyResult.verification_log || []).join("\n")}` }], isError: true };
        }

        // Merge
        let mergeOk = false;
        if (mergeWorktreeToMain) {
          mergeOk = mergeWorktreeToMain(args.id, args.branch);
        }
        if (!mergeOk) {
          d.status = "deploy_failed";
          d.failureReason = `Merge failed for branch ${args.branch}`;
          d.mergeBranch = args.branch;
          saveDirectives(directives);
          // Alert
          if (typeof broadcastToAll === "function") {
            broadcastToAll({ type: "opsAlert", service: "pipeline", status: "deploy_failed", severity: "high", ts: new Date().toISOString(), details: { directive: args.id, branch: args.branch } });
          }
          return { content: [{ type: "text", text: `Merge FAILED for ${args.branch}. Directive set to deploy_failed. Check git state.` }], isError: true };
        }

        // Success
        d.status = "completed";
        d.completedAt = Date.now();
        d.duration = d.startedAt ? Date.now() - d.startedAt : null;
        d.verification_result = verifyResult;
        d.activity_log.push({ timestamp: Date.now(), type: "merged", actor: "Cipher", message: `Branch ${args.branch} merged to main` });
        d.activity_log.push({ timestamp: Date.now(), type: "status_change", actor: "Cipher", message: "Status changed from in_progress to completed" });
        saveDirectives(directives);
        try { await db.saveDirective(d); } catch {}

        // Deploy (async)
        if (smartDeploy) {
          try { smartDeploy(d); } catch {}
        }

        return { content: [{ type: "text", text: `✓ Merged ${args.branch} → main. Directive ${args.id} completed. Deploy triggered.` }] };
      }

      case "check_pipeline": {
        const directives = getDirectives();
        const stuck = directives.filter(d => ["deploy_failed", "blocked", "stale"].includes(d.status));
        const inProgress = directives.filter(d => d.status === "in_progress");
        const pending = directives.filter(d => ["pending", "planning", "planned", "approved"].includes(d.status));
        const completed = directives.filter(d => d.status === "completed");

        let report = `Pipeline Health Report\n${"─".repeat(40)}\n`;
        report += `Completed: ${completed.length} | Active: ${inProgress.length} | Pending: ${pending.length} | Problems: ${stuck.length}\n\n`;

        if (stuck.length > 0) {
          report += `⚠️  PROBLEMS:\n`;
          for (const d of stuck) {
            report += `  ${d.emoji} ${d.id} [${d.status}] ${d.title}\n`;
            if (d.failureReason) report += `    Reason: ${d.failureReason}\n`;
          }
          report += "\n";
        }
        if (inProgress.length > 0) {
          report += `🔄 IN PROGRESS:\n`;
          for (const d of inProgress) {
            report += `  ${d.emoji} ${d.id} ${d.title}\n`;
          }
          report += "\n";
        }
        if (pending.length > 0) {
          report += `⏸️  PENDING:\n`;
          for (const d of pending) {
            report += `  ${d.emoji} ${d.id} [${d.status}] ${d.title}\n`;
          }
        }

        // Service health
        if (watchdog) {
          const status = watchdog.getStatus();
          const down = Object.entries(status).filter(([, s]) => s.status === "down");
          if (down.length > 0) {
            report += `\n🔴 SERVICES DOWN: ${down.map(([n]) => n).join(", ")}`;
          }
        }

        return { content: [{ type: "text", text: report }] };
      }

      case "get_service_status": {
        if (!watchdog) return { content: [{ type: "text", text: "Watchdog not available" }], isError: true };
        const status = watchdog.getStatus();
        return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
      }

      case "send_email": {
        const http = require("http");
        const payload = JSON.stringify({
          to: args.to, subject: args.subject, text: args.text,
          html: args.html, cc: args.cc,
          contactId: args.contactId, directiveId: args.directiveId,
        });
        const result = await new Promise((resolve) => {
          const req = http.request({ hostname: "localhost", port: 3333, path: "/business/email/send", method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
          }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } }); });
          req.on("error", e => resolve({ error: e.message }));
          req.write(payload); req.end();
        });
        if (result.error) return { content: [{ type: "text", text: `Email send failed: ${result.error}` }], isError: true };
        return { content: [{ type: "text", text: `Email sent to ${args.to}. Subject: "${args.subject}". MessageId: ${result.messageId}` }] };
      }

      case "list_emails": {
        const qs = new URLSearchParams();
        if (args.status) qs.set("status", args.status);
        qs.set("limit", String(args.limit || 20));
        const result = await new Promise((resolve) => {
          const http = require("http");
          http.get(`http://localhost:3333/business/emails?${qs}`, (res) => {
            let d = ""; res.on("data", c => d += c);
            res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } });
          }).on("error", e => resolve({ error: e.message }));
        });
        if (result.error) return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
        const summary = (result.emails || []).map(e => ({
          id: e.id, to: e.to_addr, subject: e.subject, status: e.status,
          sent_at: e.sent_at, created_at: e.created_at,
        }));
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  }

  // ── MCP HTTP Protocol (Streamable HTTP transport) ──

  return async function handleMcpRoutes(req, res, pathname, url) {

    // MCP endpoint — handles JSON-RPC 2.0 over HTTP
    if (pathname === "/mcp" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body || !body.method) {
        sendJSON(res, 400, { jsonrpc: "2.0", error: { code: -32600, message: "Invalid request" }, id: body?.id || null });
        return true;
      }

      const { method, params, id } = body;

      switch (method) {
        case "initialize": {
          sendJSON(res, 200, {
            jsonrpc: "2.0",
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "ozzu-bridge", version: "1.0.0" },
            },
            id,
          });
          return true;
        }

        case "notifications/initialized": {
          // Client acknowledges init — no response needed for notifications
          sendJSON(res, 200, { jsonrpc: "2.0", result: {}, id });
          return true;
        }

        case "tools/list": {
          sendJSON(res, 200, {
            jsonrpc: "2.0",
            result: { tools: TOOLS },
            id,
          });
          return true;
        }

        case "tools/call": {
          const toolName = params?.name;
          const toolArgs = params?.arguments || {};
          try {
            const result = await handleTool(toolName, toolArgs);
            sendJSON(res, 200, { jsonrpc: "2.0", result, id });
          } catch (err) {
            sendJSON(res, 200, {
              jsonrpc: "2.0",
              result: { content: [{ type: "text", text: `Tool error: ${err.message}` }], isError: true },
              id,
            });
          }
          return true;
        }

        default: {
          sendJSON(res, 200, {
            jsonrpc: "2.0",
            error: { code: -32601, message: `Method not found: ${method}` },
            id,
          });
          return true;
        }
      }
    }

    return false;
  };
};
