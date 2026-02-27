// Dark web search module — searches Ahmia.fi clearnet gateway for .onion references
const https = require("https");

module.exports = {
  name: "darkweb-search",
  profileTypes: ["email", "username", "domain", "phone"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const value = profile.value;

    const release = await rateLimiter.acquire();
    try {
      await sleep(5000); // Rate limit: 1 req per 5s

      const html = await fetchHtml(
        `https://ahmia.fi/search/?q=${encodeURIComponent(value)}`,
        15000
      );

      if (!html || html.length === 0) {
        findings.push({
          category: "exposure",
          severity: "info",
          title: `Dark web: No results for "${value}"`,
          description: "No dark web presence detected via Ahmia.fi.",
          rawData: { value, source: "ahmia", tool: "darkweb-search" },
        });
        return findings;
      }

      const results = parseAhmiaResults(html);

      if (results.length === 0) {
        findings.push({
          category: "exposure",
          severity: "info",
          title: `Dark web: No mentions of "${value}" found`,
          description: "Ahmia.fi search returned no matching .onion pages. This is a positive indicator.",
          rawData: { value, source: "ahmia", totalResults: 0, tool: "darkweb-search" },
        });
        return findings;
      }

      // Classify results
      const marketplaces = [];
      const forums = [];
      const pastes = [];
      const other = [];

      const marketKeywords = ["market", "shop", "store", "vendor", "listing", "buy", "sell"];
      const forumKeywords = ["forum", "board", "thread", "discuss", "community", "chat"];
      const pasteKeywords = ["paste", "bin", "leak", "dump", "exposed", "database"];

      for (const r of results) {
        const text = `${r.title} ${r.snippet}`.toLowerCase();
        if (marketKeywords.some((k) => text.includes(k))) marketplaces.push(r);
        else if (pasteKeywords.some((k) => text.includes(k))) pastes.push(r);
        else if (forumKeywords.some((k) => text.includes(k))) forums.push(r);
        else other.push(r);
      }

      if (marketplaces.length > 0 || pastes.length > 0) {
        findings.push({
          category: "exposure",
          severity: "critical",
          title: `"${value}" found on dark web marketplace/paste site`,
          description: [...marketplaces, ...pastes].slice(0, 5).map((r) => `${r.title}\n  ${r.snippet}`).join("\n\n"),
          rawData: { marketplaces: marketplaces.slice(0, 10), pastes: pastes.slice(0, 10), value, source: "ahmia", tool: "darkweb-search" },
          remediation: "Your information appears on dark web sites. Change passwords, enable 2FA, monitor financial accounts.",
        });
      }

      if (forums.length > 0) {
        findings.push({
          category: "exposure",
          severity: "high",
          title: `"${value}" mentioned in ${forums.length} dark web forum${forums.length > 1 ? "s" : ""}`,
          description: forums.slice(0, 5).map((r) => `${r.title}\n  ${r.snippet}`).join("\n\n"),
          rawData: { forums: forums.slice(0, 10), value, source: "ahmia", tool: "darkweb-search" },
          remediation: "Your information is discussed on dark web forums. Enable 2FA everywhere.",
        });
      }

      if (other.length > 0) {
        findings.push({
          category: "exposure",
          severity: "medium",
          title: `${other.length} dark web reference${other.length > 1 ? "s" : ""} found for "${value}"`,
          description: other.slice(0, 5).map((r) => `${r.title}\n  ${r.snippet}`).join("\n\n"),
          rawData: { results: other.slice(0, 10), value, source: "ahmia", tool: "darkweb-search" },
        });
      }
    } catch (err) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: `Dark web search error: ${err.message}`,
        description: `Failed to search Ahmia.fi for "${value}".`,
        rawData: { error: err.message, value, tool: "darkweb-search" },
      });
    } finally {
      release();
    }

    return findings;
  },
};

function parseAhmiaResults(html) {
  const results = [];
  const resultBlocks = html.split(/class="result"/i);
  for (let i = 1; i < resultBlocks.length && i <= 20; i++) {
    const block = resultBlocks[i];
    const titleMatch = block.match(/<h4[^>]*>(.*?)<\/h4>/s) || block.match(/<a[^>]*>(.*?)<\/a>/s);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "Untitled";
    const urlMatch = block.match(/href="([^"]*\.onion[^"]*)"/i) || block.match(/redirect_url=([^&"]+)/i);
    const url = urlMatch ? decodeURIComponent(urlMatch[1]) : null;
    const snippetMatch = block.match(/<p[^>]*>(.*?)<\/p>/s);
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim().slice(0, 300) : "";
    if (title || snippet) results.push({ title, url, snippet, source: "ahmia" });
  }
  return results;
}

function fetchHtml(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout, headers: { "User-Agent": "Mozilla/5.0 OSINT Scanner" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) { resolve(""); return; }
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Ahmia request timed out")); });
  });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
