/**
 * Posting Engine — Automates content posting to social media platforms
 * Uses Puppeteer stealth + Decodo residential proxies
 * Accounts are pre-logged-in via Dolphin Anty (Google SSO or direct)
 *
 * Directive: dir_1775926142812
 */

"use strict";

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const path = require("path");
const fs = require("fs");
const { loadEnv, solveCapSolver } = require("./index");

puppeteer.use(StealthPlugin());

// Human-like delays
async function delay(min = 500, max = 2000) {
  await new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

async function humanType(page, selector, text) {
  await page.click(selector);
  await delay(200, 500);
  for (const char of text) {
    await page.keyboard.type(char, { delay: 40 + Math.random() * 80 });
  }
  await delay(300, 800);
}

// Launch browser with Decodo proxy
async function launchBrowser(proxyPort) {
  const env = loadEnv();

  const browser = await puppeteer.launch({
    headless: false, // Real Chrome on Xvfb
    args: [
      `--proxy-server=http://us.decodo.com:${proxyPort}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1366,768",
    ],
  });

  const page = await browser.newPage();
  await page.authenticate({
    username: env.DECODO_PROXY_USER,
    password: env.DECODO_PROXY_PASS,
  });
  await page.setViewport({ width: 1366, height: 768 });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });

  return { browser, page };
}

// --- Platform Posters ---

async function postToX(page, { text, mediaUrls }) {
  await page.goto("https://x.com/compose/post", { waitUntil: "domcontentloaded", timeout: 30000 });
  await delay(3000, 5000);

  // Check if logged in
  const isLoggedIn = await page.evaluate(() => {
    return !!document.querySelector('[data-testid="tweetTextarea_0"]') ||
           !!document.querySelector('[data-testid="tweetTextarea_0_label"]');
  });
  if (!isLoggedIn) throw new Error("Not logged into X — need to login first");

  // Type the post text
  const textArea = await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
  await textArea.click();
  await delay(300, 600);
  await page.keyboard.type(text, { delay: 30 + Math.random() * 50 });
  await delay(1000, 2000);

  // Upload media if provided
  if (mediaUrls && mediaUrls.length > 0) {
    for (const mediaPath of mediaUrls) {
      if (fs.existsSync(mediaPath)) {
        const fileInput = await page.$('input[data-testid="fileInput"]');
        if (fileInput) {
          await fileInput.uploadFile(mediaPath);
          await delay(3000, 5000); // Wait for upload
        }
      }
    }
  }

  // Click Post button
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
    if (btn) btn.click();
  });
  await delay(3000, 5000);

  return { success: true, platform: "x" };
}

async function postToInstagram(page, { text, mediaUrls }) {
  // Instagram web posting requires at least one image
  if (!mediaUrls || mediaUrls.length === 0) {
    return { success: false, platform: "instagram", error: "Instagram requires at least one image" };
  }

  await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await delay(3000, 5000);

  // Click "New post" (+ icon in nav)
  const createBtn = await page.evaluate(() => {
    // Try SVG-based create button
    const svgs = Array.from(document.querySelectorAll("svg"));
    for (const svg of svgs) {
      const label = svg.closest("[aria-label]");
      if (label && (label.getAttribute("aria-label") === "New post" || label.getAttribute("aria-label") === "New Post")) {
        label.click();
        return true;
      }
    }
    // Try nav link
    const links = Array.from(document.querySelectorAll("a"));
    const create = links.find((l) => l.href?.includes("/create/"));
    if (create) { create.click(); return true; }
    return false;
  });

  if (!createBtn) throw new Error("Could not find Instagram create button — may not be logged in");
  await delay(2000, 3000);

  // Upload file
  const fileInput = await page.$('input[type="file"]');
  if (fileInput && mediaUrls[0] && fs.existsSync(mediaUrls[0])) {
    await fileInput.uploadFile(mediaUrls[0]);
    await delay(3000, 5000);
  }

  // Click Next (crop step)
  for (let step = 0; step < 2; step++) {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, div[role=button]"));
      const next = btns.find((b) => b.textContent.trim() === "Next");
      if (next) next.click();
    });
    await delay(2000, 3000);
  }

  // Type caption
  const captionArea = await page.$('textarea[aria-label="Write a caption..."], div[aria-label="Write a caption..."]');
  if (captionArea) {
    await captionArea.click();
    await delay(300, 500);
    await page.keyboard.type(text || "", { delay: 30 + Math.random() * 50 });
    await delay(1000, 2000);
  }

  // Click Share
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button, div[role=button]"));
    const share = btns.find((b) => b.textContent.trim() === "Share");
    if (share) share.click();
  });
  await delay(5000, 8000);

  return { success: true, platform: "instagram" };
}

async function postToTikTok(page, { text, mediaUrls }) {
  if (!mediaUrls || mediaUrls.length === 0) {
    return { success: false, platform: "tiktok", error: "TikTok requires a video file" };
  }

  // TikTok Creator Studio (web upload)
  await page.goto("https://www.tiktok.com/creator#/upload?scene=creator_center", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await delay(4000, 6000);

  // Upload video via file input
  const fileInput = await page.$('input[type="file"]');
  if (fileInput && mediaUrls[0] && fs.existsSync(mediaUrls[0])) {
    await fileInput.uploadFile(mediaUrls[0]);
    await delay(8000, 12000); // TikTok takes a while to process
  } else {
    throw new Error("Could not find TikTok file input — may not be logged in");
  }

  // Type caption
  const captionEditor = await page.$('div[contenteditable="true"]');
  if (captionEditor) {
    await captionEditor.click();
    // Clear existing text
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await delay(200, 400);
    await page.keyboard.type(text || "", { delay: 30 + Math.random() * 50 });
    await delay(1000, 2000);
  }

  // Click Post button
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const post = btns.find((b) => b.textContent.trim() === "Post" && !b.disabled);
    if (post) post.click();
  });
  await delay(5000, 10000);

  return { success: true, platform: "tiktok" };
}

async function postToYouTube(page, { text, mediaUrls }) {
  if (!mediaUrls || mediaUrls.length === 0) {
    return { success: false, platform: "youtube", error: "YouTube requires a video file" };
  }

  await page.goto("https://studio.youtube.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await delay(4000, 6000);

  // Click Create > Upload videos
  await page.evaluate(() => {
    const btn = document.querySelector("#create-icon, [id=create-icon]");
    if (btn) btn.click();
  });
  await delay(1000, 2000);

  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll("tp-yt-paper-item, ytcp-text-menu-item"));
    const upload = items.find((i) => i.textContent.includes("Upload video"));
    if (upload) upload.click();
  });
  await delay(2000, 3000);

  // Upload file
  const fileInput = await page.$('input[type="file"]');
  if (fileInput && mediaUrls[0] && fs.existsSync(mediaUrls[0])) {
    await fileInput.uploadFile(mediaUrls[0]);
    await delay(5000, 10000);
  }

  // Set title
  const titleInput = await page.$('#textbox[aria-label="Add a title that describes your video"]');
  if (titleInput) {
    await titleInput.click();
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.keyboard.type(text || "New Video", { delay: 30 });
    await delay(1000, 2000);
  }

  // Click through Next steps (Details → Video Elements → Checks → Visibility)
  for (let step = 0; step < 3; step++) {
    await page.evaluate(() => {
      const next = document.querySelector("#next-button");
      if (next) next.click();
    });
    await delay(2000, 3000);
  }

  // Set to Public and click Publish
  await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll("tp-yt-paper-radio-button"));
    const pub = radios.find((r) => r.textContent.includes("Public"));
    if (pub) pub.click();
  });
  await delay(1000, 2000);

  await page.evaluate(() => {
    const done = document.querySelector("#done-button");
    if (done) done.click();
  });
  await delay(5000, 8000);

  return { success: true, platform: "youtube" };
}

async function postToLinkedIn(page, { text, mediaUrls }) {
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await delay(3000, 5000);

  // Click "Start a post"
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const start = btns.find((b) => b.textContent.includes("Start a post"));
    if (start) start.click();
  });
  await delay(2000, 3000);

  // Type in the post editor
  const editor = await page.$('div[role="textbox"][contenteditable="true"]');
  if (editor) {
    await editor.click();
    await delay(300, 500);
    await page.keyboard.type(text || "", { delay: 30 + Math.random() * 50 });
    await delay(1000, 2000);
  }

  // Upload media if provided
  if (mediaUrls && mediaUrls.length > 0 && fs.existsSync(mediaUrls[0])) {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const media = btns.find((b) => b.getAttribute("aria-label")?.includes("Add a photo"));
      if (media) media.click();
    });
    await delay(1000, 2000);
    const fileInput = await page.$('input[type="file"]');
    if (fileInput) {
      await fileInput.uploadFile(mediaUrls[0]);
      await delay(3000, 5000);
    }
  }

  // Click Post
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const post = btns.find((b) => b.textContent.trim() === "Post" && !b.disabled);
    if (post) post.click();
  });
  await delay(3000, 5000);

  return { success: true, platform: "linkedin" };
}

async function postToReddit(page, { text, subreddit }) {
  const targetUrl = subreddit
    ? `https://www.reddit.com/r/${subreddit}/submit`
    : "https://www.reddit.com/submit";

  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await delay(3000, 5000);

  // Reddit's new editor — type in the title and body
  const titleInput = await page.$('textarea[placeholder*="Title"], input[placeholder*="Title"]');
  if (titleInput) {
    const title = text.split("\n")[0].substring(0, 300); // First line as title
    await humanType(page, 'textarea[placeholder*="Title"], input[placeholder*="Title"]', title);
    await delay(500, 1000);
  }

  // Body text
  const bodyEditor = await page.$('div[contenteditable="true"], textarea[placeholder*="body"]');
  if (bodyEditor) {
    await bodyEditor.click();
    await delay(300, 500);
    const body = text.split("\n").slice(1).join("\n");
    await page.keyboard.type(body, { delay: 30 + Math.random() * 50 });
    await delay(1000, 2000);
  }

  // Click Post
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const post = btns.find((b) => b.textContent.trim() === "Post" && !b.disabled);
    if (post) post.click();
  });
  await delay(3000, 5000);

  return { success: true, platform: "reddit" };
}

// --- Main Post Dispatcher ---

const PLATFORM_POSTERS = {
  x: postToX,
  instagram: postToInstagram,
  tiktok: postToTikTok,
  youtube: postToYouTube,
  linkedin: postToLinkedIn,
  reddit: postToReddit,
};

/**
 * Execute a post on a specific platform account
 * @param {object} account - DB row from influence_accounts (with member info)
 * @param {object} content - { text, mediaUrls, hashtags, subreddit }
 * @returns {object} { success, platform, error? }
 */
async function executePost(account, content) {
  const proxyPort = account.proxy_port || 10001;
  const platform = account.platform;
  const poster = PLATFORM_POSTERS[platform];

  if (!poster) throw new Error(`No poster for platform: ${platform}`);

  console.log(`[influence] Posting to ${platform}/@${account.username} via port ${proxyPort}`);

  const { browser, page } = await launchBrowser(proxyPort);

  try {
    // Handle CAPTCHA if it appears during navigation
    page.on("framenavigated", async (frame) => {
      try {
        const url = frame.url();
        if (url.includes("captcha") || url.includes("challenge")) {
          console.log(`[influence] CAPTCHA detected on ${platform}, attempting solve...`);
        }
      } catch {}
    });

    // Append hashtags to text
    let postText = content.text || "";
    if (content.hashtags && content.hashtags.length > 0) {
      postText += "\n\n" + content.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
    }

    const result = await poster(page, {
      text: postText,
      mediaUrls: content.mediaUrls,
      subreddit: content.subreddit,
    });

    // Screenshot for verification
    const screenshotPath = `/tmp/ozzu-bridge/uploads/influence-${platform}-${account.username}-${Date.now()}.png`;
    try {
      await fs.promises.mkdir(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: false });
      result.screenshot = screenshotPath;
    } catch {}

    return result;
  } catch (err) {
    // Screenshot on failure for debugging
    try {
      const errPath = `/tmp/ozzu-bridge/uploads/influence-error-${platform}-${Date.now()}.png`;
      await fs.promises.mkdir(path.dirname(errPath), { recursive: true });
      await page.screenshot({ path: errPath });
    } catch {}
    return { success: false, platform, error: err.message };
  } finally {
    await browser.close();
  }
}

/**
 * Google SSO login — log into Google inside a Dolphin profile
 * Only needs to be done once per member, then cookies persist
 */
async function loginGoogleSSO(proxyPort, email, password) {
  const { browser, page } = await launchBrowser(proxyPort);

  try {
    await page.goto("https://accounts.google.com/signin", { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(3000, 5000);

    // Enter email
    await humanType(page, 'input[type="email"]', email);
    await delay(500, 1000);

    // Click Next
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const next = btns.find((b) => b.textContent.includes("Next") || b.textContent.includes("Siguiente"));
      if (next) next.click();
    });
    await delay(3000, 5000);

    // Enter password
    const pwInput = await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    if (pwInput) {
      await humanType(page, 'input[type="password"]', password);
      await delay(500, 1000);

      // Click Next
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const next = btns.find((b) => b.textContent.includes("Next") || b.textContent.includes("Siguiente"));
        if (next) next.click();
      });
      await delay(5000, 8000);
    }

    // Check for 2FA or security challenge
    const currentUrl = page.url();
    if (currentUrl.includes("challenge") || currentUrl.includes("signin/v2")) {
      const screenshotPath = `/tmp/ozzu-bridge/uploads/google-2fa-${Date.now()}.png`;
      await fs.promises.mkdir(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath });
      return {
        success: false,
        needs2FA: true,
        screenshot: screenshotPath,
        message: "Google is asking for 2FA verification — screenshot saved",
      };
    }

    // Check if we made it to myaccount
    const finalUrl = page.url();
    const loggedIn = finalUrl.includes("myaccount") || finalUrl.includes("google.com");

    return {
      success: loggedIn,
      finalUrl,
      message: loggedIn ? "Google login successful" : "Login may have failed — check screenshot",
    };
  } finally {
    await browser.close();
  }
}

module.exports = {
  executePost,
  loginGoogleSSO,
  launchBrowser,
  PLATFORM_POSTERS,
};
