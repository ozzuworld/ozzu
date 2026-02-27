// Leak search module — searches IntelligenceX for leaked data
const https = require("https");

const INTELX_API = "2.intelx.io";
const INTELX_FREE_KEY = "9df61df0-84f7-4dc7-b34c-8ccfb8646571";

module.exports = {
  name: "leak-search",
  profileTypes: ["email", "username"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const value = profile.value;
    const apiKey = process.env.INTELX_API_KEY || INTELX_FREE_KEY;

    const release = await rateLimiter.acquire();
    try {
      // Step 1: Initiate search
      const searchResult = await intelxPost("/intelligent/search", {
        term: value,
        maxresults: 10,
        media: 0,
        sort: 2,
        terminate: [],
      }, apiKey);

      if (!searchResult || !searchResult.id) {
        findings.push({
          category: "breach",
          severity: "info",
          title: `IntelX: Could not search for "${value}"`,
          description: "IntelligenceX search failed. Free tier may be rate-limited.",
          rawData: { value, error: "no_search_id", tool: "leak-search" },
        });
        return findings;
      }

      // Step 2: Wait and fetch results
      await sleep(3000);
      const results = await intelxGet(`/intelligent/search/result?id=${searchResult.id}&limit=10`, apiKey);

      if (!results || !results.records || results.records.length === 0) {
        findings.push({
          category: "breach",
          severity: "info",
          title: `IntelX: No leaked data found for "${value}"`,
          description: "No matches in IntelligenceX database (Tor, I2P, data leaks, paste sites).",
          rawData: { value, source: "intelx", totalResults: 0, tool: "leak-search" },
        });
        return findings;
      }

      const leaks = [];
      const pastes = [];
      const darknet = [];
      const other = [];

      for (const record of results.records) {
        const bucket = (record.bucket || "").toLowerCase();
        const item = {
          name: record.name || record.systemid || "Unknown",
          bucket: record.bucket,
          date: record.date,
          size: record.size,
          media: record.media,
        };

        if (bucket.includes("leak") || bucket.includes("breach") || bucket.includes("database")) leaks.push(item);
        else if (bucket.includes("paste") || bucket.includes("pastbin") || bucket.includes("ghostbin")) pastes.push(item);
        else if (bucket.includes("tor") || bucket.includes("i2p") || bucket.includes("darknet")) darknet.push(item);
        else other.push(item);
      }

      if (leaks.length > 0) {
        findings.push({
          category: "breach",
          severity: "critical",
          title: `"${value}" found in ${leaks.length} leaked database${leaks.length > 1 ? "s" : ""}`,
          description: leaks.slice(0, 5).map((l) => `${l.name} (${l.date ? new Date(l.date).toISOString().slice(0, 10) : "unknown date"})`).join("\n"),
          rawData: { leaks: leaks.slice(0, 10), value, source: "intelx", tool: "leak-search" },
          remediation: "Your data appears in leaked databases. Change passwords, enable 2FA, use a password manager.",
        });
      }

      if (pastes.length > 0) {
        findings.push({
          category: "breach",
          severity: "high",
          title: `"${value}" found in ${pastes.length} paste site${pastes.length > 1 ? "s" : ""}`,
          description: pastes.slice(0, 5).map((p) => `${p.name} (${p.date ? new Date(p.date).toISOString().slice(0, 10) : "unknown date"})`).join("\n"),
          rawData: { pastes: pastes.slice(0, 10), value, source: "intelx", tool: "leak-search" },
          remediation: "Your information was found on paste sites (Pastebin, etc.).",
        });
      }

      if (darknet.length > 0) {
        findings.push({
          category: "breach",
          severity: "medium",
          title: `"${value}" found in ${darknet.length} dark web source${darknet.length > 1 ? "s" : ""}`,
          description: darknet.slice(0, 5).map((d) => `${d.name} (${d.bucket})`).join("\n"),
          rawData: { darknet: darknet.slice(0, 10), value, source: "intelx", tool: "leak-search" },
        });
      }

      if (other.length > 0) {
        findings.push({
          category: "breach",
          severity: "medium",
          title: `"${value}" found in ${other.length} additional source${other.length > 1 ? "s" : ""}`,
          description: other.slice(0, 5).map((o) => `${o.name} (${o.bucket || "unknown"})`).join("\n"),
          rawData: { other: other.slice(0, 10), value, source: "intelx", tool: "leak-search" },
        });
      }
    } catch (err) {
      if (err.message.includes("402") || err.message.includes("429")) {
        findings.push({
          category: "breach",
          severity: "info",
          title: "IntelX: Free tier quota exceeded",
          description: "IntelligenceX free API quota reached. Results available after quota reset.",
          rawData: { value, error: "quota_exceeded", tool: "leak-search" },
        });
      } else {
        findings.push({
          category: "breach",
          severity: "info",
          title: `IntelX search error: ${err.message}`,
          description: `Failed to search IntelligenceX for "${value}".`,
          rawData: { error: err.message, value, tool: "leak-search" },
        });
      }
    } finally {
      release();
    }

    return findings;
  },
};

function intelxPost(path, body, apiKey) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: INTELX_API, path, method: "POST",
      headers: { "Content-Type": "application/json", "x-key": apiKey, "Content-Length": Buffer.byteLength(data) },
      timeout: 10000,
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 400) { reject(new Error(`IntelX API error: ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("IntelX request timed out")); });
    req.write(data);
    req.end();
  });
}

function intelxGet(path, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: INTELX_API, path, headers: { "x-key": apiKey }, timeout: 10000,
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 400) { reject(new Error(`IntelX API error: ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("IntelX request timed out")); });
  });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
