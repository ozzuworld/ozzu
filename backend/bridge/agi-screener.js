// agi-screener.js — FastAGI server for Asterisk call screening
// Asterisk dials AGI(agi://127.0.0.1:4573/screen,<callerID>)
// This queries the bridge's call_osint table and asks DeepSeek
// whether the call is spam. Sets SCREEN_RESULT=pass or =spam.
"use strict";

const net = require("net");

const PORT = 4573;
const BRIDGE_URL = process.env.BRIDGE_URL || "http://127.0.0.1:3333";
const BRIDGE_TOKEN = process.env.BRIDGE_API_KEY || process.env.BRIDGE_TOKEN || "";

const server = net.createServer(handleConnection);

function handleConnection(sock) {
  let buffer = "";
  let agiVars = {};
  let headersDone = false;
  let pendingResolve = null;

  sock.on("data", (data) => {
    buffer += data.toString();
    if (!headersDone) {
      const end = buffer.indexOf("\n\n");
      if (end === -1) return;
      const headerBlock = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      for (const line of headerBlock.split("\n")) {
        const m = line.match(/^agi_(\w+):\s*(.*)$/);
        if (m) agiVars[m[1]] = m[2];
      }
      headersDone = true;
      processCall(sock, agiVars, sendCommand);
    }
    // Handle command responses
    if (pendingResolve) {
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve(line);
      }
    }
  });

  sock.on("error", (e) => {
    console.error("[AGI] socket error:", e.message);
  });

  function sendCommand(cmd) {
    return new Promise((resolve) => {
      pendingResolve = resolve;
      sock.write(cmd + "\n");
    });
  }
}

async function processCall(sock, vars, cmd) {
  const callerNum = vars.arg_1 || vars.callerid || "unknown";
  console.log(`[AGI] Screening call from: ${callerNum}`);

  try {
    // 1. Check call_osint table via bridge API
    const osintData = await fetchOsint(callerNum);

    // 2. Quick rules (skip AI for obvious cases)
    let result = quickScreen(callerNum, osintData);

    if (!result) {
      // 3. Ask AI
      result = await aiScreen(callerNum, osintData);
    }

    console.log(`[AGI] Verdict for ${callerNum}: ${result}`);

    // Set channel variable
    await cmd(`SET VARIABLE SCREEN_RESULT ${result}`);
    await cmd("VERBOSE \"Call screening complete\" 1");
  } catch (e) {
    console.error(`[AGI] Error screening ${callerNum}:`, e.message);
    // On error, let the call through (fail-open for legit callers)
    await cmd("SET VARIABLE SCREEN_RESULT pass");
  }

  sock.end();
}

async function fetchOsint(number) {
  try {
    const url = `${BRIDGE_URL}/soc/calls/${encodeURIComponent(number)}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

function quickScreen(number, osint) {
  // Known VoIP → likely spam
  if (osint?.is_voip) return "spam";

  // Known spam score
  if (osint?.spam_score && osint.spam_score > 5) return "spam";

  // Contacts / whitelist (stored as label in call_log)
  if (osint?.label === "contact" || osint?.label === "whitelist") return "pass";

  // Very short numbers (3-4 digits) are usually service codes, not spam
  const digits = number.replace(/\D/g, "");
  if (digits.length <= 4) return "pass";

  return null; // needs AI
}

async function aiScreen(number, osint) {
  const offenseUrl = process.env.OFFENSE_MODEL_URL;
  const offenseKey = process.env.OFFENSE_MODEL_KEY;
  const offenseModel = process.env.OFFENSE_MODEL_NAME;

  if (!offenseUrl || !offenseKey) {
    console.log("[AGI] No AI model configured, fail-open");
    return "pass";
  }

  const context = osint
    ? `Caller: ${number}\nCarrier: ${osint.carrier || "unknown"}\nType: ${osint.line_type || "unknown"}\nCountry: ${osint.country || "unknown"}\nVoIP: ${osint.is_voip || false}\nSpam score: ${osint.spam_score || 0}\nPrior calls: ${osint.call_count || 0}`
    : `Caller: ${number}\nNo prior OSINT data available.`;

  try {
    const resp = await fetch(`${offenseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${offenseKey}`,
      },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        model: offenseModel || "deepseek-chat",
        messages: [
          {
            role: "system",
            content:
              'You are a call screening AI. Classify incoming calls as "pass" (legitimate, should ring through) or "spam" (robocall, scam, telemarketer). Respond with ONLY "pass" or "spam". When uncertain, lean toward "pass" — false negatives (missed spam) are less harmful than false positives (blocking real calls).',
          },
          {
            role: "user",
            content: `Screen this incoming call:\n${context}`,
          },
        ],
        max_tokens: 10,
        temperature: 0,
      }),
    });

    if (!resp.ok) {
      console.error("[AGI] AI error:", resp.status);
      return "pass";
    }

    const data = await resp.json();
    const answer = (data.choices?.[0]?.message?.content || "").trim().toLowerCase();
    return answer === "spam" ? "spam" : "pass";
  } catch (e) {
    console.error("[AGI] AI fetch error:", e.message);
    return "pass"; // fail-open
  }
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[AGI] Call screener listening on 127.0.0.1:${PORT}`);
});
