/**
 * CapSolver CAPTCHA solver — reCAPTCHA v2 + hCaptcha via CDP token injection
 *
 * Flow:
 *   1. Forward WebView DevTools socket to localhost via ADB
 *   2. Connect via WebSocket, enumerate execution contexts
 *   3. Extract sitekey from Google/hCaptcha iframe URL
 *   4. Send to CapSolver API → get token
 *   5. Inject token into g-recaptcha-response / h-captcha-response textarea
 *   6. Trigger callback to submit
 *
 * Directive: dir_1775978050127
 */

"use strict";

const https = require("https");
const { execSync } = require("child_process");

const CAPSOLVER_KEY =
  process.env.CAPSOLVER_API_KEY ||
  "CAP-A8CD1470E6D757E611525B87264AD3BB89D0213431053F0655812AC4F61A805D";

const ADB_DEVICE = process.env.ADB_DEVICE || "localhost:5556";
const CDP_PORT = 9222;

// ── CapSolver API ──

function capsolverRequest(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: "api.capsolver.com",
        path: endpoint,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": data.length,
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(new Error("CapSolver parse error: " + buf.substring(0, 200)));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Solve a CAPTCHA token via CapSolver
 * @param {"recaptcha"|"hcaptcha"} type
 * @param {string} sitekey
 * @param {string} pageUrl
 * @param {boolean} isInvisible - whether the reCAPTCHA is invisible (size=invisible)
 * @returns {Promise<string>} token
 */
async function solveToken(type, sitekey, pageUrl, isInvisible = false) {
  const taskType =
    type === "hcaptcha"
      ? "HCaptchaTaskProxyLess"
      : "ReCaptchaV2TaskProxyLess";

  console.log(`[capsolver] Solving ${type} (${taskType})${isInvisible ? " [invisible]" : ""}...`);
  console.log(`[capsolver]   sitekey: ${sitekey}`);
  console.log(`[capsolver]   url: ${pageUrl}`);

  const task = {
    type: taskType,
    websiteURL: pageUrl,
    websiteKey: sitekey,
  };
  if (isInvisible) task.isInvisible = true;

  const createRes = await capsolverRequest("/createTask", {
    clientKey: CAPSOLVER_KEY,
    task,
  });

  if (createRes.errorId && createRes.errorId !== 0) {
    throw new Error(
      `CapSolver create error: ${createRes.errorDescription || JSON.stringify(createRes)}`
    );
  }

  // Instant result
  if (createRes.solution) {
    const token =
      createRes.solution.gRecaptchaResponse || createRes.solution.token;
    console.log(`[capsolver] Instant solve (${token.length} chars)`);
    return token;
  }

  // Poll
  const taskId = createRes.taskId;
  console.log(`[capsolver] Task: ${taskId}, polling...`);

  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const r = await capsolverRequest("/getTaskResult", {
      clientKey: CAPSOLVER_KEY,
      taskId,
    });

    if (r.status === "ready") {
      const token = r.solution.gRecaptchaResponse || r.solution.token;
      console.log(`[capsolver] Solved in ${(i + 1) * 3}s (${token.length} chars)`);
      return token;
    }
    if (r.errorId && r.errorId !== 0) {
      throw new Error(`CapSolver poll error: ${r.errorDescription}`);
    }
  }
  throw new Error("CapSolver timeout (180s)");
}

// ── CDP Helpers ──

function adbCmd(cmd) {
  try {
    return execSync(`adb -s ${ADB_DEVICE} ${cmd}`, {
      timeout: 10000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    return e.stdout ? e.stdout.trim() : "";
  }
}

/**
 * Find active WebView debug sockets and forward the most recent one
 * @returns {string|null} pageId if found
 */
function setupCDP() {
  // Remove old forwards
  adbCmd("forward --remove-all");

  // Find webview debug sockets
  const unix = adbCmd("shell cat /proc/net/unix");
  const sockets = [];
  const re = /@webview_devtools_remote_(\d+)/g;
  let m;
  while ((m = re.exec(unix))) {
    sockets.push(m[1]);
  }

  if (!sockets.length) {
    console.log("[capsolver] No WebView debug sockets found");
    return null;
  }

  // Use the highest PID (most recent)
  const pid = sockets.sort((a, b) => +b - +a)[0];
  console.log(`[capsolver] Forwarding webview_devtools_remote_${pid}`);
  adbCmd(`forward tcp:${CDP_PORT} localabstract:webview_devtools_remote_${pid}`);

  // Get page list
  try {
    const pages = JSON.parse(
      execSync(`curl -s http://localhost:${CDP_PORT}/json`, {
        timeout: 5000,
        encoding: "utf8",
      })
    );
    if (pages.length > 0) {
      console.log(`[capsolver] Page: ${pages[0].title} (${pages[0].id})`);
      return pages[0].id;
    }
  } catch (e) {
    console.log("[capsolver] Failed to get page list:", e.message);
  }
  return null;
}

/**
 * Connect to a WebView page via CDP, extract sitekey, solve CAPTCHA, inject token
 * @param {string} pageId - CDP page ID
 * @param {string} pageUrl - the URL we're on (for CapSolver)
 * @returns {Promise<{solved: boolean, type: string|null, error: string|null}>}
 */
async function solveCaptchaOnPage(pageId, pageUrl) {
  let WebSocket;
  try {
    WebSocket = require("ws");
  } catch (e) {
    // ws might not be installed in host context — try from bridge node_modules
    WebSocket = require("/home/gcp/ozzu/backend/bridge/node_modules/ws");
  }

  const ws = new WebSocket(
    `ws://localhost:${CDP_PORT}/devtools/page/${pageId}`
  );

  let contexts = [];
  let msgId = 1;

  function send(method, params) {
    const id = msgId++;
    ws.send(JSON.stringify({ id, method, params }));
    return id;
  }

  function evalCtx(ctxId, expr) {
    return new Promise((resolve, reject) => {
      const id = send("Runtime.evaluate", {
        contextId: ctxId,
        returnByValue: true,
        expression: expr,
      });
      const timer = setTimeout(() => {
        ws.removeListener("message", handler);
        reject(new Error("eval timeout"));
      }, 10000);
      const handler = (data) => {
        const msg = JSON.parse(data);
        if (msg.id === id) {
          clearTimeout(timer);
          ws.removeListener("message", handler);
          resolve(msg.result?.result?.value || null);
        }
      };
      ws.on("message", handler);
    });
  }

  try {
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WS connect timeout")), 5000);
    });

    ws.on("message", (data) => {
      const msg = JSON.parse(data);
      if (msg.method === "Runtime.executionContextCreated")
        contexts.push(msg.params.context);
      if (msg.method === "Runtime.executionContextDestroyed")
        contexts = contexts.filter(
          (c) => c.id !== msg.params.executionContextId
        );
    });

    send("Runtime.enable");
    await sleep(2000);
    console.log(`[capsolver] ${contexts.length} execution contexts`);

    // ── Detect CAPTCHA type and extract sitekey ──

    let sitekey = null;
    let captchaType = null;
    let isInvisible = false;

    // Check for reCAPTCHA (Google contexts) — prefer normal (size!=invisible) over invisible
    const googleCtxs = contexts.filter((c) => c.origin.includes("google.com"));
    const candidates = [];

    for (const ctx of googleCtxs) {
      try {
        const r = await evalCtx(
          ctx.id,
          "(function(){var url=window.location.href;var m=url.match(/[?&]k=([^&]+)/);if(!m)return null;var inv=url.indexOf('size=invisible')!==-1;return JSON.stringify({key:m[1],invisible:inv})})()"
        );
        if (r) {
          const parsed = JSON.parse(r);
          candidates.push(parsed);
        }
      } catch (e) {
        /* skip */
      }
    }

    // Prefer normal (visible) reCAPTCHA over invisible
    const normal = candidates.find((c) => !c.invisible);
    const invisible = candidates.find((c) => c.invisible);
    if (normal) {
      sitekey = normal.key;
      captchaType = "recaptcha";
      isInvisible = false;
    } else if (invisible) {
      sitekey = invisible.key;
      captchaType = "recaptcha";
      isInvisible = true;
    }

    // Check for hCaptcha
    if (!sitekey) {
      for (const ctx of contexts) {
        try {
          const r = await evalCtx(
            ctx.id,
            '(function(){var el=document.querySelector("[data-sitekey]");if(el)return el.getAttribute("data-sitekey");var iframe=document.querySelector("iframe[src*=hcaptcha]");if(iframe){var m=iframe.src.match(/sitekey=([^&]+)/);return m?m[1]:null}return null})()'
          );
          if (r) {
            sitekey = r;
            captchaType = "hcaptcha";
            break;
          }
        } catch (e) {
          /* skip */
        }
      }
    }

    // Also check LinkedIn page context for data-sitekey
    if (!sitekey) {
      for (const ctx of contexts.filter(
        (c) => !c.origin.includes("google.com")
      )) {
        try {
          const r = await evalCtx(
            ctx.id,
            '(function(){var iframe=document.querySelector("iframe[src*=recaptcha]");if(iframe){var m=iframe.src.match(/[?&]k=([^&]+)/);return m?m[1]:null}return null})()'
          );
          if (r) {
            sitekey = r;
            captchaType = "recaptcha";
            break;
          }
        } catch (e) {
          /* skip */
        }
      }
    }

    if (!sitekey) {
      ws.close();
      return { solved: false, type: null, error: "No CAPTCHA sitekey found" };
    }

    console.log(`[capsolver] Detected ${captchaType}${isInvisible ? " (invisible)" : ""}, sitekey: ${sitekey}`);

    // ── Solve ──

    const token = await solveToken(captchaType, sitekey, pageUrl, isInvisible);
    const escapedToken = token.replace(/'/g, "\\'").replace(/\\/g, "\\\\");

    // ── Inject token ──

    let injected = false;
    const textareaName =
      captchaType === "hcaptcha"
        ? "h-captcha-response"
        : "g-recaptcha-response";

    for (const ctx of contexts) {
      try {
        const r = await evalCtx(
          ctx.id,
          `(function(){var t='${escapedToken}';var found=[];var tas=document.querySelectorAll('textarea');for(var i=0;i<tas.length;i++){var ta=tas[i];if(ta.id&&ta.id.indexOf('${textareaName}')!==-1){ta.innerHTML=t;ta.value=t;found.push(ta.id)}}return found.length?JSON.stringify(found):null})()`
        );
        if (r) {
          console.log(`[capsolver] Injected in ctx ${ctx.id}: ${r}`);
          injected = true;
        }
      } catch (e) {
        /* skip */
      }
    }

    // ── Trigger callback ──

    let callbackTriggered = false;

    // For reCAPTCHA: ___grecaptcha_cfg callback
    if (captchaType === "recaptcha") {
      for (const ctx of contexts.filter(
        (c) => !c.origin.includes("google.com")
      )) {
        try {
          const r = await evalCtx(
            ctx.id,
            `(function(){var t='${escapedToken}';if(typeof ___grecaptcha_cfg!=='undefined'&&___grecaptcha_cfg.clients){for(var ck in ___grecaptcha_cfg.clients){var cl=___grecaptcha_cfg.clients[ck];(function walk(o,d){if(d>8||!o)return;for(var k in o){if(!o.hasOwnProperty(k))continue;if(typeof o[k]==='object'&&o[k]!==null){if(o[k].callback&&typeof o[k].callback==='function'){try{o[k].callback(t);return true}catch(e){}}walk(o[k],d+1)}}})(cl,0)}}return 'done'})()`
          );
          if (r === "done") {
            callbackTriggered = true;
            console.log(`[capsolver] Callback triggered in ctx ${ctx.id}`);
          }
        } catch (e) {
          /* skip */
        }
      }
    }

    // For hCaptcha: find and call the hcaptcha callback
    if (captchaType === "hcaptcha") {
      for (const ctx of contexts.filter(
        (c) => !c.origin.includes("hcaptcha.com")
      )) {
        try {
          const r = await evalCtx(
            ctx.id,
            `(function(){var t='${escapedToken}';if(typeof hcaptcha!=='undefined'){try{hcaptcha.setResponse(t);return 'set'}catch(e){}}var forms=document.querySelectorAll('form');for(var i=0;i<forms.length;i++){var ta=forms[i].querySelector('textarea[name="h-captcha-response"]');if(ta){ta.value=t;try{forms[i].submit();return 'submitted'}catch(e){}}}return 'no-callback'})()`
          );
          if (r && r !== "no-callback") {
            callbackTriggered = true;
            console.log(`[capsolver] hCaptcha ${r} in ctx ${ctx.id}`);
          }
        } catch (e) {
          /* skip */
        }
      }
    }

    // Also try submitting any verify form
    if (!callbackTriggered) {
      for (const ctx of contexts.filter(
        (c) =>
          !c.origin.includes("google.com") &&
          !c.origin.includes("hcaptcha.com")
      )) {
        try {
          await evalCtx(
            ctx.id,
            "(function(){var forms=document.querySelectorAll('form');for(var i=0;i<forms.length;i++){if(forms[i].action&&forms[i].action.indexOf('verify')!==-1){forms[i].submit();return true}}return false})()"
          );
        } catch (e) {
          /* skip */
        }
      }
    }

    await sleep(2000);
    ws.close();

    return {
      solved: injected,
      type: captchaType,
      callbackTriggered,
      error: injected ? null : "Token solved but injection failed",
    };
  } catch (err) {
    try {
      ws.close();
    } catch (e) {
      /* ignore */
    }
    return { solved: false, type: null, error: err.message };
  }
}

/**
 * Detect if a CAPTCHA is present on the current WebView and solve it
 * @param {string} pageUrl - URL context for CapSolver
 * @returns {Promise<{solved: boolean, type: string|null, error: string|null}>}
 */
async function detectAndSolve(pageUrl) {
  const pageId = setupCDP();
  if (!pageId) {
    return { solved: false, type: null, error: "No WebView found" };
  }
  return solveCaptchaOnPage(pageId, pageUrl);
}

module.exports = {
  solveToken,
  setupCDP,
  solveCaptchaOnPage,
  detectAndSolve,
  capsolverRequest,
};
