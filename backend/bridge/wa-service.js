// wa-service.js — WhatsApp Web singleton via Baileys
// Connects once via QR scan, saves auth state, exposes send/read/takeover.

"use strict";

const path = require("path");
const fs = require("fs");
const { sendPush } = require("./push-notifications");
const db = require("./db");

const AUTH_DIR = path.join(__dirname, "wa-auth");
const AI_TRIGGER_PATTERNS = [
  /\bbot\b/i, /\bia\b/i, /\bartificial intelligence\b/i,
  /\bautomated\b/i, /\bautom[aá]tico\b/i,
  /eres (un )?(bot|ia|robot|m[aá]quina)/i,
  /is this (a )?(bot|ai|automated|robot)/i,
  /are you (a )?(bot|ai|robot|real person)/i,
  /\brobот\b/i, /hablando con (un )?(bot|ia)/i,
  /\bchattingbot\b/i,
];

let _client = null;       // Baileys socket
let _qrCode = null;       // base64 QR image (null when connected)
let _status = "disconnected"; // disconnected | qr_pending | connected
let _pausedContacts = new Set(); // phones paused for AI (human takeover active)

// ── DB init ───────────────────────────────────────────────────────────────────

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wa_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      phone       TEXT NOT NULL,
      direction   TEXT NOT NULL CHECK(direction IN ('in','out')),
      body        TEXT NOT NULL,
      timestamp   INTEGER NOT NULL,
      msg_id      TEXT,
      status      TEXT DEFAULT 'delivered'
    );
    CREATE INDEX IF NOT EXISTS wa_messages_phone ON wa_messages(phone);
  `);
}

function saveMessage(phone, direction, body, timestamp, msgId) {
  db.run(
    `INSERT OR IGNORE INTO wa_messages (phone, direction, body, timestamp, msg_id)
     VALUES (?, ?, ?, ?, ?)`,
    [normalizePhone(phone), direction, body, timestamp || Date.now(), msgId || null]
  );
}

function getMessages(phone, limit = 50) {
  return db.all(
    `SELECT direction, body, timestamp, msg_id, status
     FROM wa_messages WHERE phone = ?
     ORDER BY timestamp DESC LIMIT ?`,
    [normalizePhone(phone), limit]
  ).reverse();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizePhone(phone) {
  // Strip non-digits, ensure no trailing @s.whatsapp.net
  return phone.replace(/\D/g, "").replace(/@.*$/, "");
}

function toJid(phone) {
  return normalizePhone(phone) + "@s.whatsapp.net";
}

function isAiTrigger(text) {
  return AI_TRIGGER_PATTERNS.some(p => p.test(text));
}

async function getPushTokens() {
  try {
    const rows = db.all("SELECT token FROM device_push_tokens WHERE token LIKE 'ExponentPushToken[%'");
    return rows.map(r => r.token);
  } catch {
    return [];
  }
}

async function notifyHuman(phone, reason, preview) {
  const tokens = await getPushTokens();
  if (tokens.length === 0) return { sent: 0, error: "No push tokens registered" };
  return sendPush(tokens, {
    title: "⚠️ WhatsApp — Human takeover needed",
    body: `${phone}: ${reason}${preview ? `\n"${preview.substring(0, 80)}"` : ""}`,
    data: { type: "wa_takeover", phone, reason },
    priority: "high",
  });
}

// ── Connect ───────────────────────────────────────────────────────────────────

async function connect() {
  if (_status === "connected") return;
  if (_status === "qr_pending") return; // already starting

  initDb();

  let makeWASocket, useMultiFileAuthState, DisconnectReason, Boom;
  try {
    ({ default: makeWASocket } = await import("@whiskeysockets/baileys"));
    ({ useMultiFileAuthState } = await import("@whiskeysockets/baileys"));
    ({ DisconnectReason } = await import("@whiskeysockets/baileys"));
    Boom = (await import("@hapi/boom")).Boom;
  } catch (e) {
    console.error("[wa-service] Failed to load Baileys:", e.message);
    return;
  }

  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  _status = "qr_pending";

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: ["Ozzu", "Chrome", "1.0.0"],
    syncFullHistory: false,
    logger: { level: "silent", trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({ level: "silent", trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => {} }) },
  });

  _client = sock;

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrcode = require("qrcode");
        _qrCode = await qrcode.toDataURL(qr);
      } catch {
        _qrCode = qr; // raw string fallback
      }
      _status = "qr_pending";
      console.log("[wa-service] QR ready — scan at GET /whatsapp/qr");
    }

    if (connection === "open") {
      _status = "connected";
      _qrCode = null;
      console.log("[wa-service] Connected to WhatsApp");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : null;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      _status = "disconnected";
      _client = null;
      console.log(`[wa-service] Disconnected (code ${code}), reconnect=${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => connect(), 5000);
      } else {
        // Logged out — wipe auth
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        console.log("[wa-service] Logged out, auth cleared. Restart to re-pair.");
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith("@g.us")) continue; // skip groups

      const phone = normalizePhone(jid);
      const body = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || "";

      if (!body) continue;

      const ts = (msg.messageTimestamp || 0) * 1000;
      saveMessage(phone, "in", body, ts, msg.key.id);

      // AI detection
      if (isAiTrigger(body) && !_pausedContacts.has(phone)) {
        _pausedContacts.add(phone);
        console.log(`[wa-service] AI trigger detected from ${phone}: "${body}"`);
        await notifyHuman(phone, "May have detected AI", body);
      }
    }
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

async function send(phone, message) {
  if (_status !== "connected" || !_client) {
    throw new Error(`WhatsApp not connected (status: ${_status})`);
  }
  if (_pausedContacts.has(normalizePhone(phone))) {
    throw new Error(`Human takeover active for ${phone}. Resume AI mode first.`);
  }
  const jid = toJid(phone);
  await _client.sendMessage(jid, { text: message });
  saveMessage(phone, "out", message, Date.now());
  return { ok: true, phone, message };
}

function status() {
  return {
    status: _status,
    qrAvailable: _qrCode !== null,
    pausedContacts: Array.from(_pausedContacts),
  };
}

function qr() {
  return _qrCode;
}

function pause(phone) {
  _pausedContacts.add(normalizePhone(phone));
}

function resume(phone) {
  _pausedContacts.delete(normalizePhone(phone));
}

module.exports = { connect, send, status, qr, getMessages, pause, resume, notifyHuman, normalizePhone };
