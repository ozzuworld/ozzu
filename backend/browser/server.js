const express = require("express");
const puppeteer = require("puppeteer-core");

const PORT = parseInt(process.env.BROWSER_PORT || "3334", 10);
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min idle timeout
const SCREENSHOT_DIR = "/tmp/browser-data";

const app = express();
app.use(express.json({ limit: "10mb" }));

// --- Session management ---

const sessions = new Map(); // id -> { page, browser, lastUsed, timer }

async function launchBrowser() {
  return puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--window-size=1280,900",
    ],
  });
}

async function getSession(sessionId = "default") {
  let session = sessions.get(sessionId);
  if (session) {
    // Reset idle timer
    clearTimeout(session.timer);
    session.timer = setTimeout(() => closeSession(sessionId), SESSION_TIMEOUT_MS);
    session.lastUsed = Date.now();
    // Check if page is still alive
    try {
      await session.page.title();
      return session;
    } catch {
      // Page closed or crashed — recreate
      sessions.delete(sessionId);
    }
  }

  // Create new session
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );

  const timer = setTimeout(() => closeSession(sessionId), SESSION_TIMEOUT_MS);
  session = { page, browser, lastUsed: Date.now(), timer };
  sessions.set(sessionId, session);
  console.log(`[browser] Session "${sessionId}" created`);
  return session;
}

async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  clearTimeout(session.timer);
  try {
    await session.browser.close();
  } catch {}
  sessions.delete(sessionId);
  console.log(`[browser] Session "${sessionId}" closed`);
  return true;
}

async function takeScreenshot(page, fullPage = false) {
  const buf = await page.screenshot({ fullPage, encoding: "base64" });
  return buf;
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
    const { session_id } = req.body;
    const id = session_id || `session_${Date.now()}`;
    if (sessions.has(id)) {
      return res.json({ ok: true, session_id: id, message: "Session already exists" });
    }
    await getSession(id);
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
      waitUntil: wait_for || "networkidle2",
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
    const { selector, session_id, wait_after } = req.body;
    if (!selector) return res.status(400).json({ ok: false, error: "selector required" });

    const { page } = await getSession(session_id);

    // Wait for element to appear
    await page.waitForSelector(selector, { timeout: 10000 });
    const element = await page.$(selector);
    if (!element) return res.json({ ok: false, error: `Element not found: ${selector}` });

    // Get element info before click
    const info = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return { tag: el.tagName, text: el.textContent?.trim().slice(0, 100), id: el.id, className: el.className };
    }, selector);

    await element.click();

    // Optional wait after click (for navigation/AJAX)
    if (wait_after === "navigation") {
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});
    } else if (wait_after === "idle") {
      await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
    } else if (typeof wait_after === "number") {
      await new Promise((r) => setTimeout(r, wait_after));
    }

    const screenshot = await takeScreenshot(page);
    res.json({ ok: true, clicked: info, screenshot });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/type", async (req, res) => {
  try {
    const { selector, text, session_id, clear, press_enter } = req.body;
    if (!selector) return res.status(400).json({ ok: false, error: "selector required" });
    if (text === undefined) return res.status(400).json({ ok: false, error: "text required" });

    const { page } = await getSession(session_id);
    await page.waitForSelector(selector, { timeout: 10000 });

    if (clear !== false) {
      // Clear existing content first (triple-click to select all, then type over)
      await page.click(selector, { clickCount: 3 });
    }

    await page.type(selector, String(text), { delay: 30 });

    if (press_enter) {
      await page.keyboard.press("Enter");
      await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
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
      (sel, attr) => {
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
      selector,
      attribute
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

    // Evaluate in page context
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
  console.log(`[browser] Server listening on 127.0.0.1:${PORT}`);
});

// Cleanup on exit
process.on("SIGTERM", async () => {
  console.log("[browser] Shutting down...");
  for (const [id] of sessions) await closeSession(id);
  process.exit(0);
});
