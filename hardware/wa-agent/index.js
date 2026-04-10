const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default || baileys.makeWASocket;
const { useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion } = baileys;
const http = require('http');
const fs = require('fs');
const path = require('path');

const HOME = '/data/data/com.termux/files/home';
const AUTH_DIR = path.join(HOME, 'wa-auth');
const PORT = 8765;
const BRIDGE_HOST = '34.135.158.92';
const BRIDGE_PORT = 3333;

let sock = null;
let qrCode = null;
let pairingCode = null;
let isReady = false;
const pendingMessages = [];
const pausedContacts = new Set();

// LID → phone number mapping (WhatsApp privacy feature)
// Populated from contacts.upsert events; persisted to disk so it survives restarts
const LID_MAP_FILE = path.join(HOME, 'wa-lid-map.json');
const lidToPhone = (() => {
  try { return JSON.parse(fs.readFileSync(LID_MAP_FILE, 'utf8')); } catch { return {}; }
})();

function saveLidMap() {
  try { fs.writeFileSync(LID_MAP_FILE, JSON.stringify(lidToPhone)); } catch {}
}

// Resolve a JID to a clean phone number string.
// @lid JIDs: look up in lidToPhone map. Falls back to numeric prefix of JID.
function resolveJid(jid) {
  if (!jid) return null;
  if (jid.endsWith('@lid')) {
    const lid = jid.replace('@lid', '');
    if (lidToPhone[lid]) return lidToPhone[lid];
    // Can't resolve — return null so we skip unknown senders
    return null;
  }
  // Standard JID: 573226033350@s.whatsapp.net or 573226033350:3@s.whatsapp.net
  const num = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
  return num || null;
}

const PHONE_NUMBER = '573226033350';

function notifyBridge(from, text, id) {
  try {
    const payload = JSON.stringify({ from, text, ts: Date.now(), id });
    const req = http.request({
      hostname: BRIDGE_HOST,
      port: BRIDGE_PORT,
      path: '/whatsapp/incoming',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch(e) {}
}

async function startWA() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version;
  try {
    const result = await fetchLatestWaWebVersion();
    version = result.version;
    console.log('WA version:', version);
  } catch(e) {
    version = [2, 3000, 1027934701];
    console.log('Using fallback version');
  }

  sock = makeWASocket({
    auth: state,
    version,
    browser: baileys.Browsers ? baileys.Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '22.04.4'],
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // Build LID→phone map from contact updates
  sock.ev.on('contacts.upsert', (contacts) => {
    let changed = false;
    for (const c of contacts) {
      if (c.lid && c.id) {
        const lid = c.lid.replace('@lid', '').split(':')[0];
        const phone = c.id.split('@')[0].split(':')[0].replace(/\D/g, '');
        if (phone && lid && lidToPhone[lid] !== phone) {
          lidToPhone[lid] = phone;
          changed = true;
        }
      }
    }
    if (changed) saveLidMap();
  });

  sock.ev.on('contacts.update', (updates) => {
    let changed = false;
    for (const c of updates) {
      if (c.lid && c.id) {
        const lid = c.lid.replace('@lid', '').split(':')[0];
        const phone = c.id.split('@')[0].split(':')[0].replace(/\D/g, '');
        if (phone && lid && lidToPhone[lid] !== phone) {
          lidToPhone[lid] = phone;
          changed = true;
        }
      }
    }
    if (changed) saveLidMap();
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCode = qr;
      isReady = false;
      console.log('QR ready');
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        pairingCode = code;
        console.log('PAIRING CODE:', code);
      } catch(e) {
        console.log('Pairing code error:', e.message);
      }
    }
    if (connection === 'open') {
      isReady = true;
      qrCode = null;
      pairingCode = null;
      console.log('WhatsApp CONNECTED!');
    }
    if (connection === 'close') {
      isReady = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('Disconnected, code:', code);
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(startWA, 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const rawJid = msg.key.remoteJid;
      const phone = resolveJid(rawJid);
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      console.log('MSG from', rawJid, phone ? `(${phone})` : '(unresolved lid)', ':', text);
      if (!phone) {
        console.log('LID unresolved — skipping bridge notify. LID map size:', Object.keys(lidToPhone).length);
        continue;
      }
      pendingMessages.push({ from: phone, text, ts: Date.now(), id: msg.key.id });
      notifyBridge(phone, text, msg.key.id);
    }
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, data) => { res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify(data)); };

  if (req.method === 'GET' && url.pathname === '/status')
    return send(200, { ready: isReady, hasQr: !!qrCode, pairingCode });

  if (req.method === 'GET' && url.pathname === '/qr')
    return send(qrCode ? 200 : 404, { qr: qrCode, pairingCode });

  if (req.method === 'GET' && url.pathname === '/lid-map')
    return send(200, lidToPhone);

  // Manual LID seeding: POST /lid-add { lid: "271145597153466", phone: "573187290206" }
  if (req.method === 'POST' && url.pathname === '/lid-add') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { lid, phone } = JSON.parse(body);
        if (!lid || !phone) return send(400, { error: 'lid and phone required' });
        lidToPhone[lid.replace('@lid', '').split(':')[0]] = phone.replace(/\D/g, '');
        saveLidMap();
        return send(200, { ok: true, map: lidToPhone });
      } catch(e) { send(500, { error: e.message }); }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/messages/')) {
    const phone = url.pathname.split('/')[2];
    return send(200, { messages: pendingMessages.filter(m => m.from.startsWith(phone)) });
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        if (url.pathname === '/send') {
          if (!isReady) return send(503, { error: 'Not connected' });
          const jid = data.phone.includes('@') ? data.phone : `${data.phone}@s.whatsapp.net`;
          if (pausedContacts.has(jid)) return send(423, { error: 'Paused' });
          await sock.sendMessage(jid, { text: data.message });
          return send(200, { ok: true });
        }
        if (url.pathname === '/pause') {
          const jid = data.phone.includes('@') ? data.phone : `${data.phone}@s.whatsapp.net`;
          pausedContacts.add(jid); return send(200, { paused: true });
        }
        if (url.pathname === '/resume') {
          const jid = data.phone.includes('@') ? data.phone : `${data.phone}@s.whatsapp.net`;
          pausedContacts.delete(jid); return send(200, { resumed: true });
        }
      } catch(e) { send(500, { error: e.message }); }
    });
    return;
  }

  send(404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => console.log('WA agent on port', PORT));
startWA().catch(e => console.error('startWA error:', e));
