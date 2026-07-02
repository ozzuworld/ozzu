// approval-gate.js — Shared FaceID approval gate for outbound messages
// Hardcoded policy — adding a gated tool requires a code change + deploy
"use strict";

const GATED_TOOLS = {
  "gmail-personal": {
    send_gmail_message: { label: "Gmail (personal)", extract: (a) => ({ recipient: a.to, message: `Subject: ${a.subject}` }) },
    send_message:       { label: "Chat (personal)",  extract: (a) => ({ recipient: a.recipient, message: a.message }) },
  },
  "gmail-ozzu": {
    send_gmail_message: { label: "Gmail (ozzu)",     extract: (a) => ({ recipient: a.to, message: `Subject: ${a.subject}` }) },
    send_message:       { label: "Chat (ozzu)",       extract: (a) => ({ recipient: a.recipient, message: a.message }) },
  },
};

function createApprovalGate({ db, sendPush }) {
  const http = require("http");

  async function requireMessageApproval(type, summary, payload) {
    const approvalId = `apr_msg_${Date.now()}`;
    const approval = {
      id: approvalId,
      tool: type,
      description: summary,
      risk: "high",
      type: "message_send",
      payload,
    };

    // Create approval via bridge
    const createResult = await new Promise((resolve) => {
      const body = JSON.stringify(approval);
      const req = http.request({ hostname: "localhost", port: 3333, path: "/approvals", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } }); });
      req.on("error", e => resolve({ error: e.message }));
      req.write(body); req.end();
    });
    if (createResult.error) return { error: `Failed to create approval: ${createResult.error}` };

    // Send push notification
    try {
      const tokens = await db.query("SELECT token FROM device_push_tokens ORDER BY updated_at DESC LIMIT 5");
      if (tokens.rows.length > 0) {
        await sendPush(tokens.rows.map(r => r.token), {
          title: "\u{1F510} Approval Required",
          body: summary,
          data: { type: "message_approval", approvalId, screen: "directives" },
        });
      }
    } catch (e) { /* push is best-effort */ }

    // Poll for resolution (up to 5 minutes)
    const POLL_INTERVAL = 2000;
    const MAX_WAIT = 5 * 60 * 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_WAIT) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      const pollResult = await new Promise((resolve) => {
        const req = http.request({ hostname: "localhost", port: 3333, path: `/approvals/${approvalId}/poll`, method: "GET" },
          (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); });
        req.on("error", () => resolve({}));
        req.end();
      });

      if (pollResult.resolved) {
        if (pollResult.approved) return { approved: true };
        return { error: "Message denied by King Kazuma" };
      }
    }

    return { error: "Approval timed out (5 minutes). Message NOT sent." };
  }

  return requireMessageApproval;
}

module.exports = { GATED_TOOLS, createApprovalGate };
