// routes/cipher.js — Cipher context, history, session-save, live-push (extracted from server.js)

module.exports = function createCipherRoutes(ctx) {
  const { db, log, sendJSON, parseBody, CORS_HEADERS, GEMINI_API_KEY,
          getDirectives, getEpicProgress, buildSituationBriefing,
          redis, isRedisConnected,
          getConversationTranscript, getCurrentPersona, isVoiceActive,
          sendNotification } = ctx;

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

  // GET /cipher/context — assemble full Cipher context for CLAUDE.local.md
  if (req.method === "GET" && pathname === "/cipher/context") {
    try {
      const briefing = await buildSituationBriefing("cipher");

      // Recent pipeline activity
      const directives = getDirectives();
      const recentFinished = directives
        .filter(d => ["completed", "failed", "deploy_failed", "blocked"].includes(d.status))
        .sort((a, b) => (b.endedAt || b.createdAt || 0) - (a.endedAt || a.createdAt || 0))
        .slice(0, 5);
      let pipelineSection = "";
      if (recentFinished.length > 0) {
        pipelineSection = "\n## Recent Pipeline Activity\n" +
          recentFinished.map(d => {
            const date = d.endedAt ? new Date(d.endedAt).toLocaleDateString() : "unknown";
            return `- [${d.status}] ${d.title} (${date})`;
          }).join("\n");
      }

      // ── FULL CONVERSATION HISTORY FROM POSTGRES ──
      // Load complete conversation turns (both King Kazuma AND Cipher) from postgres.
      // This is the source of truth — includes everything said by both sides.
      let conversationMemory = "";
      try {
        if (db.isConnected()) {
          // Get the last 10 cipher sessions with their full turns
          const sessions = await db.query(
            `SELECT c.id, c.started_at, c.ended_at, c.summary, c.turn_count
             FROM conversations c
             WHERE c.persona = 'cipher' AND c.turn_count >= 2
             ORDER BY c.started_at DESC LIMIT 10`
          );

          const parts = [];
          let totalChars = 0;
          const MAX_CHARS = 80000; // ~80K chars of context — enough for several full sessions

          for (const session of sessions.rows) {
            if (totalChars >= MAX_CHARS) break;

            const turns = await db.query(
              `SELECT role, content, content_type, created_at
               FROM conversation_turns
               WHERE conversation_id = $1
               ORDER BY turn_index ASC`,
              [session.id]
            );

            if (turns.rows.length < 2) continue;

            const startDate = session.started_at ? new Date(session.started_at).toLocaleString() : "?";
            const duration = session.ended_at && session.started_at
              ? Math.round((new Date(session.ended_at) - new Date(session.started_at)) / 60000)
              : "?";
            let section = `### Session ${session.id} (${startDate} — ${duration} min, ${turns.rows.length} turns)\n`;
            if (session.summary && session.summary !== "Session ended (auto-closed)") {
              section += `Summary: ${session.summary}\n`;
            }
            section += "\n";

            for (const turn of turns.rows) {
              if (totalChars >= MAX_CHARS) break;
              const role = turn.role === "user" ? "King Kazuma" : "Cipher";
              const contentType = turn.content_type;

              if (contentType === "tool_call" || contentType === "tool_result") {
                // Show tool calls/results abbreviated
                const abbreviated = turn.content.length > 200
                  ? turn.content.substring(0, 200) + "..."
                  : turn.content;
                section += `[${contentType}] ${abbreviated}\n`;
                totalChars += abbreviated.length;
              } else if (contentType === "upload") {
                section += `[${role}] [upload: ${turn.content}]\n`;
                totalChars += turn.content.length;
              } else {
                // Full content for user and cipher messages — cap individual messages at 2000 chars
                const content = turn.content.length > 2000
                  ? turn.content.substring(0, 2000) + "..."
                  : turn.content;
                section += `[${role}] ${content}\n`;
                totalChars += content.length;
              }
              section += "\n";
            }

            parts.push(section);
          }

          if (parts.length > 0) {
            conversationMemory = "\n## Full Conversation History (last sessions — both sides)\n" +
              "This is the COMPLETE conversation record from postgres. Both King Kazuma's messages AND Cipher's responses.\n" +
              "When King Kazuma says 'read the conversation' — THIS is the conversation. It's already here.\n\n" +
              parts.join("\n");
          }
        }
      } catch (err) {
        // noop — fall through to JSONL fallback
      }

      // Fallback: if postgres didn't return anything, read from JSONL files
      if (!conversationMemory) {
        try {
          const fs = require("fs");
          const path = require("path");
          const sessionDirs = [
            path.join(process.env.HOME || "/root", ".claude/projects/-home-gcp-ozzu"),
            path.join(process.env.HOME || "/root", ".claude/projects/-home-gcp-ozzu-scripts"),
          ];

          let allFiles = [];
          for (const dir of sessionDirs) {
            try {
              const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
              for (const f of files) {
                const fp = path.join(dir, f);
                try {
                  const stat = fs.statSync(fp);
                  if (stat.size > 500) allFiles.push({ path: fp, mtime: stat.mtimeMs, name: f });
                } catch {}
              }
            } catch {}
          }

          allFiles.sort((a, b) => b.mtime - a.mtime);
          allFiles = allFiles.slice(0, 20);

          const parts = [];
          let totalMsgs = 0;
          const MAX_MSGS = 200;

          for (const file of allFiles) {
            if (totalMsgs >= MAX_MSGS) break;
            try {
              const lines = fs.readFileSync(file.path, "utf8").split("\n").filter(Boolean);
              const userMsgs = [];
              let sessionId = "";
              for (const line of lines) {
                try {
                  const entry = JSON.parse(line);
                  if (entry.type === "user" && entry.message?.role === "user") {
                    const content = entry.message.content;
                    if (typeof content === "string" && content.length > 5) {
                      userMsgs.push({ content, ts: entry.timestamp || "" });
                      if (!sessionId) sessionId = entry.sessionId || "";
                    }
                  }
                } catch {}
              }
              if (userMsgs.length < 2) continue;

              const firstTs = userMsgs[0]?.ts;
              const dateStr = firstTs ? new Date(firstTs).toLocaleString() : "?";
              const sid = sessionId ? sessionId.substring(0, 8) : file.name.substring(0, 8);
              let section = `### Session ${sid} (${dateStr})\n`;
              for (const msg of userMsgs) {
                if (totalMsgs >= MAX_MSGS) break;
                const truncated = msg.content.length > 500 ? msg.content.substring(0, 500) + "..." : msg.content;
                section += `> ${truncated}\n\n`;
                totalMsgs++;
              }
              parts.push(section);
            } catch {}
          }

          if (parts.length > 0) {
            conversationMemory = "\n## Recent Conversations (raw — last 200 messages from King Kazuma)\n" +
              "This is your actual memory. These are the real words King Kazuma said to you.\n\n" +
              parts.join("\n");
          }
        } catch (err) {
          conversationMemory = "\n## Recent Conversations\n_Could not load conversation history._";
        }
      }

      // Older conversations: Gemini summaries for anything beyond the raw turns
      let olderSummaries = "";
      try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
        const summaries = await db.query(
          `SELECT id, summary, turn_count, started_at
           FROM conversations
           WHERE persona = 'cipher' AND summary IS NOT NULL
             AND started_at < (
               SELECT MIN(ct.created_at) FROM conversation_turns ct
               JOIN conversations c ON ct.conversation_id = c.id
               WHERE c.persona = 'cipher' AND ct.role = 'user'
               ORDER BY ct.created_at DESC LIMIT 1 OFFSET 199
             )
           ORDER BY started_at DESC LIMIT 20`
        );
        if (summaries.rows.length > 0) {
          olderSummaries = "\n## Older Sessions (summaries)\n" +
            summaries.rows.map(s => {
              const date = new Date(s.started_at).toLocaleDateString();
              return `- [${date}] ${s.summary}`;
            }).join("\n");
        }
      } catch (err) { /* older summaries are nice-to-have */ }

      // ── Active Epics (directive-based) ──
      let epicSection = "";
      const epicDirectives = directives.filter(d => d.type === "epic" && !["completed", "cancelled"].includes(d.status));
      if (epicDirectives.length > 0) {
        epicSection = "\n## Active Epics (multi-phase projects)\n" +
          "These are ongoing projects with multiple phases. Pick up where you left off.\n\n";
        for (const epic of epicDirectives) {
          const phases = directives
            .filter(d => d.epicId === epic.id)
            .sort((a, b) => (a.phaseOrder || 0) - (b.phaseOrder || 0));
          const progress = getEpicProgress(epic.id);
          epicSection += `### ${epic.emoji || "📦"} Epic: "${epic.title}" (${epic.id})\n`;
          epicSection += `Progress: ${progress.completed}/${progress.total} phases completed\n`;
          for (const phase of phases) {
            const statusIcon = phase.status === "completed" ? "✅" :
              ["in_progress", "planning", "planned", "approved"].includes(phase.status) ? "🔨" :
              phase.status === "pending" ? "⏳" :
              phase.status === "blocked" ? "🛑" : "❓";
            const marker = ["in_progress", "planning", "planned", "approved"].includes(phase.status) ? " ← YOU ARE HERE" : "";
            epicSection += `- [${phase.status}] Phase ${phase.phaseOrder || "?"}: ${phase.title}${marker}\n`;
          }
          if (progress.currentPhase) {
            const currentDir = directives.find(d => d.id === progress.currentPhase.id);
            if (currentDir && currentDir.plan) {
              const planSnippet = currentDir.plan.length > 500 ? currentDir.plan.substring(0, 500) + "..." : currentDir.plan;
              epicSection += `\nCurrent phase plan:\n${planSnippet}\n`;
            }
          } else if (progress.nextPhase) {
            epicSection += `\n**→ NEXT: ${progress.nextPhase.title}** — start by creating a directive with epicId: "${epic.id}"\n`;
          }
          epicSection += "\n";
        }
      }

      // Critical reminders (hardcoded — these are non-negotiable project rules)
      const criticalSection = "\n## Critical Reminders\n" +
        "- NEVER build web dashboards or websites — Ozzu is a React Native app, ALL UI lives in frontend/\n" +
        "- NEVER bypass the directive pipeline\n" +
        "- iPhone NEVER receives OTA updates — always requires native build + sideload\n" +
        "- When King Kazuma says 'dashboard' he means the React Native app UI, NOT the bridge web page\n" +
        "- After completing a directive phase, check if the parent epic has more pending phases — do NOT stop if there's more work\n" +
        "- Use GET /cipher/search?q=keyword to search older conversation history if you need context beyond what's loaded here";

      const timestamp = new Date().toISOString();
      const markdown = [
        `# Cipher Context — Auto-generated (do not edit)`,
        `# Generated: ${timestamp}`,
        ``,
        `## You are Cipher`,
        `You are Cipher, the autonomous dev agent for the ozzu project. You are NOT a generic Claude Code assistant.`,
        `You have persistent memory and ongoing context from past sessions with King Kazuma.`,
        ``,
        `## Situation Briefing`,
        briefing.trim(),
        epicSection,
        pipelineSection,
        conversationMemory,
        olderSummaries,
        criticalSection,
      ].join("\n");

      res.writeHead(200, { "Content-Type": "text/plain", ...CORS_HEADERS });
      res.end(markdown);
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
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

    return false;
  };
};
