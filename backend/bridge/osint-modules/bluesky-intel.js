// Bluesky Intelligence Module — AT Protocol API (fully open, no auth needed)
// Extracts: display name, bio, avatar, follower/following counts, recent posts, engagement

async function safeFetchJson(url, options = {}) {
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        "Accept": "application/json",
        ...options.headers,
      },
      signal: AbortSignal.timeout(options.timeout || 12000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

module.exports = {
  name: "bluesky-intel",
  profileTypes: ["username"],

  async scan(profile, rateLimiter) {
    const username = profile.value;
    const findings = [];

    // Try common handle patterns
    const handles = [
      `${username}.bsky.social`,
      username, // in case they provide full handle
    ];

    for (const handle of handles) {
      const release = await rateLimiter.acquire();
      try {
        const profileData = await safeFetchJson(
          `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`
        );
        if (!profileData || profileData.error) continue;

        const identityFields = [];
        if (profileData.displayName) identityFields.push(`Name: ${profileData.displayName}`);
        if (profileData.description) identityFields.push(`Bio: ${profileData.description}`);

        // Fetch recent posts
        let recentPosts = [];
        const feedRelease = await rateLimiter.acquire();
        try {
          const feed = await safeFetchJson(
            `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=20`
          );
          if (feed?.feed) {
            recentPosts = feed.feed.slice(0, 20).map(item => {
              const post = item.post;
              return {
                text: post.record?.text?.substring(0, 200),
                createdAt: post.record?.createdAt,
                likes: post.likeCount || 0,
                reposts: post.repostCount || 0,
                replies: post.replyCount || 0,
              };
            });
          }
        } finally {
          feedRelease();
        }

        const severity = identityFields.length > 0 ? "medium" : "low";
        const postSummary = recentPosts.length > 0
          ? `\nRecent posts (${recentPosts.length}):\n${recentPosts.slice(0, 5).map(p => `  [${p.createdAt?.split("T")[0] || "?"}] ${p.text?.substring(0, 100) || "(no text)"}... (${p.likes}❤ ${p.reposts}🔁)`).join("\n")}`
          : "";

        findings.push({
          category: "account_found",
          severity,
          title: `Bluesky: @${profileData.handle} — ${profileData.followersCount || 0} followers`,
          description: [
            ...identityFields,
            `Handle: ${profileData.handle}`,
            `Followers: ${profileData.followersCount || 0} | Following: ${profileData.followsCount || 0}`,
            `Posts: ${profileData.postsCount || 0}`,
            profileData.avatar && `Avatar: ${profileData.avatar}`,
            postSummary,
          ].filter(Boolean).join("\n"),
          sourceUrl: `https://bsky.app/profile/${profileData.handle}`,
          rawData: {
            platform: "bluesky",
            profileData: {
              did: profileData.did,
              handle: profileData.handle,
              displayName: profileData.displayName,
              description: profileData.description,
              avatar: profileData.avatar,
              banner: profileData.banner,
              followersCount: profileData.followersCount,
              followsCount: profileData.followsCount,
              postsCount: profileData.postsCount,
              createdAt: profileData.createdAt,
            },
            recentPosts,
          },
          remediation: identityFields.length > 1
            ? "Review Bluesky profile for personal information. Bio and display name are publicly visible."
            : null,
        });

        return findings; // Found on first matching handle
      } finally {
        release();
      }
    }

    return findings;
  },
};
