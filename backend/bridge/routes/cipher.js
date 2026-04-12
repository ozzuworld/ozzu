// routes/cipher.js — Cipher context, history, session-save, live-push (extracted from server.js)

module.exports = function createCipherRoutes(ctx) {
  const { db, log, sendJSON, parseBody, CORS_HEADERS, GEMINI_API_KEY,
          getDirectives, getEpicProgress, buildSituationBriefing,
          redis, isRedisConnected,
          getConversationTranscript, getCurrentPersona, isVoiceActive,
          sendNotification, cipherDaemon, actionQueue, proactiveReporter } = ctx;

  return async function handleCipherRoutes(req, res, pathname, url) {
  if (req.method === "GET" && pathname === "/conversations/recent") {
    const limit = parseInt(url.searchParams.get("limit") || "10", 10);
    const { rows, total } = await db.getRecentConversations(Math.min(limit, 50));
    const conversations = rows.map(r => ({
      id: r.id,
      persona: r.persona,
      summary: r.summary,
      turn_count: r.turn_count,
      topics: r.topics || [],
      started_at: r.started_at,
      ended_at: r.ended_at,
      duration_minutes: r.duration_minutes != null ? Math.round(r.duration_minutes * 10) / 10 : null,
    }));
    sendJSON(res, 200, { total, conversations });
    return true;
  }

  // GET /cipher/history — retrieve Cipher conversation history with full turns
  if (req.method === "GET" && pathname === "/cipher/history") {
    try {
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 500);
      const conversationLimit = Math.min(parseInt(url.searchParams.get("conversations") || "5", 10), 20);
      const since = url.searchParams.get("since") || null;
      const typesParam = url.searchParams.get("types");
      const contentTypes = typesParam ? typesParam.split(",").map(t => t.trim()) : null;
      const format = url.searchParams.get("format") || "json";

      const conversations = await db.getConversationHistory({
        persona: "cipher",
        limit,
        conversationLimit,
        since,
        contentTypes,
      });

      if (format === "text") {
        // Human-readable text format for CLI piping
        let text = "";
        for (const c of conversations) {
          const startDate = c.startedAt ? new Date(c.startedAt).toLocaleString() : "?";
          const duration = c.endedAt && c.startedAt
            ? Math.round((new Date(c.endedAt) - new Date(c.startedAt)) / 60000)
            : "?";
          text += `--- Session ${c.id} (${startDate} — ${duration} min) ---\n`;
          if (c.summary) text += `Summary: ${c.summary}\n`;
          for (const t of c.turns) {
            const prefix = `[${t.role}]`;
            if (t.contentType === "upload") {
              text += `${prefix} [upload] ${t.content}\n`;
            } else if (t.contentType === "tool_result" || t.contentType === "tool_call") {
              text += `[tool_call] ${t.content}\n`;
            } else {
              text += `${prefix} ${t.content}\n`;
            }
          }
          text += "\n";
        }
        res.writeHead(200, { "Content-Type": "text/plain", ...CORS_HEADERS });
        res.end(text);
      } else {
        sendJSON(res, 200, { conversations });
      }
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /cipher/state — structured machine-readable state for Cipher boot
  if (req.method === "GET" && pathname === "/cipher/state") {
    try {
      const now = Date.now();
      const directives = getDirectives();

      // ── Directives by status ──
      const needsAttention = directives.filter(d => ["blocked", "deploy_failed", "failed", "stale"].includes(d.status));
      const active = directives.filter(d => ["in_progress", "planning", "planned", "approved", "pending"].includes(d.status));
      const recentCompleted = directives
        .filter(d => d.status === "completed")
        .sort((a, b) => (b.completedAt || b.updatedAt || 0) - (a.completedAt || a.updatedAt || 0))
        .slice(0, 5);

      // ── Service health ──
      let services = {};
      try {
        const watchdog = ctx.watchdog || (ctx.getWatchdog && ctx.getWatchdog());
        if (watchdog && watchdog.getStatus) {
          const status = watchdog.getStatus();
          for (const [name, svc] of Object.entries(status.services || {})) {
            services[name] = { status: svc.status, latency: svc.latency_ms };
          }
        }
      } catch {}
      // Fallback: try HTTP
      if (Object.keys(services).length === 0) {
        try {
          const http = require("http");
          const data = await new Promise((resolve, reject) => {
            const req = http.get("http://127.0.0.1:3333/ops/status", { timeout: 2000 }, (res) => {
              let body = ""; res.on("data", c => body += c); res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
            });
            req.on("error", reject); req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
          });
          if (data && data.services) {
            for (const [name, svc] of Object.entries(data.services)) {
              services[name] = { status: svc.status, latency: svc.latency_ms };
            }
          }
        } catch {}
      }
      const downServices = Object.entries(services).filter(([, v]) => v.status === "down").map(([k]) => k);
      const degradedServices = Object.entries(services).filter(([, v]) => v.status === "degraded").map(([k]) => k);

      // ── GPU/Training ──
      let gpu = null;
      try {
        const http = require("http");
        const qdrantData = await new Promise((resolve, reject) => {
          const req = http.get("http://127.0.0.1:6333/collections/faces", { timeout: 3000 }, (res) => {
            let body = ""; res.on("data", c => body += c); res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
          });
          req.on("error", () => resolve(null)); req.on("timeout", () => { req.destroy(); resolve(null); });
        });
        if (qdrantData && qdrantData.result) {
          gpu = { faceCount: qdrantData.result.points_count || 0 };
        }
      } catch {}

      // ── Ventures ──
      let ventures = [];
      try {
        const ventureRows = await db.query("SELECT id, name, status FROM business_ventures ORDER BY created_at DESC LIMIT 5");
        if (ventureRows && ventureRows.rows) {
          ventures = ventureRows.rows.map(v => ({ id: v.id, name: v.name, status: v.status }));
        }
      } catch {}

      // ── Delta since last session ──
      let delta = { completedSince: [], failedSince: [], newSince: [] };
      try {
        // Find when last cipher session started
        const lastSession = await db.query(
          "SELECT started_at FROM conversations WHERE persona = 'cipher' ORDER BY started_at DESC LIMIT 1 OFFSET 1"
        );
        if (lastSession.rows.length > 0) {
          const since = new Date(lastSession.rows[0].started_at).getTime();
          delta.completedSince = directives
            .filter(d => d.status === "completed" && (d.completedAt || d.updatedAt) > since)
            .map(d => ({ id: d.id, title: d.title, emoji: d.emoji }));
          delta.failedSince = directives
            .filter(d => ["failed", "deploy_failed", "blocked"].includes(d.status) && d.updatedAt > since)
            .map(d => ({ id: d.id, title: d.title, status: d.status, reason: d.failureReason }));
          delta.newSince = directives
            .filter(d => d.createdAt > since && !delta.completedSince.find(c => c.id === d.id))
            .map(d => ({ id: d.id, title: d.title, status: d.status, emoji: d.emoji }));
        }
      } catch {}

      // ── Known facts (from memory file) ──
      let knownFacts = [];
      try {
        const fs = require("fs");
        const memPath = "/root/.claude/projects/-home-gcp-ozzu/memory/MEMORY.md";
        if (fs.existsSync(memPath)) {
          const content = fs.readFileSync(memPath, "utf8");
          // Extract bullet points from CRITICAL section
          const critMatch = content.match(/## CRITICAL[^#]*/s);
          if (critMatch) {
            const bullets = critMatch[0].match(/- \*\*[^*]+\*\*[^\n]*/g) || [];
            knownFacts = bullets.map(b => b.replace(/^- \*\*/, "").replace(/\*\*/, ":"));
          }
        }
      } catch {}

      // ── Pending actions ──
      const pendingActions = [];
      if (needsAttention.length > 0) {
        for (const d of needsAttention) {
          pendingActions.push({ priority: 1, action: `Fix ${d.status} directive: "${d.title}"`, directiveId: d.id, reason: d.failureReason });
        }
      }
      // Don't add service status to pending actions — it goes stale.
      // Cipher should check live via get_service_status MCP tool.

      const state = {
        timestamp: new Date().toISOString(),
        summary: needsAttention.length > 0
          ? `${needsAttention.length} thing${needsAttention.length > 1 ? "s" : ""} need attention`
          : active.length > 0
            ? `${active.length} active, all clear`
            : "Nothing active",
        directives: {
          needsAttention: needsAttention.map(d => ({ id: d.id, title: d.title, status: d.status, emoji: d.emoji, category: d.category, reason: d.failureReason })),
          active: active.map(d => ({ id: d.id, title: d.title, status: d.status, emoji: d.emoji, category: d.category })),
          recentCompleted: recentCompleted.map(d => ({ id: d.id, title: d.title, emoji: d.emoji, completedAt: d.completedAt })),
          total: directives.length,
        },
        services: {
          healthy: Object.entries(services).filter(([, v]) => v.status === "healthy").length,
          down: downServices,
          degraded: degradedServices,
        },
        gpu,
        ventures,
        delta,
        pendingActions,
        knownFacts,
      };

      sendJSON(res, 200, state);
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /cipher/context — structured state-first context for CLAUDE.local.md
  if (req.method === "GET" && pathname === "/cipher/context") {
    try {
      const http = require("http");
      const now = Date.now();
      const directives = getDirectives();

      // ── Fetch structured state ──
      let state = null;
      try {
        state = await new Promise((resolve, reject) => {
          const req = http.get("http://127.0.0.1:3333/cipher/state", { timeout: 5000 }, (res) => {
            let body = ""; res.on("data", c => body += c); res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
          });
          req.on("error", () => resolve(null)); req.on("timeout", () => { req.destroy(); resolve(null); });
        });
      } catch {}

      // ── Time context ──
      const timeStr = new Date().toLocaleString("en-US", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
        hour: "2-digit", minute: "2-digit", timeZone: "America/New_York"
      });

      // ── Last session info ──
      let lastSessionInfo = "";
      try {
        const lastSession = await db.query(
          "SELECT started_at, summary FROM conversations WHERE persona = 'cipher' AND turn_count >= 2 ORDER BY started_at DESC LIMIT 1"
        );
        if (lastSession.rows.length > 0) {
          const ago = Math.round((now - new Date(lastSession.rows[0].started_at).getTime()) / 60000);
          const agoStr = ago < 60 ? `${ago} min ago` : ago < 1440 ? `${Math.round(ago / 60)} hours ago` : `${Math.round(ago / 1440)} days ago`;
          lastSessionInfo = `Last session: ${agoStr}`;
          if (lastSession.rows[0].summary) {
            lastSessionInfo += ` — ${lastSession.rows[0].summary}`;
          }
        }
      } catch {}

      // ── Build WHAT CHANGED section ──
      let deltaSection = "";
      if (state && state.delta) {
        const parts = [];
        if (state.delta.completedSince.length > 0) {
          parts.push(`Completed since last session:\n${state.delta.completedSince.map(d => `  ${d.emoji || "✅"} ${d.title}`).join("\n")}`);
        }
        if (state.delta.failedSince.length > 0) {
          parts.push(`Failed/blocked since last session:\n${state.delta.failedSince.map(d => `  ❌ ${d.title} — ${d.status}${d.reason ? ": " + d.reason : ""}`).join("\n")}`);
        }
        if (state.delta.newSince.length > 0) {
          parts.push(`New since last session:\n${state.delta.newSince.map(d => `  ${d.emoji || "🆕"} ${d.title} (${d.status})`).join("\n")}`);
        }
        if (parts.length > 0) {
          deltaSection = "\n## What Changed\n" + parts.join("\n\n");
        } else {
          deltaSection = "\n## What Changed\nNothing changed since your last session.";
        }
      }

      // ── PENDING ACTIONS (most important — goes first after identity) ──
      let actionsSection = "";
      if (state && state.pendingActions && state.pendingActions.length > 0) {
        actionsSection = "\n## Pending Actions (handle these first)\n" +
          state.pendingActions.map((a, i) => `${i + 1}. ${a.action}${a.directiveId ? ` (${a.directiveId})` : ""}`).join("\n");
      }

      // ── Action Queue (from between sessions) ──
      let actionQueueSection = "";
      if (actionQueue) {
        try { actionQueueSection = await actionQueue.getContextBlock(); } catch {}
      }

      // ── Current state overview ──
      let stateSection = "";
      if (state) {
        const parts = [];
        parts.push(`Status: ${state.summary}`);

        // Services — DO NOT include live status here, it goes stale between sessions.
        // Cipher must query live via get_service_status MCP tool.
        parts.push(`Services: ${state.services.healthy} monitored — query get_service_status for live status, NEVER state from this context`);

        // GPU — DO NOT include face count here, it goes stale.
        // Cipher must query Qdrant live: curl localhost:6333/collections/faces
        parts.push(`Face DB: query curl localhost:6333/collections/faces — NEVER state count from this context`);

        // Ventures
        if (state.ventures && state.ventures.length > 0) {
          parts.push(`Ventures: ${state.ventures.map(v => `${v.name} (${v.status})`).join(", ")}`);
        }

        stateSection = "\n## Current State\n" + parts.join("\n");
      }

      // ── Active directives (compact) ──
      let directivesSection = "";
      const needsAttention = directives.filter(d => ["blocked", "deploy_failed", "failed", "stale"].includes(d.status));
      const active = directives.filter(d => ["in_progress", "planning", "planned", "approved", "pending"].includes(d.status));
      if (needsAttention.length > 0 || active.length > 0) {
        directivesSection = "\n## Active Directives\n";
        if (needsAttention.length > 0) {
          directivesSection += "**Needs attention:**\n" +
            needsAttention.map(d => `- [${d.status}] ${d.emoji || "⚠️"} ${d.title} (${d.id})${d.failureReason ? " — " + d.failureReason : ""}`).join("\n") + "\n\n";
        }
        directivesSection += active.map(d => {
          let line = `- [${d.status}] ${d.emoji || "•"} ${d.title} (${d.id}, ${d.category || "dev"})`;
          // Show handoff context for in_progress directives so fresh sessions know what's happening
          if (d.status === "in_progress" && d.handoff_context) {
            const ctx = typeof d.handoff_context === "string" ? d.handoff_context : JSON.stringify(d.handoff_context);
            line += `\n  > Last state: ${ctx.substring(0, 300)}${ctx.length > 300 ? "..." : ""}`;
          }
          return line;
        }).join("\n");
      }

      // ── Active Epics ──
      let epicSection = "";
      const epicDirectives = directives.filter(d => d.type === "epic" && !["completed", "cancelled"].includes(d.status));
      if (epicDirectives.length > 0) {
        epicSection = "\n## Active Epics\n";
        for (const epic of epicDirectives) {
          const phases = directives.filter(d => d.epicId === epic.id).sort((a, b) => (a.phaseOrder || 0) - (b.phaseOrder || 0));
          const progress = getEpicProgress(epic.id);
          epicSection += `${epic.emoji || "📦"} ${epic.title} — ${progress.completed}/${progress.total} phases\n`;
          for (const phase of phases) {
            const marker = ["in_progress", "planning", "planned", "approved"].includes(phase.status) ? " ← CURRENT" : "";
            epicSection += `  [${phase.status}] Phase ${phase.phaseOrder || "?"}: ${phase.title}${marker}\n`;
          }
        }
      }

      // ── Known facts (verified truths — avoid repeating mistakes) ──
      let factsSection = "";
      if (state && state.knownFacts && state.knownFacts.length > 0) {
        factsSection = "\n## Known Facts (verified — do not contradict)\n" +
          state.knownFacts.map(f => `- ${f}`).join("\n");
      }

      // Recent Sessions and Critical Reminders removed — duplicated CLAUDE.md rules
      // and wasted context tokens every turn. Session history is in postgres,
      // searchable via /cipher/search?q=keyword.

      const markdown = [
        `# Cipher Context — Auto-generated (do not edit)`,
        `# Generated: ${new Date().toISOString()}`,
        ``,
        `## You are Cipher`,
        `You are Cipher, the autonomous dev agent for the ozzu project.`,
        `${timeStr}. ${lastSessionInfo}`,
        actionsSection,
        actionQueueSection,
        deltaSection,
        stateSection,
        directivesSection,
        epicSection,
        factsSection,
      ].filter(Boolean).join("\n");

      res.writeHead(200, { "Content-Type": "text/plain", ...CORS_HEADERS });
      res.end(markdown);
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /cipher/latest-session-ts — unix timestamp of most recent cipher session
  if (req.method === "GET" && pathname === "/cipher/latest-session-ts") {
    try {
      const result = await db.query(
        "SELECT EXTRACT(EPOCH FROM ended_at)::bigint AS ts FROM conversations WHERE persona = 'cipher' AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1"
      );
      const ts = result.rows[0]?.ts || 0;
      res.writeHead(200, { "Content-Type": "text/plain", ...CORS_HEADERS });
      res.end(String(ts));
    } catch {
      res.writeHead(200, { "Content-Type": "text/plain", ...CORS_HEADERS });
      res.end("0");
    }
    return true;
  }

  // GET /cipher/search?q=keyword — search actual conversation content
  if (req.method === "GET" && pathname === "/cipher/search") {
    try {
      const q = url.searchParams.get("q");
      const limitParam = parseInt(url.searchParams.get("limit")) || 30;
      const limit = Math.min(limitParam, 50);
      if (!q || q.trim().length < 2) {
        sendJSON(res, 400, { error: "q parameter required (min 2 chars)" });
        return;
      }
      if (!db.isConnected()) {
        sendJSON(res, 500, { error: "PostgreSQL not connected" });
        return;
      }

      // Search conversation turns using ILIKE for flexibility (full-text search can miss short phrases)
      const searchPattern = `%${q.trim()}%`;
      const results = await db.query(
        `SELECT ct.content, ct.role, ct.created_at, c.id as convo_id, c.persona, c.started_at as session_start
         FROM conversation_turns ct
         JOIN conversations c ON ct.conversation_id = c.id
         WHERE ct.content ILIKE $1
         ORDER BY ct.created_at DESC LIMIT $2`,
        [searchPattern, limit]
      );

      // Format as readable text
      let output = `# Search results for: "${q}"\n# Found: ${results.rows.length} matches\n\n`;
      for (const r of results.rows) {
        const date = new Date(r.created_at).toLocaleString();
        const role = r.role === "user" ? "King Kazuma" : (r.persona === "cipher" ? "Cipher" : "June");
        const content = r.content.length > 600 ? r.content.substring(0, 600) + "..." : r.content;
        output += `[${date}] [${role}] (session ${r.convo_id}):\n${content}\n---\n`;
      }

      res.writeHead(200, { "Content-Type": "text/plain", ...CORS_HEADERS });
      res.end(output);
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // POST /cipher/session-save — save CLI session transcript to conversation DB
  if (req.method === "POST" && pathname === "/cipher/session-save") {
    try {
      const body = await parseBody(req);
      const { sessionId, turns } = body;

      if (!Array.isArray(turns) || turns.length < 1) {
        sendJSON(res, 200, { success: false, reason: "skipped — no turns" });
        return;
      }

      // Summarize via Gemini Flash — cap transcript to avoid timeout
      let summary = null;
      if (GEMINI_API_KEY) {
        const fullTranscript = turns
          .map(t => `${t.role === "user" ? "King Kazuma" : "Cipher"}: ${t.content}`)
          .join("\n");
        const transcript = fullTranscript.length > 12000
          ? fullTranscript.substring(0, 4000) + "\n\n[... middle truncated ...]\n\n" + fullTranscript.substring(fullTranscript.length - 6000)
          : fullTranscript;
        try {
          const summaryController = new AbortController();
          const summaryTimeout = setTimeout(() => summaryController.abort(), 25000);
          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: summaryController.signal,
              body: JSON.stringify({
                contents: [{ parts: [{ text:
                  `Summarize this CLI conversation between Cipher (Claude Code dev agent) and King Kazuma (the user/architect) in 3-5 sentences. ` +
                  `Focus on: what was discussed, what decisions were made, what the user's preferences are, what was built or changed, and any unfinished work or issues. ` +
                  `Include specific details (feature names, file names, design choices) — not vague generalities. ` +
                  `This summary will be used to give Cipher persistent memory across sessions.\n\n${transcript}`
                }] }],
              }),
            }
          );
          clearTimeout(summaryTimeout);
          if (resp.ok) {
            const data = await resp.json();
            summary = data.candidates?.[0]?.content?.parts?.[0]?.text;
          } else {
            log.memory.error("Gemini summary request failed:", resp.status, resp.statusText);
          }
        } catch (err) {
          log.memory.error("Gemini summarization error:", err.message);
        }
      }

      if (!summary) {
        // Fallback: combine first user message + last user message for basic context
        const userTurns = turns.filter(t => t.role === "user");
        const first = userTurns[0]?.content?.substring(0, 150) || "no content";
        const last = userTurns.length > 1 ? userTurns[userTurns.length - 1]?.content?.substring(0, 150) : "";
        summary = `CLI session (${turns.length} turns): Started with: ${first}` + (last ? ` | Ended with: ${last}` : "");
      }

      // Extract structured facts via Gemini Flash (runs in parallel with DB save)
      let extractedFacts = [];
      let extractedTopics = [];
      if (GEMINI_API_KEY) {
        const factTranscript = turns
          .map(t => `${t.role === "user" ? "King Kazuma" : "Cipher"}: ${t.content}`)
          .join("\n");
        const factText = factTranscript.length > 12000
          ? factTranscript.substring(0, 5000) + "\n\n[... middle truncated ...]\n\n" + factTranscript.substring(factTranscript.length - 5000)
          : factTranscript;
        try {
          const factController = new AbortController();
          const factTimeout = setTimeout(() => factController.abort(), 25000);
          const factResp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: factController.signal,
              body: JSON.stringify({
                contents: [{ parts: [{ text:
                  `Extract key facts from this conversation as a JSON object with two fields:\n` +
                  `1. "facts": array of objects, each with:\n` +
                  `   - "fact": the specific detail (1 sentence)\n` +
                  `   - "category": one of "work_completed", "work_pending", "decision", "preference", "technical"\n` +
                  `2. "topics": array of 2-5 short topic tags (e.g. "SideStore", "iOS deploy", "memory system")\n\n` +
                  `Focus on: what was built/fixed, what's still pending, decisions made, user preferences, technical details that matter for future sessions.\n` +
                  `Return ONLY valid JSON, no markdown fences.\n\n${factText}`
                }] }],
              }),
            }
          );
          clearTimeout(factTimeout);
          if (factResp.ok) {
            const factData = await factResp.json();
            const rawText = factData.candidates?.[0]?.content?.parts?.[0]?.text || "";
            // Strip markdown fences if present
            const cleaned = rawText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
            try {
              const parsed = JSON.parse(cleaned);
              if (Array.isArray(parsed.facts)) extractedFacts = parsed.facts;
              else if (Array.isArray(parsed)) extractedFacts = parsed;
              if (Array.isArray(parsed.topics)) extractedTopics = parsed.topics;
            } catch (parseErr) {
              log.memory.error("Failed to parse Gemini fact extraction:", parseErr.message);
            }
          }
        } catch (err) {
          log.memory.error("Gemini fact extraction error:", err.message);
        }
      }

      // Store conversation with individual turns + summary
      if (db.isConnected()) {
        const convId = await db.createConversation("cipher");
        if (convId) {
          for (let i = 0; i < turns.length; i++) {
            const t = turns[i];
            await db.addConversationTurn(
              convId, t.role === "user" ? "user" : "cipher",
              t.content || "", i, null, "text",
              { source: "cli", sessionId }
            ).catch(() => {});
          }
          await db.endConversation(convId, summary, turns.length, extractedTopics).catch(() => {});

          // Store extracted facts as memories
          for (const f of extractedFacts) {
            if (f.fact && f.category) {
              const validCategories = ["work_completed", "work_pending", "decision", "preference", "technical"];
              const cat = validCategories.includes(f.category) ? f.category : "general";
              await db.addMemory("cipher", f.fact.substring(0, 500), cat, "session-extract").catch(() => {});
            }
          }
          if (extractedFacts.length > 0) {
            log.memory.info(`Extracted ${extractedFacts.length} facts from session, topics: [${extractedTopics.join(", ")}]`);
          }
        }
      }
      // Write-through to Redis
      if (ctx._redisConnected) {
        const entry = JSON.stringify({ summary, timestamp: Date.now(), turns: turns.length });
        await redis.lpush("cipher:summaries", entry);
        await redis.ltrim("cipher:summaries", 0, 19);
      }

      log.memory.info(`Cipher CLI session saved (${turns.length} turns, session: ${sessionId || "unknown"})`);
      sendJSON(res, 200, { success: true, summary });
    } catch (err) {
      log.memory.error("cipher session-save failed:", err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // POST /cipher/backfill-memories — one-time extraction of facts from all existing conversations
  if (req.method === "POST" && pathname === "/cipher/backfill-memories") {
    if (!GEMINI_API_KEY) {
      sendJSON(res, 500, { error: "GEMINI_API_KEY not set" });
      return;
    }
    if (!db.isConnected()) {
      sendJSON(res, 500, { error: "PostgreSQL not connected" });
      return;
    }
    // Run in background — respond immediately
    sendJSON(res, 200, { started: true, message: "Backfill started in background. Check logs for progress." });

    (async () => {
      try {
        // Skip conversations that already have topics (already processed)
        const allConvos = await db.query(
          `SELECT c.id, c.persona, c.summary, c.turn_count, c.started_at
           FROM conversations c
           WHERE c.turn_count > 4 AND (c.topics IS NULL OR c.topics = '{}')
           ORDER BY c.started_at ASC`
        );
        const convos = allConvos.rows;
        log.memory.info(`Backfill: ${convos.length} conversations to process (skipping already-processed)`);

        let totalFacts = 0;
        let processed = 0;
        let errors = 0;

        for (const convo of convos) {
          try {
            // Get turns for this conversation
            const turnsRes = await db.query(
              `SELECT role, content FROM conversation_turns
               WHERE conversation_id = $1 ORDER BY turn_index ASC LIMIT 60`,
              [convo.id]
            );
            if (turnsRes.rows.length < 4) { processed++; continue; }

            const transcript = turnsRes.rows
              .map(t => `${t.role === "user" ? "King Kazuma" : convo.persona === "cipher" ? "Cipher" : "June"}: ${t.content}`)
              .join("\n");
            const truncated = transcript.length > 10000
              ? transcript.substring(0, 4000) + "\n\n[... truncated ...]\n\n" + transcript.substring(transcript.length - 4000)
              : transcript;

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000);
            // Use flash-lite for backfill — higher rate limits than flash
            const resp = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: controller.signal,
                body: JSON.stringify({
                  contents: [{ parts: [{ text:
                    `Extract key facts from this conversation as a JSON object with two fields:\n` +
                    `1. "facts": array of objects, each with:\n` +
                    `   - "fact": the specific detail (1 sentence)\n` +
                    `   - "category": one of "work_completed", "work_pending", "decision", "preference", "technical"\n` +
                    `2. "topics": array of 2-5 short topic tags\n\n` +
                    `Focus on: what was built/fixed, what's still pending, decisions made, user preferences, technical details.\n` +
                    `Return ONLY valid JSON, no markdown fences.\n\n${truncated}`
                  }] }],
                }),
              }
            );
            clearTimeout(timeout);

            if (resp.ok) {
              const data = await resp.json();
              const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
              const cleaned = rawText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
              try {
                const parsed = JSON.parse(cleaned);
                const facts = Array.isArray(parsed.facts) ? parsed.facts : (Array.isArray(parsed) ? parsed : []);
                const topics = Array.isArray(parsed.topics) ? parsed.topics : [];
                const validCategories = ["work_completed", "work_pending", "decision", "preference", "technical"];

                for (const f of facts) {
                  if (f.fact && f.category) {
                    const cat = validCategories.includes(f.category) ? f.category : "general";
                    await db.addMemory(convo.persona || "cipher", f.fact.substring(0, 500), cat, "session-extract").catch(() => {});
                    totalFacts++;
                  }
                }
                // Update conversation topics
                if (topics.length > 0) {
                  await db.query(
                    `UPDATE conversations SET topics = $2 WHERE id = $1`,
                    [convo.id, topics]
                  ).catch(() => {});
                }
              } catch (parseErr) {
                errors++;
              }
            } else {
              errors++;
              if (resp.status === 429) {
                const errBody = await resp.text().catch(() => "");
                log.memory.info(`Backfill: rate limited (429), waiting 60s... ${errBody.substring(0, 500)}`);
                await new Promise(r => setTimeout(r, 60000));
              } else {
                const errBody = await resp.text().catch(() => "");
                log.memory.error(`Backfill: Gemini error ${resp.status}: ${errBody.substring(0, 200)}`);
              }
            }
          } catch (err) {
            errors++;
          }

          processed++;
          if (processed % 10 === 0) {
            log.memory.info(`Backfill progress: ${processed}/${convos.length} conversations, ${totalFacts} facts extracted, ${errors} errors`);
          }
          // Rate limit: 4 seconds between requests to stay under Gemini quota
          await new Promise(r => setTimeout(r, 4000));
        }

        log.memory.info(`Backfill complete: ${processed} conversations processed, ${totalFacts} facts extracted, ${errors} errors`);
      } catch (err) {
        log.memory.error("Backfill failed:", err.message);
      }
    })();
    return true;
  }

  // ── Real-time Cipher live sync (CLI ↔ Voice) ──

  // POST /cipher/live-push — CLI pushes a turn to the live context + notifies active voice session
  if (req.method === "POST" && pathname === "/cipher/live-push") {
    try {
      const body = await parseBody(req);
      const { source, role, content } = body;
      if (!content || !source) {
        sendJSON(res, 400, { error: "source and content required" });
        return;
      }
      const entry = { source: source || "cli", role: role || "user", content: content.substring(0, 2000), timestamp: Date.now() };
      // Store in Redis live feed
      if (ctx._redisConnected) {
        await redis.lpush("cipher:live:turns", JSON.stringify(entry));
        await redis.ltrim("cipher:live:turns", 0, 49); // keep last 50
        await redis.expire("cipher:live:turns", 7200); // 2 hour TTL
      }
      // If a voice session is active, inject a concise context update
      let voiceNotified = false;
      if (source === "cli" && role === "user" && (ctx.geminiReady || ctx.cipherPipeline)) {
        const shortContent = content.length > 300 ? content.substring(0, 300) + "..." : content;
        sendNotification(`[SYSTEM — CLI Context] King Kazuma just said to CLI-Cipher: "${shortContent}"`);
        voiceNotified = true;
      }
      sendJSON(res, 200, { ok: true, voiceNotified });
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /cipher/live-feed — CLI fetches recent voice/live turns for context injection
  if (req.method === "GET" && pathname === "/cipher/live-feed") {
    try {
      const since = parseInt(url.searchParams.get("since") || "0", 10);
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 50);
      const sourceFilter = url.searchParams.get("source"); // "voice" or "cli" or null (all)

      // Combine: in-memory voice transcript + Redis live turns (CLI pushes)
      let turns = [];

      // Voice transcript (in-memory, real-time)
      if (!sourceFilter || sourceFilter === "voice") {
        const voiceTurns = (ctx.conversationTranscript || [])
          .filter(t => t.timestamp && t.timestamp > since)
          .map(t => ({
            source: "voice",
            role: t.role === "model" ? ctx.currentPersona : "user",
            content: t.text,
            timestamp: t.timestamp,
          }));
        turns.push(...voiceTurns);
      }

      // Redis live turns (CLI pushes + voice pushes)
      if (ctx._redisConnected) {
        try {
          const raw = await redis.lrange("cipher:live:turns", 0, 49);
          for (const r of raw) {
            const entry = JSON.parse(r);
            if (entry.timestamp > since && (!sourceFilter || entry.source === sourceFilter)) {
              turns.push(entry);
            }
          }
        } catch (err) { /* Redis read failure — non-critical */ }
      }

      // Sort by timestamp, newest first, apply limit
      turns.sort((a, b) => b.timestamp - a.timestamp);
      turns = turns.slice(0, limit);

      // If requested as text format (for hook injection)
      const format = url.searchParams.get("format");
      if (format === "text") {
        if (turns.length === 0) {
          res.writeHead(200, { "Content-Type": "text/plain", ...CORS_HEADERS });
          res.end(""); // empty = no voice context
          return;
        }
        const lines = turns.reverse().map(t => {
          const ago = Math.round((Date.now() - t.timestamp) / 60000);
          const agoStr = ago < 1 ? "just now" : ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
          const who = t.role === "user" ? "King Kazuma" : "Cipher";
          const preview = t.content.length > 200 ? t.content.substring(0, 200) + "..." : t.content;
          return `[${agoStr}] ${who} (${t.source}): ${preview}`;
        });
        res.writeHead(200, { "Content-Type": "text/plain", ...CORS_HEADERS });
        res.end(lines.join("\n"));
        return;
      }

      sendJSON(res, 200, { turns, persona: ctx.currentPersona, voiceActive: !!(ctx.geminiReady || ctx.cipherPipeline) });
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // ── Volts memory endpoints ──

  // GET /volts/pulse — structured state for VOLTS.local.md (Layer 0)
  if (req.method === "GET" && pathname === "/volts/pulse") {
    try {
      const fs = require("fs");
      const ledgerPath = "/home/gcp/ozzu/.volts/ledger.json";
      let ledger = null;
      try { ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")); } catch {}

      // Merge ledger with live directive state
      const directives = getDirectives();
      const branch = (() => { try { return require("child_process").execSync("git -C /home/gcp/ozzu rev-parse --abbrev-ref HEAD 2>/dev/null", { encoding: "utf8" }).trim(); } catch { return ""; } })();
      const dirId = (branch.match(/dir_(\d{10,})/) || [])[0];
      let liveDirective = dirId ? directives.find(d => d.id === dirId) : null;

      const pulse = {
        identity: { agent: "volts", project: "ozzu", user: "King Kazuma" },
        directive: liveDirective ? {
          id: liveDirective.id,
          branch,
          title: liveDirective.title,
          status: liveDirective.status,
          workSummary: liveDirective.work_summary || (ledger?.directive?.workSummary),
          workingState: liveDirective.working_state || (ledger?.directive?.workingState),
          handoffContext: liveDirective.handoff_context || (ledger?.directive?.handoffContext),
        } : (ledger?.directive || null),
        workingMemory: {
          lastInstruction: ledger?.recentInstructions?.slice(-1)[0]?.content || null,
          recentInstructions: ledger?.recentInstructions || [],
          recentDecisions: ledger?.recentDecisions || [],
        },
        attention: directives.filter(d => ["blocked", "deploy_failed", "failed"].includes(d.status)).map(d => ({
          id: d.id, title: d.title, status: d.status, reason: d.failureReason
        })),
        failures: ledger?.failedApproaches || [],
        session: {
          ledgerUpdatedAt: ledger?.updatedAt || 0,
          sessionHistory: ledger?.sessionHistory || [],
        },
      };
      sendJSON(res, 200, pulse);
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // POST /volts/checkpoint — manually trigger a ledger checkpoint
  if (req.method === "POST" && pathname === "/volts/checkpoint") {
    try {
      const { execSync } = require("child_process");
      execSync("/home/gcp/ozzu/scripts/volts-checkpoint.sh", { timeout: 10000, encoding: "utf8" });
      sendJSON(res, 200, { ok: true });
    } catch (err) {
      sendJSON(res, 200, { ok: false, error: err.message });
    }
    return true;
  }

  // GET /volts/recall?topic=keyword — search archive for a topic
  if (req.method === "GET" && pathname === "/volts/recall") {
    try {
      const topic = url.searchParams.get("topic") || url.searchParams.get("q");
      if (!topic || topic.length < 2) {
        sendJSON(res, 400, { error: "topic parameter required (min 2 chars)" });
        return true;
      }
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "10"), 30);

      // Search high-importance turns first, then all
      const results = await db.query(
        `SELECT ct.content, ct.role, ct.importance, ct.created_at, c.id as convo_id
         FROM conversation_turns ct
         JOIN conversations c ON ct.conversation_id = c.id
         WHERE ct.content ILIKE $1
         ORDER BY ct.importance DESC NULLS LAST, ct.created_at DESC
         LIMIT $2`,
        [`%${topic.trim()}%`, limit]
      );

      const turns = results.rows.map(r => ({
        role: r.role,
        content: r.content.substring(0, 500),
        importance: r.importance || 1,
        date: r.created_at,
        sessionId: r.convo_id,
      }));
      sendJSON(res, 200, { topic, count: turns.length, turns });
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // ── Cipher Daemon endpoints ──

  if (req.method === "GET" && pathname === "/cipher/daemon/status") {
    const daemon = ctx.cipherDaemon;
    if (!daemon) return sendJSON(res, 500, { error: "daemon not loaded" }), true;
    sendJSON(res, 200, daemon.getStatus());
    return true;
  }

  if (req.method === "POST" && pathname === "/cipher/daemon/pause") {
    const daemon = ctx.cipherDaemon;
    if (!daemon) return sendJSON(res, 500, { error: "daemon not loaded" }), true;
    daemon.pause();
    sendJSON(res, 200, { ok: true, message: "Daemon paused" });
    return true;
  }

  if (req.method === "POST" && pathname === "/cipher/daemon/resume") {
    const daemon = ctx.cipherDaemon;
    if (!daemon) return sendJSON(res, 500, { error: "daemon not loaded" }), true;
    daemon.resume();
    sendJSON(res, 200, { ok: true, message: "Daemon resumed" });
    return true;
  }

  if (req.method === "GET" && pathname === "/cipher/daemon/history") {
    const daemon = ctx.cipherDaemon;
    if (!daemon) return sendJSON(res, 500, { error: "daemon not loaded" }), true;
    const limit = parseInt(url.searchParams.get("limit") || "20", 10);
    const history = await daemon.getHistory(Math.min(limit, 100));
    sendJSON(res, 200, { runs: history });
    return true;
  }

  if (req.method === "POST" && pathname === "/cipher/daemon/work-queue") {
    const daemon = ctx.cipherDaemon;
    if (!daemon?.setWorkQueue) return sendJSON(res, 500, { error: "agent not loaded" }), true;
    try {
      const body = await parseBody(req);
      daemon.setWorkQueue(body.enabled !== false);
      sendJSON(res, 200, { ok: true, enabled: body.enabled !== false });
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // ── Action Queue endpoints ──

  if (req.method === "POST" && pathname === "/cipher/actions/push") {
    if (!actionQueue) return sendJSON(res, 500, { error: "action queue not loaded" }), true;
    try {
      const body = await parseBody(req);
      if (!body.message) return sendJSON(res, 400, { error: "message required" }), true;
      const result = await actionQueue.push({
        type: body.type || "manual",
        message: body.message,
        priority: body.priority || "normal",
        dedupKey: body.dedupKey,
        metadata: body.metadata,
        ttlMs: body.ttlMs,
      });
      sendJSON(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/cipher/actions/pull") {
    if (!actionQueue) return sendJSON(res, 500, { error: "action queue not loaded" }), true;
    try {
      const limit = parseInt(url.searchParams.get("limit") || "20", 10);
      const includeAcked = url.searchParams.get("all") === "true";
      const actions = await actionQueue.pull({ limit: Math.min(limit, 50), includeAcked });
      sendJSON(res, 200, { actions, count: actions.length });
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/cipher/actions/ack") {
    if (!actionQueue) return sendJSON(res, 500, { error: "action queue not loaded" }), true;
    try {
      const body = await parseBody(req);
      if (body.all) {
        const count = await actionQueue.ackAll();
        sendJSON(res, 200, { ok: true, acknowledged: count });
      } else if (body.id) {
        const found = await actionQueue.ack(body.id);
        sendJSON(res, 200, { ok: found, id: body.id });
      } else {
        sendJSON(res, 400, { error: "id or all:true required" });
      }
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  if (req.method === "DELETE" && pathname.startsWith("/cipher/actions/")) {
    if (!actionQueue) return sendJSON(res, 500, { error: "action queue not loaded" }), true;
    const actionId = decodeURIComponent(pathname.replace("/cipher/actions/", ""));
    if (!actionId) return sendJSON(res, 400, { error: "action id required" }), true;
    const removed = await actionQueue.remove(actionId);
    sendJSON(res, 200, { ok: removed });
    return true;
  }

  // ── Proactive Reporter endpoints ──

  if (req.method === "GET" && pathname === "/cipher/reporter/status") {
    if (!proactiveReporter) return sendJSON(res, 500, { error: "reporter not loaded" }), true;
    sendJSON(res, 200, proactiveReporter.getStatus());
    return true;
  }

  if (req.method === "POST" && pathname === "/cipher/reporter/trigger") {
    if (!proactiveReporter) return sendJSON(res, 500, { error: "reporter not loaded" }), true;
    await proactiveReporter.forceDailySummary();
    sendJSON(res, 200, { ok: true, message: "Summary delivered" });
    return true;
  }

    return false;
  };
};
