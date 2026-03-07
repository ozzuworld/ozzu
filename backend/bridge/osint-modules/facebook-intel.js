// Facebook Intelligence Module — mbasic.facebook.com + Google cache + page scraping
// Extracts: name, about, followers, recent posts for public pages

const BROWSER_API = "http://127.0.0.1:3334";

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

async function browserFetch(endpoint, body) {
  return safeFetchJson(`${BROWSER_API}${endpoint}`, {
    method: "POST",
    body: JSON.stringify(body),
    timeout: 25000,
  });
}

async function safeFetchHtml(url, timeout = 12000) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html",
      },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (_) {
    return null;
  }
}

module.exports = {
  name: "facebook-intel",
  profileTypes: ["username"],

  async scan(profile, rateLimiter) {
    const username = profile.value;
    const findings = [];
    const sessionId = `facebook-${username}-${Date.now()}`;

    const release = await rateLimiter.acquire();
    try {
      // Strategy 1: Facebook page metadata via Open Graph
      const fbUrl = `https://www.facebook.com/${encodeURIComponent(username)}`;
      const html = await safeFetchHtml(fbUrl);

      if (html) {
        const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/);
        const ogDesc = html.match(/<meta property="og:description" content="([^"]+)"/);
        const ogImage = html.match(/<meta property="og:image" content="([^"]+)"/);
        const followersMatch = html.match(/([\d,.]+)\s*(?:people follow|followers|likes?)/i);

        if (ogTitle) {
          const identityFields = [];
          identityFields.push(`Name: ${ogTitle[1]}`);
          if (ogDesc) identityFields.push(`About: ${ogDesc[1].substring(0, 300)}`);

          findings.push({
            category: "account_found",
            severity: ogDesc ? "medium" : "low",
            title: `Facebook: ${ogTitle[1]}${followersMatch ? ` — ${followersMatch[1]} followers` : ""}`,
            description: [
              ...identityFields,
              followersMatch && `Followers/Likes: ${followersMatch[1]}`,
              `URL: ${fbUrl}`,
            ].filter(Boolean).join("\n"),
            sourceUrl: fbUrl,
            rawData: {
              platform: "facebook",
              profileData: {
                name: ogTitle[1],
                description: ogDesc?.[1],
                profileImage: ogImage?.[1],
                followersText: followersMatch?.[1],
              },
            },
            remediation: "Review Facebook privacy settings. Public pages are fully visible to anyone.",
          });
          return findings;
        }
      }

      // Strategy 2: Browser container for mbasic.facebook.com
      try {
        const mbasicUrl = `https://mbasic.facebook.com/${encodeURIComponent(username)}`;
        const navResult = await browserFetch("/navigate", { url: mbasicUrl, session_id: sessionId });

        if (navResult?.success) {
          const extractResult = await browserFetch("/evaluate", {
            session_id: sessionId,
            code: `(() => {
              const title = document.querySelector('#cover-name-root h3, #profile-name-section strong, title')?.textContent || '';
              const about = document.querySelector('#bio_text, .profile_intro')?.textContent || '';
              const posts = Array.from(document.querySelectorAll('.story_body_container, article')).slice(0, 10).map(p => p.textContent?.substring(0, 200));
              const profileImg = document.querySelector('img.profpic, img[alt*="profile"]')?.src || '';
              return JSON.stringify({ title: title.trim(), about: about.trim(), posts, profileImg });
            })()`,
          });

          if (extractResult?.result) {
            try {
              const data = JSON.parse(extractResult.result);
              if (data.title && data.title !== "Facebook" && !data.title.includes("Log in")) {
                findings.push({
                  category: "account_found",
                  severity: data.about ? "medium" : "low",
                  title: `Facebook: ${data.title}${data.posts?.length ? ` — ${data.posts.length} public posts` : ""}`,
                  description: [
                    `Name: ${data.title}`,
                    data.about && `About: ${data.about}`,
                    data.posts?.length > 0 && `\nRecent posts (${data.posts.length}):`,
                    ...(data.posts?.slice(0, 3).map(p => `  ${p.substring(0, 100)}`) || []),
                  ].filter(Boolean).join("\n"),
                  sourceUrl: fbUrl,
                  rawData: {
                    platform: "facebook",
                    profileData: { name: data.title, about: data.about, profileImg: data.profileImg },
                    recentPosts: data.posts,
                    viaBrowser: true,
                  },
                  remediation: "Review Facebook profile privacy. Limit public visibility via Privacy Settings.",
                });
              }
            } catch (_) {}
          }

          await browserFetch("/navigate", { url: "about:blank", session_id: sessionId }).catch(() => {});
        }
      } catch (_) {}

      // Strategy 3: Google cache/search fallback
      if (findings.length === 0) {
        const googleApiKey = process.env.GOOGLE_API_KEY;
        const googleCseId = process.env.GOOGLE_CSE_ID;
        if (googleApiKey && googleCseId) {
          const searchRelease = await rateLimiter.acquire();
          try {
            const query = `site:facebook.com "${username}"`;
            const data = await safeFetchJson(
              `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleCseId}&q=${encodeURIComponent(query)}&num=3`
            );
            if (data?.items?.length > 0) {
              const top = data.items[0];
              findings.push({
                category: "account_found",
                severity: "low",
                title: `Facebook: ${top.title} (via Google)`,
                description: `Google found: ${top.snippet || top.title}\n${top.link}`,
                sourceUrl: top.link,
                rawData: {
                  platform: "facebook",
                  username,
                  searchResults: data.items.slice(0, 3).map(i => ({ title: i.title, link: i.link, snippet: i.snippet })),
                  viaGoogle: true,
                },
              });
            }
          } finally {
            searchRelease();
          }
        }
      }
    } finally {
      release();
    }

    return findings;
  },
};
