// Telegram Intelligence Module — public channel/group scraping via browser container
// Extracts: channel name, description, member count, preview messages

async function safeFetchJson(url, options = {}) {
  try {
    const res = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
      signal: AbortSignal.timeout(options.timeout || 15000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

const BROWSER_API = "http://127.0.0.1:3334";

async function browserFetch(endpoint, body) {
  return safeFetchJson(`${BROWSER_API}${endpoint}`, {
    method: "POST",
    body: JSON.stringify(body),
    timeout: 20000,
  });
}

module.exports = {
  name: "telegram-intel",
  profileTypes: ["username"],

  async scan(profile, rateLimiter) {
    const username = profile.value;
    const findings = [];
    const sessionId = `telegram-${username}-${Date.now()}`;

    const release = await rateLimiter.acquire();
    try {
      // Strategy 1: t.me preview page (works without browser for basic info)
      const previewUrl = `https://t.me/${encodeURIComponent(username)}`;
      try {
        const res = await fetch(previewUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const html = await res.text();

          // Extract from meta tags and page content
          const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
          const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/);
          const imgMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
          const membersMatch = html.match(/([\d\s]+)\s*(members?|subscribers?)/i);

          if (titleMatch || descMatch) {
            const name = titleMatch?.[1] || username;
            const description = descMatch?.[1] || "";
            const memberCount = membersMatch?.[1]?.replace(/\s/g, "") || null;

            findings.push({
              category: "account_found",
              severity: description ? "medium" : "low",
              title: `Telegram: ${name}${memberCount ? ` — ${parseInt(memberCount).toLocaleString()} members` : ""}`,
              description: [
                `Channel/Group: ${name}`,
                description && `Description: ${description}`,
                memberCount && `Members: ${parseInt(memberCount).toLocaleString()}`,
                `URL: ${previewUrl}`,
              ].filter(Boolean).join("\n"),
              sourceUrl: previewUrl,
              rawData: {
                platform: "telegram",
                profileData: {
                  name,
                  username,
                  description,
                  memberCount: memberCount ? parseInt(memberCount) : null,
                  avatar: imgMatch?.[1] || null,
                },
              },
              remediation: "Public Telegram channels/groups are fully visible. Review channel privacy settings if unintended.",
            });
            return findings;
          }

          // Check if it's a valid user profile (not 404)
          if (!html.includes("tgme_page_extra") && !html.includes("If you have") && html.includes("tgme_page")) {
            findings.push({
              category: "account_found",
              severity: "info",
              title: `Telegram: @${username} — user exists (limited info)`,
              description: `Telegram user @${username} exists but has no public channel/group preview.`,
              sourceUrl: previewUrl,
              rawData: { platform: "telegram", username, type: "user", limited: true },
            });
            return findings;
          }
        }
      } catch (_) {}

      // Strategy 2: Browser container for richer extraction
      try {
        const navResult = await browserFetch("/navigate", { url: previewUrl, session_id: sessionId });
        if (navResult?.success) {
          const extractResult = await browserFetch("/evaluate", {
            session_id: sessionId,
            code: `(() => {
              const title = document.querySelector('.tgme_page_title span')?.textContent || '';
              const desc = document.querySelector('.tgme_page_description')?.textContent || '';
              const extra = document.querySelector('.tgme_page_extra')?.textContent || '';
              const msgs = Array.from(document.querySelectorAll('.tgme_widget_message_text')).slice(0, 20).map(m => m.textContent?.substring(0, 200));
              return JSON.stringify({ title, desc, extra, messages: msgs });
            })()`,
          });

          if (extractResult?.result) {
            try {
              const data = JSON.parse(extractResult.result);
              if (data.title && data.messages?.length > 0) {
                findings.push({
                  category: "account_found",
                  severity: "medium",
                  title: `Telegram: ${data.title} — ${data.messages.length} preview messages`,
                  description: [
                    `Channel: ${data.title}`,
                    data.desc && `Description: ${data.desc}`,
                    data.extra && `Info: ${data.extra}`,
                    `\nPreview messages (${data.messages.length}):`,
                    ...data.messages.slice(0, 5).map(m => `  ${m.substring(0, 100)}`),
                  ].filter(Boolean).join("\n"),
                  sourceUrl: previewUrl,
                  rawData: {
                    platform: "telegram",
                    profileData: { name: data.title, description: data.desc, extra: data.extra },
                    previewMessages: data.messages,
                  },
                });
              }
            } catch (_) {}
          }

          // Clean up browser session
          await browserFetch("/navigate", { url: "about:blank", session_id: sessionId }).catch(() => {});
        }
      } catch (_) {}
    } finally {
      release();
    }

    return findings;
  },
};
