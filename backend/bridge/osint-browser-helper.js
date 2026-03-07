// OSINT Browser Helper — wraps the browser container (Playwright) for OSINT module use
// Browser container runs at http://127.0.0.1:3334 with stealth mode
const BROWSER_API = "http://127.0.0.1:3334";

async function browserFetch(endpoint, body, timeout = 15000) {
  const res = await fetch(`${BROWSER_API}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "unknown error");
    throw new Error(`Browser ${endpoint} failed: ${res.status} — ${err}`);
  }
  return await res.json();
}

async function isAvailable() {
  try {
    const res = await fetch(`${BROWSER_API}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Navigate to URL and wait for page load
async function navigate(sessionId, url, waitFor = "domcontentloaded") {
  return browserFetch("/navigate", { session_id: sessionId, url, wait_for: waitFor }, 30000);
}

// Type text into an input field
async function type(sessionId, selector, text, options = {}) {
  return browserFetch("/type", {
    session_id: sessionId,
    selector,
    text,
    clear: options.clear !== false,
    press_enter: options.pressEnter || false,
    react_compat: options.reactCompat || false,
  });
}

// Click an element
async function click(sessionId, selector, options = {}) {
  return browserFetch("/click", {
    session_id: sessionId,
    selector,
    wait_after: options.waitAfter || "idle",
  }, 20000);
}

// Extract text/attributes from elements matching a selector
async function extract(sessionId, selector, attribute) {
  return browserFetch("/extract", {
    session_id: sessionId,
    selector,
    attribute: attribute || undefined,
  });
}

// Run arbitrary JS in the page context
async function evaluate(sessionId, code) {
  return browserFetch("/evaluate", { session_id: sessionId, code }, 15000);
}

// Take a screenshot (returns base64 PNG)
async function screenshot(sessionId) {
  return browserFetch("/screenshot", { session_id: sessionId }, 10000);
}

// Close a session
async function closeSession(sessionId) {
  try {
    return await browserFetch("/session/close", { session_id: sessionId }, 5000);
  } catch {
    // Ignore close errors
  }
}

// High-level: navigate to form, fill fields, submit, extract result
async function fillAndSubmitForm(sessionId, url, fields, submitSelector, resultSelector, options = {}) {
  await navigate(sessionId, url, options.waitFor || "domcontentloaded");

  // Fill each field
  for (const field of fields) {
    await type(sessionId, field.selector, field.value, { clear: true });
  }

  // Click submit
  await click(sessionId, submitSelector, { waitAfter: options.waitAfter || "idle" });

  // Extract result
  if (resultSelector) {
    return await extract(sessionId, resultSelector);
  }

  // Return page HTML via evaluate
  return await evaluate(sessionId, "document.body.innerHTML");
}

// Extract ASPX hidden fields (__VIEWSTATE etc) from current page
async function extractAspxFields(sessionId) {
  const result = await evaluate(sessionId, `
    const fields = {};
    for (const input of document.querySelectorAll('input[type="hidden"]')) {
      if (input.name && input.name.startsWith('__')) {
        fields[input.name] = input.value;
      }
    }
    JSON.stringify(fields);
  `);
  try {
    return JSON.parse(result.result || "{}");
  } catch {
    return {};
  }
}

// Check if current page has a captcha
async function detectCaptcha(sessionId) {
  const result = await evaluate(sessionId, `
    const html = document.body.innerHTML.toLowerCase();
    JSON.stringify({
      hasRecaptcha: html.includes('recaptcha') || !!document.querySelector('.g-recaptcha, [data-sitekey]'),
      hasCaptchaImage: !!document.querySelector('img[src*="captcha"], img[alt*="captcha"]'),
      hasCaptchaText: html.includes('captcha'),
      hasSecurityQuestion: html.includes('pregunta') || html.includes('security question'),
    });
  `);
  try {
    return JSON.parse(result.result || "{}");
  } catch {
    return { hasRecaptcha: false, hasCaptchaImage: false, hasCaptchaText: false, hasSecurityQuestion: false };
  }
}

module.exports = {
  isAvailable,
  navigate,
  type,
  click,
  extract,
  evaluate,
  screenshot,
  closeSession,
  fillAndSubmitForm,
  extractAspxFields,
  detectCaptcha,
  BROWSER_API,
};
