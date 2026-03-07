// TikTok Intelligence Module — parse __UNIVERSAL_DATA_FOR_REHYDRATION__ from HTML
// Extracts: display name, bio, avatar, follower/following/likes, recent videos

const BROWSER_API = "http://127.0.0.1:3334";

async function browserFetch(endpoint, body, timeout = 20000) {
  try {
    const res = await fetch(`${BROWSER_API}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

module.exports = {
  name: "tiktok-intel",
  profileTypes: ["username"],

  async scan(profile, rateLimiter) {
    const username = profile.value;
    const findings = [];
    const sessionId = `tiktok-${username}-${Date.now()}`;

    const release = await rateLimiter.acquire();
    try {
      const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(username)}`;

      // Strategy 1: Direct HTML fetch — parse rehydration data
      try {
        const res = await fetch(profileUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
          },
          signal: AbortSignal.timeout(15000),
        });

        if (res.ok) {
          const html = await res.text();
          const rehydrationMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);

          if (rehydrationMatch) {
            try {
              const rehydrationData = JSON.parse(rehydrationMatch[1]);
              const defaultScope = rehydrationData?.__DEFAULT_SCOPE__;
              const userDetail = defaultScope?.["webapp.user-detail"];
              const userInfo = userDetail?.userInfo;

              if (userInfo?.user) {
                const user = userInfo.user;
                const stats = userInfo.stats || {};

                const identityFields = [];
                if (user.nickname) identityFields.push(`Name: ${user.nickname}`);
                if (user.signature) identityFields.push(`Bio: ${user.signature}`);

                // Extract recent videos if available
                const recentVideos = [];
                const itemList = defaultScope?.["webapp.video-detail"]?.itemList || [];
                for (const item of itemList.slice(0, 10)) {
                  recentVideos.push({
                    desc: item.desc?.substring(0, 200),
                    playCount: item.stats?.playCount || 0,
                    diggCount: item.stats?.diggCount || 0,
                    commentCount: item.stats?.commentCount || 0,
                    createTime: item.createTime,
                  });
                }

                const severity = identityFields.length > 0 ? "medium" : "low";

                findings.push({
                  category: "account_found",
                  severity,
                  title: `TikTok: @${user.uniqueId || username} — ${stats.followerCount?.toLocaleString() || 0} followers${user.verified ? " ✓" : ""}`,
                  description: [
                    ...identityFields,
                    `Followers: ${stats.followerCount?.toLocaleString() || 0} | Following: ${stats.followingCount?.toLocaleString() || 0}`,
                    `Likes: ${stats.heartCount?.toLocaleString() || stats.heart?.toLocaleString() || 0}`,
                    `Videos: ${stats.videoCount || 0}`,
                    user.verified && "Verified: yes",
                    user.privateAccount && "Account is PRIVATE",
                    user.region && `Region: ${user.region}`,
                    recentVideos.length > 0 && `\nRecent videos:\n${recentVideos.slice(0, 5).map(v => `  ${v.desc?.substring(0, 80) || "(no desc)"} (${v.playCount?.toLocaleString() || 0}▶ ${v.diggCount || 0}❤)`).join("\n")}`,
                  ].filter(Boolean).join("\n"),
                  sourceUrl: profileUrl,
                  rawData: {
                    platform: "tiktok",
                    profileData: {
                      uniqueId: user.uniqueId,
                      nickname: user.nickname,
                      signature: user.signature,
                      avatarLarger: user.avatarLarger,
                      verified: user.verified,
                      privateAccount: user.privateAccount,
                      region: user.region,
                      followerCount: stats.followerCount,
                      followingCount: stats.followingCount,
                      heartCount: stats.heartCount || stats.heart,
                      videoCount: stats.videoCount,
                      createTime: user.createTime,
                    },
                    recentVideos,
                  },
                  remediation: !user.privateAccount
                    ? "Set TikTok account to private to limit profile visibility."
                    : null,
                });
                return findings;
              }
            } catch (_) {}
          }

          // Check if profile exists via meta tags
          const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/);
          if (ogTitle && !html.includes("Couldn't find this account")) {
            findings.push({
              category: "account_found",
              severity: "low",
              title: `TikTok: @${username} — profile exists (limited data)`,
              description: `TikTok profile found: ${ogTitle[1]}. Rehydration data unavailable.`,
              sourceUrl: profileUrl,
              rawData: { platform: "tiktok", username, ogTitle: ogTitle[1], limited: true },
            });
            return findings;
          }
        }
      } catch (_) {}

      // Strategy 2: Browser container with stealth for bot-protected pages
      try {
        const navResult = await browserFetch("/navigate", { url: profileUrl, session_id: sessionId });
        if (navResult?.success) {
          // Wait for page to load
          await new Promise(r => setTimeout(r, 2000));

          const extractResult = await browserFetch("/evaluate", {
            session_id: sessionId,
            code: `(() => {
              const script = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
              if (script) return script.textContent;
              // Fallback: extract from meta
              const title = document.querySelector('meta[property="og:title"]')?.content || '';
              const desc = document.querySelector('meta[property="og:description"]')?.content || '';
              return JSON.stringify({ fallback: true, title, desc });
            })()`,
          });

          if (extractResult?.result) {
            try {
              const parsed = JSON.parse(extractResult.result);
              if (parsed.fallback && parsed.title) {
                findings.push({
                  category: "account_found",
                  severity: "low",
                  title: `TikTok: @${username} — ${parsed.title}`,
                  description: parsed.desc || `TikTok profile found via browser.`,
                  sourceUrl: profileUrl,
                  rawData: { platform: "tiktok", username, title: parsed.title, desc: parsed.desc, viaBrowser: true },
                });
              }
            } catch (_) {}
          }

          await browserFetch("/navigate", { url: "about:blank", session_id: sessionId }).catch(() => {});
        }
      } catch (_) {}
    } finally {
      release();
    }

    return findings;
  },
};
