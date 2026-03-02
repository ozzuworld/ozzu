// Colombian OSINT utilities — cédula/NIT validation, shared HTTP helpers

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
 * Safe fetch with timeout, returns { ok, status, body } or { ok: false, error }
 */
async function safeFetch(url, options = {}, timeoutMs = 15000) {
  try {
    const res = await fetch(url, {
      ...options,
      headers: { ...CO_HEADERS, ...(options.headers || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = res.headers.get("content-type") || "";
    let body;
    if (contentType.includes("json")) {
      body = await res.json();
    } else {
      body = await res.text();
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, error: err.message, body: null };
  }
}

module.exports = {
  validateCedula,
  validateNIT,
  calculateVerificationDigit,
  formatCOP,
  CO_HEADERS,
  safeFetch,
};
