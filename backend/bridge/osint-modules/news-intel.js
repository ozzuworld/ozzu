// News Intelligence Module — Google News RSS + web search for news mentions
// Extracts: recent articles, headlines, publication dates, sources
// FREE, no API key needed

let parseStringPromise;
try { parseStringPromise = require("xml2js").parseStringPromise; } catch { parseStringPromise = null; }

const BROWSER_API = "http://127.0.0.1:3334";

async function safeFetchText(url, timeout = 10000) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; OzzuIntel/1.0)" },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

async function browserFetch(endpoint, body, timeout = 25000) {
  try {
    const res = await fetch(`${BROWSER_API}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

module.exports = {
  name: "news-intel",
  profileTypes: ["name", "username"],

  async scan(profile) {
    const findings = [];
    const query = profile.value || profile.label;
    if (!query || query.length < 2) return findings;

    const allArticles = [];

    // 1. Google News RSS (completely free, no API key)
    try {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
      const rssText = await safeFetchText(rssUrl, 15000);
      if (rssText) {
        let parsed;
        if (parseStringPromise) {
          try { parsed = await parseStringPromise(rssText, { explicitArray: false }); } catch { parsed = parseRssManually(rssText); }
        } else {
          parsed = parseRssManually(rssText);
        }

        const items = parsed?.rss?.channel?.item;
        const articleList = Array.isArray(items) ? items : items ? [items] : [];

        for (const item of articleList.slice(0, 30)) {
          const title = item.title || "";
          const link = item.link || "";
          const pubDate = item.pubDate || "";
          const source = item.source?._ || item.source || "";

          allArticles.push({
            title: title.substring(0, 300),
            url: link,
            publishedAt: pubDate,
            source: typeof source === "string" ? source : source?.toString() || "",
            engine: "google_news",
          });
        }
      }
    } catch (err) {
      console.error("[news-intel] Google News RSS error:", err.message);
    }

    // 2. Bing News (via browser with proxy for better results)
    try {
      const sessionId = `news-${Date.now()}`;
      const bingUrl = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&FORM=HDRSC6`;

      // Create proxy session for residential IP
      const proxy = process.env.RESIDENTIAL_PROXY || "socks5://127.0.0.1:1080";
      await browserFetch("/session/new", { session_id: sessionId, proxy }, 15000);

      const nav = await browserFetch("/navigate", { url: bingUrl, session_id: sessionId }, 30000);
      if (nav?.ok) {
        await new Promise(r => setTimeout(r, 3000));

        const extract = await browserFetch("/evaluate", {
          session_id: sessionId,
          script: `(() => {
            var results = [];
            document.querySelectorAll('.news-card, .newsitem, [data-id]').forEach(function(card) {
              var a = card.querySelector('a.title, a[href]');
              var time = card.querySelector('.source span, time, .news_dt');
              var src = card.querySelector('.source a, .source .provider');
              if (a && a.href) {
                results.push({
                  title: a.textContent.trim().substring(0, 300),
                  url: a.href,
                  publishedAt: time ? time.textContent.trim() : '',
                  source: src ? src.textContent.trim() : ''
                });
              }
            });
            return JSON.stringify(results.slice(0, 20));
          })()`,
        }, 15000);

        if (extract?.result) {
          try {
            const parsed = JSON.parse(extract.result);
            allArticles.push(...parsed.map(a => ({ ...a, engine: "bing_news" })));
          } catch {}
        }
      }

      await browserFetch("/session/close", { session_id: sessionId });
    } catch (err) {
      console.error("[news-intel] Bing News error:", err.message);
    }

    // 3. Deduplicate by title similarity
    const seen = new Set();
    const unique = [];
    for (const article of allArticles) {
      const key = article.title.toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 50);
      if (!seen.has(key) && key.length > 10) {
        seen.add(key);
        unique.push(article);
      }
    }

    if (unique.length === 0) {
      findings.push({
        category: "intelligence",
        severity: "info",
        title: `News: no articles found for "${query}"`,
        rawData: { type: "news_miss", query },
      });
      return findings;
    }

    // 4. Analyze articles
    const recentArticles = unique.slice(0, 50);
    const sources = [...new Set(recentArticles.map(a => a.source).filter(Boolean))];

    // Categorize by recency
    const now = Date.now();
    const last24h = recentArticles.filter(a => {
      try { return (now - new Date(a.publishedAt).getTime()) < 86400000; } catch { return false; }
    });
    const lastWeek = recentArticles.filter(a => {
      try { return (now - new Date(a.publishedAt).getTime()) < 604800000; } catch { return false; }
    });

    findings.push({
      category: "intelligence",
      severity: recentArticles.length > 10 ? "high" : "medium",
      title: `News: ${recentArticles.length} articles found — ${sources.length} sources`,
      description: [
        `Last 24h: ${last24h.length} articles`,
        `Last 7 days: ${lastWeek.length} articles`,
        `Sources: ${sources.slice(0, 10).join(", ")}`,
        "",
        "Recent headlines:",
        ...recentArticles.slice(0, 5).map(a => `• ${a.title}`),
      ].join("\n"),
      rawData: {
        type: "news_coverage",
        query,
        totalArticles: recentArticles.length,
        last24h: last24h.length,
        lastWeek: lastWeek.length,
        sources,
        articles: recentArticles,
      },
    });

    return findings;
  },
};

// Fallback RSS parser when xml2js isn't available
function parseRssManually(xml) {
  const items = [];
  const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const itemXml of itemMatches) {
    const title = itemXml.match(/<title>(.*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1") || "";
    const link = itemXml.match(/<link>(.*?)<\/link>/)?.[1] || "";
    const pubDate = itemXml.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || "";
    const source = itemXml.match(/<source[^>]*>(.*?)<\/source>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1") || "";
    items.push({ title, link, pubDate, source });
  }
  return { rss: { channel: { item: items } } };
}
