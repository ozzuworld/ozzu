// anthropic-usage.js — Anthropic Admin Usage & Cost API client
// Fetches organization-level token usage and cost data from the Anthropic Admin API
// Requires ANTHROPIC_ADMIN_KEY env var (sk-ant-admin-...) — graceful fallback if missing

const https = require("https");

const ADMIN_KEY = process.env.ANTHROPIC_ADMIN_KEY || "";
const API_BASE = "https://api.anthropic.com/v1/organizations";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// In-memory cache
const _cache = {
  daily: { data: null, fetchedAt: 0 },
  hourly: { data: null, fetchedAt: 0 },
  costs: { data: null, fetchedAt: 0 },
};

// Last seen rate limit headers
let _rateLimits = null;

function isConfigured() {
  return ADMIN_KEY.startsWith("sk-ant-admin");
}

function _fetch(urlPath) {
  return new Promise((resolve, reject) => {
    if (!isConfigured()) {
      return resolve(null);
    }

    const url = new URL(`${API_BASE}${urlPath}`);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        "x-api-key": ADMIN_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    };

    const req = https.request(opts, (res) => {
      let body = "";
      res.on("data", (d) => body += d);
      res.on("end", () => {
        // Capture rate limit headers
        _rateLimits = {
          requestsLimit: parseInt(res.headers["x-ratelimit-limit-requests"] || "0", 10),
          requestsRemaining: parseInt(res.headers["x-ratelimit-remaining-requests"] || "0", 10),
          requestsReset: res.headers["x-ratelimit-reset-requests"] || "",
          tokensLimit: parseInt(res.headers["x-ratelimit-limit-tokens"] || "0", 10),
          tokensRemaining: parseInt(res.headers["x-ratelimit-remaining-tokens"] || "0", 10),
          tokensReset: res.headers["x-ratelimit-reset-tokens"] || "",
        };

        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        } else {
          reject(new Error(`Admin API ${res.statusCode}: ${body.substring(0, 200)}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error("Admin API timeout"));
    });
    req.end();
  });
}

function _cached(key, fetchFn) {
  return async function () {
    const entry = _cache[key];
    if (entry.data && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
      return entry.data;
    }
    try {
      const data = await fetchFn();
      entry.data = data;
      entry.fetchedAt = Date.now();
      return data;
    } catch (err) {
      console.error(`[anthropic-usage] ${key} fetch error: ${err.message}`);
      return entry.data; // Return stale data on error
    }
  };
}

// Fetch daily token usage (last N days, grouped by model)
const fetchDailyUsage = _cached("daily", async () => {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 7);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = now.toISOString().slice(0, 10);

  const data = await _fetch(
    `/usage_report/messages?bucket_width=1d&start_date=${startStr}&end_date=${endStr}&group_by=model`
  );
  if (!data) return null;

  // Normalize the response into a consistent format
  return (data.data || []).map((bucket) => ({
    date: bucket.bucket_start_time ? bucket.bucket_start_time.slice(0, 10) : "",
    model: bucket.model || "unknown",
    inputTokens: bucket.input_tokens || 0,
    outputTokens: bucket.output_tokens || 0,
    cacheReadTokens: bucket.cache_read_input_tokens || 0,
    cacheCreationTokens: bucket.cache_creation_input_tokens || 0,
  }));
});

// Fetch hourly token usage (last 24 hours)
const fetchHourlyUsage = _cached("hourly", async () => {
  const now = new Date();
  const start = new Date(now);
  start.setHours(start.getHours() - 24);
  const startStr = start.toISOString();
  const endStr = now.toISOString();

  const data = await _fetch(
    `/usage_report/messages?bucket_width=1h&start_date=${startStr}&end_date=${endStr}`
  );
  if (!data) return null;

  return (data.data || []).map((bucket) => ({
    hour: bucket.bucket_start_time || "",
    inputTokens: bucket.input_tokens || 0,
    outputTokens: bucket.output_tokens || 0,
  }));
});

// Fetch cost report (last 7 days)
const fetchCostReport = _cached("costs", async () => {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 7);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = now.toISOString().slice(0, 10);

  const data = await _fetch(
    `/cost_report?start_date=${startStr}&end_date=${endStr}`
  );
  if (!data) return null;

  return (data.data || []).map((entry) => ({
    date: entry.bucket_start_time ? entry.bucket_start_time.slice(0, 10) : "",
    amountCents: entry.amount_cents || 0,
    description: entry.description || "",
  }));
});

function getRateLimits() {
  return _rateLimits;
}

module.exports = {
  isConfigured,
  fetchDailyUsage,
  fetchHourlyUsage,
  fetchCostReport,
  getRateLimits,
};
