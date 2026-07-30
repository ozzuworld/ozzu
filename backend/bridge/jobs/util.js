"use strict";

// Shared helpers for the Jobs sources (dir_1785424018953): HTTP JSON fetch, HTML→text,
// numeric/string coercion, stable id hashing, and unix→Date.

const https = require("https");
const crypto = require("crypto");

function fetchJSON(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { "User-Agent": "Mozilla/5.0 (ozzu-jobs/1.0)", Accept: "application/json", ...(opts.headers || {}) };
    const req = https.get(url, { headers, timeout: opts.timeout || 30000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${String(data).slice(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`bad JSON: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

const num = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null; // treat 0 (RemoteOK "unknown") as null
};
const str = (v) => (v === undefined || v === null || v === "" ? null : String(v).trim());

// HTML → plain text (bounded). Enough for an excerpt/search; not a full sanitizer.
function stripHtml(html, max = 400) {
  if (!html) return null;
  const t = String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

// Short, stable, URL-safe id from an opaque key (Himalayas' guid is a full URL).
const sha1short = (s, n = 16) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, n);

// Unix seconds (or ms) → ISO string, or null.
function tsToDate(v) {
  if (v === undefined || v === null || v === "") return null;
  let n = Number(v);
  if (!Number.isFinite(n)) { const d = new Date(v); return isNaN(d) ? null : d.toISOString(); }
  if (n < 1e12) n *= 1000; // seconds → ms
  const d = new Date(n);
  return isNaN(d) ? null : d.toISOString();
}

module.exports = { fetchJSON, num, str, stripHtml, sha1short, tsToDate };
