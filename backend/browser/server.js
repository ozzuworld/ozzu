const express = require("express");
const { chromium } = require("playwright");

const PORT = parseInt(process.env.BROWSER_PORT || "3334", 10);
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min idle timeout

const app = express();
app.use(express.json({ limit: "10mb" }));

// --- Session management ---

const sessions = new Map(); // id -> { page, context, lastUsed, timer }
let browser = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  console.log("[browser] Chromium launched");
  return browser;
}

async function getSession(sessionId = "default", opts = {}) {
  let session = sessions.get(sessionId);
  if (session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => closeSession(sessionId), SESSION_TIMEOUT_MS);
    session.lastUsed = Date.now();
    try {
      await session.page.title();
      return session;
    } catch {
      sessions.delete(sessionId);
    }
  }

  const b = await getBrowser();
  const contextOpts = {
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/New_York",
  };

  // Add proxy if requested (e.g. SOCKS5 through residential IP)
  if (opts.proxy) {
    contextOpts.proxy = { server: opts.proxy };
    console.log(`[browser] Session "${sessionId}" using proxy: ${opts.proxy}`);
  }

  const context = await b.newContext(contextOpts);
  const page = await context.newPage();

  // Stealth: hide automation fingerprints
  await page.addInitScript(() => {
    // Hide webdriver flag
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    // Fix platform to match user agent (Windows)
    Object.defineProperty(navigator, "platform", { get: () => "Win32" });
    // Add chrome object
    window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
    // Add plugins (mimic real Chrome)
    Object.defineProperty(navigator, "plugins", {
      get: () => [
        { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer" },
        { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai" },
        { name: "Native Client", filename: "internal-nacl-plugin" },
      ],
    });
    // Fix languages
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    // Override permissions query to not leak automation
    const origQuery = window.Permissions.prototype.query;
    window.Permissions.prototype.query = (params) =>
      params.name === "notifications"
        ? Promise.resolve({ state: Notification.permission })
        : origQuery(params);
  });

  const timer = setTimeout(() => closeSession(sessionId), SESSION_TIMEOUT_MS);
  session = { page, context, lastUsed: Date.now(), timer };
  sessions.set(sessionId, session);
  console.log(`[browser] Session "${sessionId}" created`);
  return session;
}

async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  clearTimeout(session.timer);
  try {
    await session.context.close();
  } catch {}
  sessions.delete(sessionId);
  console.log(`[browser] Session "${sessionId}" closed`);
  return true;
}

async function takeScreenshot(page, fullPage = false) {
  const buf = await page.screenshot({ fullPage, type: "png" });
  return buf.toString("base64");
}

// --- Routes ---

app.get("/health", (_req, res) => {
  res.json({ ok: true, sessions: sessions.size, uptime: process.uptime() });
});

app.get("/sessions", (_req, res) => {
  const list = [];
  for (const [id, s] of sessions) {
    list.push({ id, lastUsed: s.lastUsed, url: s.page.url() });
  }
  res.json({ ok: true, sessions: list });
});

app.post("/session/new", async (req, res) => {
  try {
    const { session_id, proxy } = req.body;
    const id = session_id || `session_${Date.now()}`;
    if (sessions.has(id)) {
      return res.json({ ok: true, session_id: id, message: "Session already exists" });
    }
    await getSession(id, { proxy });
    res.json({ ok: true, session_id: id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/session/close", async (req, res) => {
  try {
    const { session_id } = req.body;
    const closed = await closeSession(session_id || "default");
    res.json({ ok: true, closed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/navigate", async (req, res) => {
  try {
    const { url, session_id, wait_for } = req.body;
    if (!url) return res.status(400).json({ ok: false, error: "url required" });

    const { page } = await getSession(session_id);
    await page.goto(url, {
      waitUntil: wait_for || "networkidle",
      timeout: 30000,
    });

    const title = await page.title();
    const currentUrl = page.url();
    const screenshot = await takeScreenshot(page);

    res.json({ ok: true, title, url: currentUrl, screenshot });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/screenshot", async (req, res) => {
  try {
    const { session_id, full_page } = req.body;
    const { page } = await getSession(session_id);
    const screenshot = await takeScreenshot(page, full_page === true);
    const title = await page.title();
    const url = page.url();
    res.json({ ok: true, title, url, screenshot });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/click", async (req, res) => {
  try {
    const { selector, session_id, wait_after, x, y, text_match, force } = req.body;
    const { page } = await getSession(session_id);
    let info = null;
    const clickOpts = { force: force === true, timeout: 10000 };

    if (x !== undefined && y !== undefined) {
      info = { x, y, method: "coordinates" };
      await page.mouse.click(x, y);
    } else if (text_match) {
      // Playwright's getByText / getByRole — handles React properly
      const locator = page.getByRole("button", { name: text_match }).or(
        page.getByRole("link", { name: text_match })
      );
      const count = await locator.count();
      if (count === 0) {
        // Fallback to any element containing text
        const fallback = page.locator(`text=${text_match}`).first();
        if ((await fallback.count()) === 0) {
          return res.json({ ok: false, error: `No element with text: ${text_match}` });
        }
        const tag = await fallback.evaluate((el) => el.tagName);
        info = { tag, text: text_match, method: "text_fallback" };
        await fallback.click(clickOpts);
      } else {
        const el = locator.first();
        const tag = await el.evaluate((el) => el.tagName);
        const text = await el.evaluate((el) => el.textContent?.trim());
        info = { tag, text, method: "text_match" };
        await el.click(clickOpts);
      }
    } else {
      if (!selector) return res.status(400).json({ ok: false, error: "selector, text_match, or x/y required" });
      await page.waitForSelector(selector, { timeout: 10000 });
      info = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        return { tag: el.tagName, text: el.textContent?.trim().slice(0, 100), id: el.id };
      }, selector);
      await page.click(selector, clickOpts);
    }

    // Wait after click
    if (wait_after === "navigation") {
      await page.waitForLoadState("networkidle").catch(() => {});
    } else if (wait_after === "idle") {
      await page.waitForLoadState("networkidle").catch(() => {});
    } else if (typeof wait_after === "number") {
      await page.waitForTimeout(wait_after);
    }

    const screenshot = await takeScreenshot(page);
    res.json({ ok: true, clicked: info, screenshot });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/type", async (req, res) => {
  try {
    const { selector, text, session_id, clear, press_enter, react_compat } = req.body;
    if (!selector) return res.status(400).json({ ok: false, error: "selector required" });
    if (text === undefined) return res.status(400).json({ ok: false, error: "text required" });

    const { page } = await getSession(session_id);
    await page.waitForSelector(selector, { timeout: 10000 });

    if (react_compat) {
      // React Hook Form compatible: click → select all → delete → type char by char
      // This fires native input/keydown/keyup events that RHF registers
      await page.click(selector);
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Backspace");
      await page.type(selector, String(text), { delay: 50 });
      // Dispatch native input event + trigger blur for validation
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value"
          ).set;
          nativeInputValueSetter.call(el, el.value);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, selector);
    } else if (clear !== false) {
      // Playwright's fill() clears and sets value — works with React controlled inputs
      await page.fill(selector, String(text));
    } else {
      // Append text without clearing
      await page.type(selector, String(text), { delay: 30 });
    }

    if (press_enter) {
      await page.press(selector, "Enter");
      await page.waitForLoadState("networkidle").catch(() => {});
    }

    res.json({ ok: true, typed: text.length + " chars" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/extract", async (req, res) => {
  try {
    const { selector, session_id, attribute } = req.body;
    if (!selector) return res.status(400).json({ ok: false, error: "selector required" });

    const { page } = await getSession(session_id);

    const results = await page.evaluate(
      ({ sel, attr }) => {
        const elements = document.querySelectorAll(sel);
        return Array.from(elements).map((el) => {
          const result = {
            tag: el.tagName,
            text: el.textContent?.trim().slice(0, 500),
            id: el.id || undefined,
          };
          if (attr) result.attribute = el.getAttribute(attr);
          if (el.tagName === "A") result.href = el.href;
          if (el.tagName === "IMG") result.src = el.src;
          if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") {
            result.value = el.value;
          }
          return result;
        });
      },
      { sel: selector, attr: attribute }
    );

    res.json({ ok: true, count: results.length, elements: results.slice(0, 50) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/evaluate", async (req, res) => {
  try {
    const { script, session_id } = req.body;
    if (!script) return res.status(400).json({ ok: false, error: "script required" });

    const { page } = await getSession(session_id);

    const result = await page.evaluate((code) => {
      try {
        return eval(code);
      } catch (e) {
        return { __error: e.message };
      }
    }, script);

    const screenshot = await takeScreenshot(page);
    res.json({ ok: true, result, screenshot });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Start ---

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[browser] Playwright server listening on 127.0.0.1:${PORT}`);
});

process.on("SIGTERM", async () => {
  console.log("[browser] Shutting down...");
  for (const [id] of sessions) await closeSession(id);
  if (browser) await browser.close();
  process.exit(0);
});
