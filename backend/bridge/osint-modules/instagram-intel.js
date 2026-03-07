// Instagram Intelligence Module — REST API endpoint (no auth for public profiles)
// Extracts: display name, bio, avatar, follower/following counts, posts, verified status

async function safeFetchJson(url, options = {}) {
  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(options.timeout || 12000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

const BROWSER_API = "http://127.0.0.1:3334";

module.exports = {
  name: "instagram-intel",
  profileTypes: ["username"],

  async scan(profile, rateLimiter) {
    const username = profile.value;
    const findings = [];

    const release = await rateLimiter.acquire();
    try {
      // Strategy 1: Instagram private API (no auth for public profiles)
      const data = await safeFetchJson(
        `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
        {
          headers: {
            "User-Agent": "Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100)",
            "x-ig-app-id": "936619743392459",
            "Accept": "*/*",
          },
        }
      );

      if (data?.data?.user) {
        const user = data.data.user;
        const identityFields = [];
        if (user.full_name) identityFields.push(`Name: ${user.full_name}`);
        if (user.biography) identityFields.push(`Bio: ${user.biography}`);
        if (user.external_url) identityFields.push(`Website: ${user.external_url}`);
        if (user.category_name) identityFields.push(`Category: ${user.category_name}`);

        // Extract recent posts
        const recentPosts = [];
        const edges = user.edge_owner_to_timeline_media?.edges || [];
        for (const edge of edges.slice(0, 12)) {
          const node = edge.node;
          recentPosts.push({
            caption: node.edge_media_to_caption?.edges?.[0]?.node?.text?.substring(0, 200) || "",
            likes: node.edge_liked_by?.count || node.edge_media_preview_like?.count || 0,
            comments: node.edge_media_to_comment?.count || 0,
            timestamp: node.taken_at_timestamp,
            isVideo: node.is_video,
            thumbnailUrl: node.thumbnail_src || node.display_url,
          });
        }

        const severity = identityFields.length > 1 ? "medium" : "low";
        const isPrivate = user.is_private;

        const postSummary = recentPosts.length > 0
          ? `\nRecent posts (${recentPosts.length}):\n${recentPosts.slice(0, 5).map(p => `  [${p.timestamp ? new Date(p.timestamp * 1000).toISOString().split("T")[0] : "?"}] ${p.caption?.substring(0, 80) || "(no caption)"} (${p.likes}❤ ${p.comments}💬)`).join("\n")}`
          : "";

        findings.push({
          category: "account_found",
          severity,
          title: `Instagram: @${username} — ${user.edge_followed_by?.count?.toLocaleString() || 0} followers${user.is_verified ? " ✓" : ""}${isPrivate ? " 🔒" : ""}`,
          description: [
            ...identityFields,
            `Followers: ${user.edge_followed_by?.count?.toLocaleString() || 0} | Following: ${user.edge_follow?.count?.toLocaleString() || 0}`,
            `Posts: ${user.edge_owner_to_timeline_media?.count || 0}`,
            user.is_verified && "Verified: yes",
            isPrivate && "Account is PRIVATE",
            user.is_business_account && `Business account: yes`,
            postSummary,
          ].filter(Boolean).join("\n"),
          sourceUrl: `https://www.instagram.com/${username}/`,
          rawData: {
            platform: "instagram",
            profileData: {
              username: user.username,
              fullName: user.full_name,
              biography: user.biography,
              externalUrl: user.external_url,
              profilePicUrl: user.profile_pic_url_hd || user.profile_pic_url,
              followersCount: user.edge_followed_by?.count,
              followingCount: user.edge_follow?.count,
              postsCount: user.edge_owner_to_timeline_media?.count,
              isVerified: user.is_verified,
              isPrivate: user.is_private,
              isBusinessAccount: user.is_business_account,
              categoryName: user.category_name,
              fbid: user.fbid,
            },
            recentPosts,
          },
          remediation: !isPrivate
            ? "Set Instagram account to private to limit profile visibility. Remove personal info from bio."
            : null,
        });
        return findings;
      }
    } finally {
      release();
    }

    // Strategy 2: Fallback — simple HEAD check
    const release2 = await rateLimiter.acquire();
    try {
      const res = await fetch(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
        method: "HEAD",
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(8000),
        redirect: "manual",
      });
      if (res.status === 200) {
        findings.push({
          category: "account_found",
          severity: "low",
          title: `Instagram: @${username} — profile exists (API blocked, limited data)`,
          description: `Instagram profile found but API rate-limited. Full data unavailable.`,
          sourceUrl: `https://www.instagram.com/${username}/`,
          rawData: { platform: "instagram", username, accessible: true, apiBlocked: true },
          remediation: "Set Instagram account to private if you don't want your posts publicly visible.",
        });
      }
    } catch (_) {} finally {
      release2();
    }

    return findings;
  },
};
