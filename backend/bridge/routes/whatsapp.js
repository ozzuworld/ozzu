// routes/whatsapp.js — WhatsApp REST API
// Wraps wa-service.js singleton with HTTP endpoints

"use strict";

module.exports = function whatsappRoutes(ctx) {
  const { sendJSON, parseBody } = ctx;

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

    // GET /whatsapp/qr — returns base64 PNG data URL for scanning
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
        // If it's a data URL serve as JSON; if raw string, convert
        sendJSON(res, 200, { qr });
      }
      return true;
    }

    // GET /whatsapp/messages/:phone
    if (req.method === "GET" && pathname.startsWith("/whatsapp/messages/")) {
      const phone = pathname.replace("/whatsapp/messages/", "");
      if (!phone) { sendJSON(res, 400, { error: "phone required" }); return true; }
      const url = new URL(req.url, "http://localhost");
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const messages = getWa().getMessages(phone, limit);
      sendJSON(res, 200, { phone: getWa().normalizePhone(phone), messages, count: messages.length });
      return true;
    }

    // POST /whatsapp/send
    if (req.method === "POST" && pathname === "/whatsapp/send") {
      const body = await parseBody(req);
      const { to, message } = body;
      if (!to || !message) { sendJSON(res, 400, { error: "to and message required" }); return true; }
      try {
        const result = await getWa().send(to, message);
        sendJSON(res, 200, result);
      } catch (err) {
        sendJSON(res, 503, { error: err.message });
      }
      return true;
    }

    // POST /whatsapp/pause — stop AI from sending to this contact
    if (req.method === "POST" && pathname === "/whatsapp/pause") {
      const body = await parseBody(req);
      const { phone } = body;
      if (!phone) { sendJSON(res, 400, { error: "phone required" }); return true; }
      getWa().pause(phone);
      sendJSON(res, 200, { ok: true, phone: getWa().normalizePhone(phone), paused: true });
      return true;
    }

    // POST /whatsapp/resume — allow AI to send again
    if (req.method === "POST" && pathname === "/whatsapp/resume") {
      const body = await parseBody(req);
      const { phone } = body;
      if (!phone) { sendJSON(res, 400, { error: "phone required" }); return true; }
      getWa().resume(phone);
      sendJSON(res, 200, { ok: true, phone: getWa().normalizePhone(phone), paused: false });
      return true;
    }

    // POST /whatsapp/notify-human — manually trigger push + pause
    if (req.method === "POST" && pathname === "/whatsapp/notify-human") {
      const body = await parseBody(req);
      const { phone, reason, preview } = body;
      if (!phone) { sendJSON(res, 400, { error: "phone required" }); return true; }
      getWa().pause(phone);
      const result = await getWa().notifyHuman(phone, reason || "Manual takeover requested", preview);
      sendJSON(res, 200, { ok: true, push: result });
      return true;
    }

    return false;
  };
};
