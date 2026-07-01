// apns-voip.js — Bridge → Apple VoIP push (PushKit).
//
// Purpose: wake King Kazuma's Ozzu app when June is handing a call off, so the app
// can register to Asterisk and show the native CallKit incoming-call screen even when
// it's backgrounded/locked. On iOS this is the ONLY way to ring a suspended app.
//
// Auth: token-based, using an APNs Auth Key (.p8). One key, never expires, works for
// prod + sandbox. This module is INERT until configured (returns {skipped:true}); it
// wires up the moment King Kazuma's paid Apple Developer account is active and these
// are set (docker-compose env + the .p8 in the bridge secrets mount):
//   APNS_KEY_PATH   = /root/.ozzu-secrets/apns_authkey.p8   (default)
//   APNS_KEY_ID     = 10-char Key ID (from the APNs key on the Keys page)
//   APNS_TEAM_ID    = 10-char Team ID (from Membership details)
//   APNS_BUNDLE_ID  = com.ozzu.app   (VoIP push topic is <bundle>.voip)
//   APNS_PRODUCTION = "0" to use the sandbox host, anything else = production
//
// No external deps — Node's built-in http2 + crypto (ES256) only.
const http2 = require("http2");
const crypto = require("crypto");
const fs = require("fs");

const DEFAULT_KEY_PATH = "/root/.ozzu-secrets/apns_authkey.p8";

let cachedJwt = null;
let cachedJwtAt = 0;

function apnsConfig() {
  const keyPath = process.env.APNS_KEY_PATH || DEFAULT_KEY_PATH;
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const bundleId = process.env.APNS_BUNDLE_ID || "com.ozzu.app";
  if (!keyId || !teamId) return null;
  if (!fs.existsSync(keyPath)) return null;
  return {
    keyPath,
    keyId,
    teamId,
    bundleId,
    host: process.env.APNS_PRODUCTION === "0" ? "api.sandbox.push.apple.com" : "api.push.apple.com",
  };
}

// APNs provider JWT (ES256 over the .p8 EC key). Apple allows reuse for up to ~60 min
// and rejects tokens refreshed too often, so we cache and rotate at ~45 min.
function providerToken(cfg) {
  if (cachedJwt && Date.now() - cachedJwtAt < 45 * 60 * 1000) return cachedJwt;
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput =
    b64url({ alg: "ES256", kid: cfg.keyId }) + "." + b64url({ iss: cfg.teamId, iat: Math.floor(Date.now() / 1000) });
  const key = fs.readFileSync(cfg.keyPath, "utf8");
  // dsaEncoding ieee-p1363 => raw r||s (64 bytes), which JWT ES256 requires (not DER).
  const sig = crypto.sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  cachedJwt = `${signingInput}.${sig}`;
  cachedJwtAt = Date.now();
  return cachedJwt;
}

// Send a VoIP push to one device. Resolves { ok, status, id?, reason?, skipped? } and
// never throws (so a hand-off never crashes on a push failure). `payload` is merged into
// the APNs body; the app's PushKit handler reads its custom keys to build the CallKit call.
function sendVoipPush(deviceToken, payload = {}) {
  return new Promise((resolve) => {
    const cfg = apnsConfig();
    if (!cfg) {
      console.warn("[apns] not configured (missing APNS_KEY_ID / APNS_TEAM_ID / .p8) — VoIP push skipped");
      return resolve({ ok: false, skipped: true });
    }
    if (!deviceToken) {
      console.warn("[apns] no device token on file — VoIP push skipped");
      return resolve({ ok: false, skipped: true });
    }

    let jwt;
    try {
      jwt = providerToken(cfg);
    } catch (e) {
      console.error("[apns] JWT sign failed:", e.message);
      return resolve({ ok: false, error: e.message });
    }

    const body = Buffer.from(JSON.stringify({ aps: {}, ...payload }));
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };

    const client = http2.connect(`https://${cfg.host}:443`);
    client.on("error", (e) => {
      console.error("[apns] connection error:", e.message);
      done({ ok: false, error: e.message });
    });

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": `${cfg.bundleId}.voip`,
      "apns-push-type": "voip",
      "apns-priority": "10",
      "apns-expiration": "0", // deliver immediately or not at all — a call is only useful live
      "content-type": "application/json",
      "content-length": body.length,
    });

    let status = 0;
    let apnsId = null;
    let data = "";
    req.on("response", (h) => {
      status = h[":status"];
      apnsId = h["apns-id"];
    });
    req.setEncoding("utf8");
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      client.close();
      const ok = status === 200;
      let reason;
      if (!ok) {
        try { reason = JSON.parse(data || "{}").reason; } catch {}
        console.error(`[apns] push failed status=${status} reason=${reason || data}`);
      } else {
        console.log(`[apns] VoIP push delivered (apns-id=${apnsId})`);
      }
      done({ ok, status, id: apnsId, reason });
    });
    req.on("error", (e) => {
      console.error("[apns] request error:", e.message);
      done({ ok: false, error: e.message });
    });
    req.end(body);
  });
}

module.exports = { sendVoipPush, apnsConfigured: () => !!apnsConfig() };

// CLI self-test: `node apns-voip.js <hex-device-token>` — sends a test VoIP push so we
// can verify end-to-end the moment the .p8 + IDs are in place.
if (require.main === module) {
  const token = process.argv[2];
  if (!token) {
    console.log("usage: node apns-voip.js <voip-device-token>");
    console.log("configured:", require("./apns-voip").apnsConfigured());
    process.exit(1);
  }
  sendVoipPush(token, {
    type: "incoming_call",
    caller_name: "Test Caller",
    caller_number: "+10000000000",
    call_uuid: "test-" + Math.random().toString(16).slice(2),
  }).then((r) => {
    console.log("result:", r);
    process.exit(r.ok ? 0 : 1);
  });
}
