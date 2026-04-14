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

// Format phone number for display: +57 323 254 0576
function formatPhone(num) {
  if (!num) return null;
  const digits = String(num).replace(/\D/g, "");
  if (!digits || digits.length < 7) return num;
  // Colombian numbers: 57 + 10 digits
  if (digits.startsWith("57") && digits.length === 12) {
    return `+57 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  // Indian numbers: 91 + 10 digits
  if (digits.startsWith("91") && digits.length === 12) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  // US/Canada: 1 + 10 digits
  if (digits.startsWith("1") && digits.length === 11) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  // Generic: +CC rest
  return `+${digits.slice(0, 2)} ${digits.slice(2)}`;
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

// Module-level caches for profile pics (survive across requests)
const _picCache = {};     // jid → url
const _picFailed = new Set(); // jids that returned no pic

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
    // Enriches with contact names, phone numbers, and profile picture URLs
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

        const text = result?.result?.content?.[0]?.text || "[]";
        let chats;
        try { chats = JSON.parse(text); } catch { chats = parsePythonRepr(text); }

        // Build rich contact map: jid → { name, phone }
        const contactByJid = {};  // jid → { name, phone }
        const contactByName = {}; // name → { phone_jid }  (for LID→phone cross-ref)
        try {
          const cResult = await upstream.forward({
            jsonrpc: "2.0", id: Date.now() + 1,
            method: "tools/call",
            params: { name: "list_all_contacts", arguments: { limit: 500 } },
          });
          const cText = cResult?.result?.content?.[0]?.text || "[]";
          const contacts = parsePythonRepr(cText);

          // First pass: index all contacts
          for (const c of contacts) {
            if (!c.jid) continue;
            const name = c.name || c.push_name || c.business_name || null;
            const isPhone = c.jid.includes("@s.whatsapp.net");
            // Only real @s.whatsapp.net JIDs have phone numbers — LID numbers are NOT phones
            const phone = isPhone ? c.jid.split("@")[0] : null;

            contactByJid[c.jid] = { name, phone };
            // Map base JID without :suffix for @lid contacts
            const baseJid = c.jid.split(":")[0];
            if (c.jid !== baseJid) {
              const domain = c.jid.includes("@") ? "@" + c.jid.split("@")[1] : "";
              if (!contactByJid[baseJid + domain]) contactByJid[baseJid + domain] = { name, phone };
            }

            // Build name→phone mapping for cross-referencing LID contacts
            if (name && isPhone) {
              contactByName[name] = { phone, jid: c.jid };
            }
          }

          // Second pass: cross-reference LID contacts with their phone JID counterparts
          for (const jid of Object.keys(contactByJid)) {
            const entry = contactByJid[jid];
            if (jid.includes("@lid") && entry.name && !entry.phone) {
              const phoneEntry = contactByName[entry.name];
              if (phoneEntry) entry.phone = phoneEntry.phone;
            }
          }
        } catch {}

        // Fetch profile pictures sequentially (SSE transport is single-connection)
        // Cache in module scope so subsequent requests are instant
        const jidsNeedingPics = chats
          .filter(c => c.jid && c.jid !== "status@broadcast" && !c.jid.includes("@newsletter") && c.jid !== "0@s.whatsapp.net")
          .map(c => c.jid)
          .filter(jid => !_picCache[jid] && !_picFailed.has(jid))
          .slice(0, 10);

        for (const jid of jidsNeedingPics) {
          try {
            const r = await upstream.forward({
              jsonrpc: "2.0", id: Date.now() + Math.random() * 10000 | 0,
              method: "tools/call",
              params: { name: "get_profile_picture", arguments: { jid, preview: true } },
            });
            const t = r?.result?.content?.[0]?.text || "";
            const parsed = parsePythonRepr(t.startsWith("{") ? "[" + t + "]" : t);
            const pic = Array.isArray(parsed) ? parsed[0] : parsed;
            if (pic?.url && pic?.has_picture) {
              _picCache[jid] = pic.url;
            } else {
              _picFailed.add(jid);
            }
          } catch { _picFailed.add(jid); }
        }

        // Filter, enrich, sort
        const filtered = chats
          .filter(c => c.jid && c.jid !== "status@broadcast" && !c.jid.includes("@newsletter") && c.jid !== "0@s.whatsapp.net")
          .map(c => {
            const contact = contactByJid[c.jid] || {};
            const name = contact.name || c.name || null;
            const phone = contact.phone || null;
            // Format display name: prefer name, fall back to formatted phone
            let display_name = name;
            if (!display_name && phone) {
              display_name = formatPhone(phone);
            }
            if (!display_name) {
              // Last resort: format the JID number itself
              const jidNum = c.jid.split("@")[0];
              display_name = jidNum.length > 10 ? jidNum : c.jid;
            }

            return {
              ...c,
              display_name,
              phone: phone ? formatPhone(phone) : null,
              avatar_url: _picCache[c.jid] || null,
            };
          })
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
