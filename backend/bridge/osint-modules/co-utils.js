// Colombian OSINT utilities — cédula/NIT validation, shared HTTP helpers
const https = require("https");
const http = require("http");

/**
 * Validate Colombian cédula de ciudadanía
 * Valid: 6-11 digits (most are 8-10)
 */
function validateCedula(value) {
  const clean = String(value).replace(/[\s.-]/g, "");
  if (!/^\d{6,11}$/.test(clean)) return null;
  return clean;
}

/**
 * Validate Colombian NIT (Número de Identificación Tributaria)
 * Format: 9 digits + optional verification digit (e.g., 899999068-1)
 */
function validateNIT(value) {
  const clean = String(value).replace(/[\s.]/g, "").replace(/-/g, "-");
  const match = clean.match(/^(\d{9})(?:-?(\d))?$/);
  if (!match) return null;
  const nit = match[1];
  const dv = match[2] ? parseInt(match[2], 10) : null;
  if (dv !== null) {
    const expected = calculateVerificationDigit(nit);
    if (dv !== expected) return null; // Invalid check digit
  }
  return nit;
}

/**
 * Calculate NIT verification digit using DIAN module-11 algorithm
 */
function calculateVerificationDigit(nit) {
  const weights = [71, 67, 59, 53, 47, 43, 41, 37, 29, 23, 19, 17, 13, 7, 3];
  const digits = String(nit).padStart(15, "0").split("").map(Number);
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    sum += digits[i] * weights[i];
  }
  const remainder = sum % 11;
  if (remainder === 0) return 0;
  if (remainder === 1) return 1;
  return 11 - remainder;
}

/**
 * Format COP (Colombian Peso) amount
 */
function formatCOP(amount) {
  const num = Number(amount);
  if (isNaN(num)) return "$0 COP";
  return "$" + num.toLocaleString("es-CO") + " COP";
}

/**
 * Common HTTP headers to mimic Colombian browser requests
 */
const CO_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept-Language": "es-CO,es;q=0.9,en;q=0.8",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

/**
 * Safe fetch with timeout, returns { ok, status, body, headers } or { ok: false, error }
 */
async function safeFetch(url, options = {}, timeoutMs = 15000) {
  try {
    const fetchOpts = {
      ...options,
      headers: { ...CO_HEADERS, ...(options.headers || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    };
    // Skip SSL verification for Colombian gov sites with cert issues
    if (options.rejectUnauthorized === false) {
      fetchOpts.dispatcher = undefined; // Node 18+ handles this differently
    }
    const res = await fetch(url, fetchOpts);
    const contentType = res.headers.get("content-type") || "";
    let body;
    if (contentType.includes("json")) {
      body = await res.json();
    } else {
      body = await res.text();
    }
    // Extract cookies from set-cookie header
    const setCookie = res.headers.get("set-cookie") || "";
    const cookies = setCookie.split(",").map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");
    return { ok: res.ok, status: res.status, body, headers: res.headers, cookies };
  } catch (err) {
    return { ok: false, status: 0, error: err.message, body: null, headers: null, cookies: "" };
  }
}

/**
 * Insecure HTTPS fetch — uses https.request with rejectUnauthorized:false
 * For Colombian gov sites with bad SSL certs (Contraloría, DIAN MUISCA)
 * Returns same shape as safeFetch: { ok, status, body, headers, cookies }
 */
async function insecureFetch(url, options = {}, timeoutMs = 15000) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === "https:";
      const mod = isHttps ? https : http;
      const mergedHeaders = { ...CO_HEADERS, ...(options.headers || {}) };

      const reqOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: mergedHeaders,
        rejectUnauthorized: false,
        timeout: timeoutMs,
      };

      const req = mod.request(reqOptions, (res) => {
        // Follow redirects (up to 3)
        if ([301, 302, 303, 307].includes(res.statusCode) && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).href;
          res.resume();
          return insecureFetch(redirectUrl, { ...options, method: "GET", body: undefined }, timeoutMs)
            .then(resolve);
        }

        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const contentType = res.headers["content-type"] || "";
          let body;
          if (contentType.includes("json")) {
            try { body = JSON.parse(data); } catch { body = data; }
          } else {
            body = data;
          }
          const setCookie = (res.headers["set-cookie"] || [])
            .map((c) => c.split(";")[0].trim())
            .filter(Boolean)
            .join("; ");
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            status: res.statusCode,
            body,
            headers: res.headers,
            cookies: setCookie,
          });
        });
      });

      req.on("error", (err) => {
        resolve({ ok: false, status: 0, error: err.message, body: null, headers: null, cookies: "" });
      });
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, status: 0, error: "timeout", body: null, headers: null, cookies: "" });
      });

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    } catch (err) {
      resolve({ ok: false, status: 0, error: err.message, body: null, headers: null, cookies: "" });
    }
  });
}

/**
 * Extract ASPX ViewState fields from HTML
 */
function extractAspxFields(html) {
  const fields = {};
  const patterns = {
    __VIEWSTATE: /__VIEWSTATE[^G][^>]*value="([^"]*)"/,
    __VIEWSTATEGENERATOR: /__VIEWSTATEGENERATOR[^>]*value="([^"]*)"/,
    __EVENTVALIDATION: /__EVENTVALIDATION[^>]*value="([^"]*)"/,
  };
  for (const [key, pattern] of Object.entries(patterns)) {
    const match = html.match(pattern);
    if (match) fields[key] = match[1];
  }
  return fields;
}

module.exports = {
  validateCedula,
  validateNIT,
  calculateVerificationDigit,
  formatCOP,
  CO_HEADERS,
  safeFetch,
  insecureFetch,
  extractAspxFields,
};
