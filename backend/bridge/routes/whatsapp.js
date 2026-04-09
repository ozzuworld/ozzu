// routes/whatsapp.js — WhatsApp REST API
// Wraps wa-service.js singleton with HTTP endpoints
// All incoming messages are persisted to postgres — phone is pure transport.

"use strict";

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

    // POST /whatsapp/incoming — Android WA agent calls this on every incoming message
    // Persists to DB + sends push notification
    if (req.method === "POST" && pathname === "/whatsapp/incoming") {
      const body = await parseBody(req);
      const { from, text, ts, id: waId } = body;
      if (!from) { sendJSON(res, 400, { error: "from required" }); return true; }

      const phone = from.replace("@s.whatsapp.net", "").replace("@g.us", "").replace(/\D/g, "");
      const msgText = text || "";

      // Persist to DB — use wa_id for dedup so duplicate pushes don't create duplicate rows
      try {
        await getTable(db);
        if (waId) {
          await db.query(
            "INSERT INTO whatsapp_messages (phone, direction, text, wa_id, received_at) VALUES ($1, 'in', $2, $3, $4) ON CONFLICT (wa_id) DO NOTHING",
            [phone, msgText, waId, ts ? new Date(ts) : new Date()]
          );
        } else {
          await db.query(
            "INSERT INTO whatsapp_messages (phone, direction, text, received_at) VALUES ($1, 'in', $2, $3)",
            [phone, msgText, ts ? new Date(ts) : new Date()]
          );
        }
      } catch (err) {
        // DB failure is non-fatal — still send push
      }

      // Push notification
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
      } catch (err) {
        // Push failure is non-fatal
      }

      sendJSON(res, 200, { ok: true });
      return true;
    }

    return false;
  };
};
