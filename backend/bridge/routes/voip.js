// routes/voip.js — VoIP stack status for the app's VoIP management tab.
// Live Asterisk registrations/channels (via docker exec asterisk CLI) + June
// receptionist health + recent calls/transfers (postgres) + the SIP/hand-off config.
"use strict";

const { execFile } = require("child_process");

function ast(cmd) {
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["exec", "ozzu-asterisk", "asterisk", "-rx", cmd],
      { timeout: 6000, maxBuffer: 1 << 20 },
      (e, out) => resolve(e ? "" : out || "")
    );
  });
}

function dockerUp(name) {
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["ps", "--filter", `name=${name}`, "--filter", "status=running", "--format", "{{.Names}}"],
      { timeout: 4000 },
      (e, out) => resolve(!e && (out || "").split("\n").some((l) => l.trim() === name))
    );
  });
}

// Parse `pjsip show endpoints` → [{id, state, channels, contact, contactStatus, rttMs}]
function parseEndpoints(raw) {
  const out = [];
  let cur = null;
  for (const line of raw.split("\n")) {
    const em = line.match(/^\s*Endpoint:\s+(\S+)\s+(.+?)\s+(\d+)\s+of/);
    if (em) {
      cur = { id: em[1], state: em[2].trim(), channels: parseInt(em[3], 10) || 0, contact: null, contactStatus: null, rttMs: null };
      out.push(cur);
      continue;
    }
    const cm = line.match(/^\s*Contact:\s+\S+\/(\S+)\s+\S+\s+(\S+)\s+(-?[\d.]+|-?nan)?/i);
    if (cm && cur) {
      cur.contact = cm[1];
      cur.contactStatus = cm[2];
      const rtt = parseFloat(cm[3]);
      cur.rttMs = Number.isFinite(rtt) ? Math.round(rtt) : null;
    }
  }
  return out;
}

// The VoIP gateway is a REAL fleet device: ozzu-sbc (the Rock Pi SIM7600 host) runs the
// ozzu-telemetry-linux.sh agent via systemd, pushing real telemetry to /api/device-telemetry
// like every other device. (No bridge-faked heartbeat here — that was a facade.)
module.exports = function voipRoutes(ctx) {
  const { sendJSON, db } = ctx;

  return async function handleVoipRoutes(req, res, pathname) {
    // GET /voip/status — full live picture of the VoIP stack
    if (req.method === "GET" && pathname === "/voip/status") {
      const [endpointsRaw, channelsRaw, juneUp, callerUp] = await Promise.all([
        ast("pjsip show endpoints"),
        ast("core show channels count"),
        dockerUp("june-voice"),
        dockerUp("ozzu-asterisk"),
      ]);

      const endpoints = parseEndpoints(endpointsRaw).map((e) => ({
        ...e,
        role:
          e.id === "ozzu-iphone" ? "iPhone app (WebRTC/CallKit)" :
          e.id === "ozzu-gateway" ? "GSM/SIP trunk (SBC gateway)" : e.id,
        registered: !!(e.contactStatus && /avail/i.test(e.contactStatus)),
      }));

      const app = endpoints.find((e) => e.id === "ozzu-iphone") || null;
      const gateway = endpoints.find((e) => e.id === "ozzu-gateway") || null;
      const activeCalls = parseInt((channelsRaw.match(/(\d+)\s+active channel/) || [])[1] || "0", 10);

      let recentCalls = [];
      let recentEvents = [];
      if (db) {
        try {
          const r = await db.query(
            "SELECT phone_number, direction, call_time, label FROM call_log ORDER BY call_time DESC LIMIT 12"
          );
          recentCalls = r.rows;
        } catch {}
        try {
          const r = await db.query(
            `SELECT event, caller_number, created_at, data FROM june_audit_log
             WHERE event IN ('call_start','transfer','duration_limit','hangup') ORDER BY created_at DESC LIMIT 15`
          );
          recentEvents = r.rows;
        } catch {}
      }

      sendJSON(res, 200, {
        ok: true,
        ts: new Date().toISOString(),
        asteriskUp: callerUp,
        june: { running: juneUp, port: 4580 },
        app: app
          ? { registered: !!app.registered, contact: app.contact, rttMs: app.rttMs, state: app.state, activeChannels: app.channels }
          : { registered: false, state: "not configured" },
        gateway: gateway
          ? { state: gateway.state, reachable: !/unavailable/i.test(gateway.state) }
          : null,
        endpoints,
        activeCalls,
        recentCalls,
        recentEvents,
        config: {
          appEndpoint: "ozzu-iphone",
          transport: "WSS via nginx /asterisk/ws → Asterisk :8088",
          publicWss: "wss://home.ozzu.world/asterisk/ws",
          media: "WebRTC DTLS-SRTP · ulaw (no transcode)",
          transferTarget: "PJSIP/ozzu-iphone",
          handoffPath: "Caller → GSM/SBC → Asterisk → June (screen) → transfer → iPhone app",
          receptionist: "June (Gemini Live) on AudioSocket :4580",
          pushkit: false,
          reachability: "Foreground-only until PushKit (needs Apple Developer key)",
        },
      });
      return true;
    }

    return false;
  };
};
