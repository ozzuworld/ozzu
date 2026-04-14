// routes/whatsapp.js — WhatsApp REST API
// Wraps wa-service.js singleton with HTTP endpoints
// All incoming messages are persisted to postgres — phone is pure transport.

"use strict";

// WhatsApp MCP returns Python repr strings — convert to JSON-parseable objects
function parsePythonRepr(text) {
  if (!text || text === "[]") return [];
  try {
    // Replace Python-specific syntax with JSON equivalents
    const jsonStr = text
      .replace(/\bNone\b/g, "null")
      .replace(/\bTrue\b/g, "true")
      .replace(/\bFalse\b/g, "false")
      .replace(/'/g, '"')
      // Handle Contact(...) wrapper objects from list_all_contacts
      .replace(/Contact\(([^)]+)\)/g, (_, inner) => {
        const obj = {};
        const pairs = inner.match(/(\w+)=("(?:[^"\\]|\\.)*"|null|true|false|\d+)/g) || [];
        return "{" + pairs.map(p => {
          const eq = p.indexOf("=");
          return '"' + p.slice(0, eq) + '":' + p.slice(eq + 1);
        }).join(",") + "}";
      });
    return JSON.parse(jsonStr);
  } catch {
    // Fallback: try eval-style parsing for complex structures
    try {
      const cleaned = text
        .replace(/\bNone\b/g, "null")
        .replace(/\bTrue\b/g, "true")
        .replace(/\bFalse\b/g, "false")
        .replace(/'/g, '"')
        .replace(/Contact\([^)]*\)/g, "{}");
      return JSON.parse(cleaned);
    } catch { return []; }
  }
}

async function ensureTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      text TEXT,
      wa_id TEXT,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_wa_messages_phone ON whatsapp_messages(phone)`);
  // Add wa_id column if table was created before this migration
  await db.query(`ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS wa_id TEXT`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_wa_id ON whatsapp_messages(wa_id) WHERE wa_id IS NOT NULL`);
}

let _tableReady = false;
async function getTable(db) {
  if (!_tableReady) { await ensureTable(db); _tableReady = true; }
}

module.exports = function whatsappRoutes(ctx) {
  const { sendJSON, parseBody, db } = ctx;

  let wa;
  function getWa() {
    if (!wa) wa = require("../wa-service");
    return wa;
  }

  return async function handle(req, res, pathname) {
    if (!pathname.startsWith("/whatsapp")) return false;

    // GET /whatsapp/status
    if (req.method === "GET" && pathname === "/whatsapp/status") {
      sendJSON(res, 200, getWa().status());
      return true;
    }

    // GET /whatsapp/qr
    if (req.method === "GET" && pathname === "/whatsapp/qr") {
      const qr = getWa().qr();
      if (!qr) {
        const s = getWa().status();
        if (s.status === "connected") {
          sendJSON(res, 200, { connected: true, message: "Already connected, no QR needed." });
        } else {
          sendJSON(res, 503, { error: "QR not ready yet. WhatsApp is connecting..." });
        }
      } else {
        sendJSON(res, 200, { qr });
      }
      return true;
    }

    // GET /whatsapp/chats — proxy list_chats from WhatsApp MCP
    if (req.method === "GET" && pathname === "/whatsapp/chats") {
      try {
        const { getUpstream } = require("../mcp-proxy");
        const upstream = getUpstream("whatsapp-mcp");
        if (!upstream) { sendJSON(res, 503, { error: "WhatsApp MCP not configured" }); return true; }

        const url = new URL(req.url, "http://localhost");
        const limit = parseInt(url.searchParams.get("limit") || "50");

        const result = await upstream.forward({
          jsonrpc: "2.0", id: Date.now(),
          method: "tools/call",
          params: { name: "list_chats", arguments: { limit, include_last_message: true, sort_by: "last_message" } },
        });

        // Parse the Python repr string from MCP response
        const text = result?.result?.content?.[0]?.text || "[]";
        let chats;
        try { chats = JSON.parse(text); } catch {
          // MCP returns Python repr — convert to JSON
          chats = parsePythonRepr(text);
        }

        // Enrich with contact names
        let contactMap = {};
        try {
          const cResult = await upstream.forward({
            jsonrpc: "2.0", id: Date.now() + 1,
            method: "tools/call",
            params: { name: "list_all_contacts", arguments: { limit: 500 } },
          });
          const cText = cResult?.result?.content?.[0]?.text || "[]";
          const contacts = parsePythonRepr(cText);
          for (const c of contacts) {
            if (c.jid) contactMap[c.jid] = c.name || c.push_name || c.business_name || null;
            // Also map base JID without :suffix for @lid contacts
            const baseJid = c.jid?.split(":")[0];
            if (baseJid && c.jid !== baseJid) {
              const domain = c.jid.includes("@") ? "@" + c.jid.split("@")[1] : "";
              contactMap[baseJid + domain] = c.name || c.push_name || c.business_name || null;
            }
          }
        } catch {}

        // Filter junk, enrich with names, sort by most recent
        const filtered = chats
          .filter(c => c.jid && c.jid !== "status@broadcast" && !c.jid.includes("@newsletter") && c.jid !== "0@s.whatsapp.net")
          .map(c => ({
            ...c,
            display_name: contactMap[c.jid] || c.name || c.jid?.split("@")[0] || "Unknown",
          }))
          .sort((a, b) => new Date(b.last_message_time).getTime() - new Date(a.last_message_time).getTime());

        sendJSON(res, 200, { chats: filtered, count: filtered.length });
      } catch (err) {
        sendJSON(res, 503, { error: err.message });
      }
      return true;
    }

    // GET /whatsapp/chats/:jid/messages — proxy list_messages from WhatsApp MCP
    if (req.method === "GET" && pathname.match(/^\/whatsapp\/chats\/[^/]+\/messages$/)) {
      try {
        const jid = decodeURIComponent(pathname.split("/")[3]);
        const { getUpstream } = require("../mcp-proxy");
        const upstream = getUpstream("whatsapp-mcp");
        if (!upstream) { sendJSON(res, 503, { error: "WhatsApp MCP not configured" }); return true; }

        const url = new URL(req.url, "http://localhost");
        const limit = parseInt(url.searchParams.get("limit") || "50");
        const before = url.searchParams.get("before") || undefined;

        const args = { chat_jid: jid, limit };
        if (before) args.before = before;

        const result = await upstream.forward({
          jsonrpc: "2.0", id: Date.now(),
          method: "tools/call",
          params: { name: "list_messages", arguments: args },
        });

        const text = result?.result?.content?.[0]?.text || "[]";
        let messages;
        try { messages = JSON.parse(text); } catch {
          messages = parsePythonRepr(text);
        }

        sendJSON(res, 200, { jid, messages, count: messages.length });
      } catch (err) {
        sendJSON(res, 503, { error: err.message });
      }
      return true;
    }

    // GET /whatsapp/messages/:phone — reads from DB
    if (req.method === "GET" && pathname.startsWith("/whatsapp/messages/")) {
      const phone = pathname.replace("/whatsapp/messages/", "").replace(/\D/g, "");
      if (!phone) { sendJSON(res, 400, { error: "phone required" }); return true; }
      const url = new URL(req.url, "http://localhost");
      const limit = parseInt(url.searchParams.get("limit") || "50");
      await getTable(db);
      const result = await db.query(
        "SELECT direction, text, received_at FROM whatsapp_messages WHERE phone = $1 ORDER BY received_at DESC LIMIT $2",
        [phone, limit]
      );
      const messages = result.rows.reverse();
      sendJSON(res, 200, { phone, messages, count: messages.length });
      return true;
    }

    // POST /whatsapp/send
    if (req.method === "POST" && pathname === "/whatsapp/send") {
      const body = await parseBody(req);
      const { to, message } = body;
      if (!to || !message) { sendJSON(res, 400, { error: "to and message required" }); return true; }
      try {
        const result = await getWa().send(to, message);
        // Persist outgoing message
        const phone = String(to).replace(/\D/g, "");
        await getTable(db);
        await db.query(
          "INSERT INTO whatsapp_messages (phone, direction, text) VALUES ($1, 'out', $2)",
          [phone, message]
        );
        sendJSON(res, 200, result);
      } catch (err) {
        sendJSON(res, 503, { error: err.message });
      }
      return true;
    }

    // POST /whatsapp/pause
    if (req.method === "POST" && pathname === "/whatsapp/pause") {
      const body = await parseBody(req);
      const { phone } = body;
      if (!phone) { sendJSON(res, 400, { error: "phone required" }); return true; }
      getWa().pause(phone);
      sendJSON(res, 200, { ok: true, phone: getWa().normalizePhone(phone), paused: true });
      return true;
    }

    // POST /whatsapp/resume
    if (req.method === "POST" && pathname === "/whatsapp/resume") {
      const body = await parseBody(req);
      const { phone } = body;
      if (!phone) { sendJSON(res, 400, { error: "phone required" }); return true; }
      getWa().resume(phone);
      sendJSON(res, 200, { ok: true, phone: getWa().normalizePhone(phone), paused: false });
      return true;
    }

    // POST /whatsapp/notify-human
    if (req.method === "POST" && pathname === "/whatsapp/notify-human") {
      const body = await parseBody(req);
      const { phone, reason, preview } = body;
      if (!phone) { sendJSON(res, 400, { error: "phone required" }); return true; }
      getWa().pause(phone);
      const result = await getWa().notifyHuman(phone, reason || "Manual takeover requested", preview);
      sendJSON(res, 200, { ok: true, push: result });
      return true;
    }

    // POST /whatsapp/incoming — Android WA agent calls this on every message (in or out)
    // Persists to DB + sends push notification for incoming
    if (req.method === "POST" && pathname === "/whatsapp/incoming") {
      const body = await parseBody(req);
      const { from, text, ts, id: waId, direction: dir } = body;
      if (!from) { sendJSON(res, 400, { error: "from required" }); return true; }

      const phone = String(from).replace(/\D/g, "");
      const msgText = text || "";
      const direction = dir === "out" ? "out" : "in";

      try {
        await getTable(db);
        if (waId) {
          await db.query(
            "INSERT INTO whatsapp_messages (phone, direction, text, wa_id, received_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (wa_id) DO NOTHING",
            [phone, direction, msgText, waId, ts ? new Date(ts) : new Date()]
          );
        } else {
          await db.query(
            "INSERT INTO whatsapp_messages (phone, direction, text, received_at) VALUES ($1, $2, $3, $4)",
            [phone, direction, msgText, ts ? new Date(ts) : new Date()]
          );
        }
      } catch (err) {}

      // Push only for incoming
      if (direction === "in") {
        try {
          const { sendPush } = require("../push-notifications");
          const result = await db.query("SELECT token FROM device_push_tokens WHERE platform = 'ios' ORDER BY updated_at DESC LIMIT 5");
          const tokens = result.rows.map(r => r.token);
          if (tokens.length > 0) {
            const preview = msgText.length > 80 ? msgText.slice(0, 80) + "…" : msgText || "(media)";
            await sendPush(tokens, {
              title: `📲 WhatsApp — +${phone}`,
              body: preview,
              data: { type: "whatsapp_incoming", phone, text: msgText },
            });
          }
        } catch (err) {}
      }

      sendJSON(res, 200, { ok: true });
      return true;
    }

    // POST /whatsapp/history — bulk insert from history sync (syncFullHistory)
    if (req.method === "POST" && pathname === "/whatsapp/history") {
      const body = await parseBody(req);
      const { messages: msgs } = body;
      if (!Array.isArray(msgs)) { sendJSON(res, 400, { error: "messages array required" }); return true; }
      await getTable(db);
      let saved = 0;
      for (const m of msgs) {
        const phone = String(m.phone || "").replace(/\D/g, "");
        const direction = m.direction === "out" ? "out" : "in";
        const text = m.text || "";
        const waId = m.id || null;
        const ts = m.ts ? new Date(m.ts) : new Date();
        try {
          if (waId) {
            const r = await db.query(
              "INSERT INTO whatsapp_messages (phone, direction, text, wa_id, received_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (wa_id) DO NOTHING",
              [phone, direction, text, waId, ts]
            );
            if (r.rowCount > 0) saved++;
          } else {
            await db.query(
              "INSERT INTO whatsapp_messages (phone, direction, text, received_at) VALUES ($1, $2, $3, $4)",
              [phone, direction, text, ts]
            );
            saved++;
          }
        } catch (err) {}
      }
      console.log(`[whatsapp/history] Saved ${saved}/${msgs.length} messages`);
      sendJSON(res, 200, { ok: true, saved, total: msgs.length });
      return true;
    }

    return false;
  };
};
