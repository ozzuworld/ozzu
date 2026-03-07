// Reddit Deep Intelligence Module — comprehensive Reddit profile analysis
// Extracts: account age, karma, active subreddits, recent posts/comments, content themes

async function safeFetchJson(url, options = {}) {
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OsintBot/1.0)",
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
  name: "reddit-intel",
  profileTypes: ["username"],

  async scan(profile, rateLimiter) {
    const username = profile.value;
    const findings = [];

    // Fetch profile
    const release = await rateLimiter.acquire();
    let userData = null;
    try {
      const data = await safeFetchJson(`https://www.reddit.com/user/${encodeURIComponent(username)}/about.json`);
      if (!data?.data) return findings;
      userData = data.data;
    } finally {
      release();
    }

    const accountAgeYears = ((Date.now() / 1000 - userData.created_utc) / (365.25 * 86400)).toFixed(1);

    // Fetch recent posts
    let recentPosts = [];
    const postsRelease = await rateLimiter.acquire();
    try {
      const posts = await safeFetchJson(`https://www.reddit.com/user/${encodeURIComponent(username)}/submitted.json?limit=25&raw_json=1`);
      if (posts?.data?.children) {
        recentPosts = posts.data.children.map(c => c.data).map(p => ({
          title: p.title,
          subreddit: p.subreddit,
          score: p.score,
          numComments: p.num_comments,
          createdUtc: p.created_utc,
          url: p.url,
          selftext: p.selftext?.substring(0, 200),
        }));
      }
    } finally {
      postsRelease();
    }

    // Fetch recent comments
    let recentComments = [];
    const commentsRelease = await rateLimiter.acquire();
    try {
      const comments = await safeFetchJson(`https://www.reddit.com/user/${encodeURIComponent(username)}/comments.json?limit=25&raw_json=1`);
      if (comments?.data?.children) {
        recentComments = comments.data.children.map(c => c.data).map(c => ({
          subreddit: c.subreddit,
          body: c.body?.substring(0, 200),
          score: c.score,
          createdUtc: c.created_utc,
          linkTitle: c.link_title,
        }));
      }
    } finally {
      commentsRelease();
    }

    // Analyze active subreddits
    const subredditCounts = {};
    for (const p of recentPosts) {
      subredditCounts[p.subreddit] = (subredditCounts[p.subreddit] || 0) + 1;
    }
    for (const c of recentComments) {
      subredditCounts[c.subreddit] = (subredditCounts[c.subreddit] || 0) + 1;
    }
    const topSubreddits = Object.entries(subredditCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const identityParts = [];
    if (userData.subreddit?.public_description) identityParts.push(`Bio: ${userData.subreddit.public_description}`);
    if (userData.subreddit?.title && userData.subreddit.title !== userData.name) identityParts.push(`Display: ${userData.subreddit.title}`);

    const severity = (identityParts.length > 0 || recentPosts.length > 10) ? "medium" : "low";

    const postSummary = recentPosts.length > 0
      ? `\nRecent posts (${recentPosts.length}):\n${recentPosts.slice(0, 5).map(p => `  [r/${p.subreddit}] ${p.title} (${p.score}↑ ${p.numComments}💬)`).join("\n")}`
      : "";

    const subredditSummary = topSubreddits.length > 0
      ? `\nActive subreddits: ${topSubreddits.map(([s, c]) => `r/${s}(${c})`).join(", ")}`
      : "";

    findings.push({
      category: "account_found",
      severity,
      title: `Reddit: u/${userData.name} — ${accountAgeYears}yr, ${userData.total_karma || 0} karma, ${recentPosts.length} recent posts`,
      description: [
        ...identityParts,
        `Account age: ${accountAgeYears} years (created ${new Date(userData.created_utc * 1000).toISOString().split("T")[0]})`,
        `Total karma: ${userData.total_karma || 0} (${userData.link_karma || 0} post, ${userData.comment_karma || 0} comment)`,
        userData.has_verified_email ? "Email verified: yes" : "Email verified: no",
        subredditSummary,
        postSummary,
      ].filter(Boolean).join("\n"),
      sourceUrl: `https://www.reddit.com/user/${userData.name}`,
      rawData: {
        platform: "reddit",
        profileData: {
          name: userData.name,
          created_utc: userData.created_utc,
          total_karma: userData.total_karma,
          link_karma: userData.link_karma,
          comment_karma: userData.comment_karma,
          has_verified_email: userData.has_verified_email,
          icon_img: userData.icon_img,
          snoovatar_img: userData.snoovatar_img,
          bio: userData.subreddit?.public_description,
          displayName: userData.subreddit?.title,
        },
        recentPosts: recentPosts.slice(0, 10),
        recentComments: recentComments.slice(0, 10),
        topSubreddits,
        postCount: recentPosts.length,
        commentCount: recentComments.length,
      },
      remediation: identityParts.length > 0
        ? "Review Reddit profile bio. Activity patterns across subreddits may reveal interests, location, or timezone."
        : null,
    });

    return findings;
  },
};
