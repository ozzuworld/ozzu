// Mastodon Intelligence Module — ActivityPub/Mastodon API (open per-instance)
// Searches major instances via WebFinger + account lookup + recent statuses

async function safeFetchJson(url, options = {}) {
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; OsintBot/1.0)",
        ...options.headers,
      },
      signal: AbortSignal.timeout(options.timeout || 10000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

const INSTANCES = [
  "mastodon.social",
  "mstdn.social",
  "mastodon.online",
  "hachyderm.io",
  "infosec.exchange",
  "fosstodon.org",
  "mas.to",
  "mastodon.world",
  "techhub.social",
  "universeodon.com",
];

module.exports = {
  name: "mastodon-intel",
  profileTypes: ["username"],

  async scan(profile, rateLimiter) {
    const username = profile.value;
    const findings = [];

    for (const instance of INSTANCES) {
      const release = await rateLimiter.acquire();
      try {
        // Look up account
        const account = await safeFetchJson(
          `https://${instance}/api/v1/accounts/lookup?acct=${encodeURIComponent(username)}`
        );
        if (!account || account.error) continue;

        const identityFields = [];
        if (account.display_name) identityFields.push(`Name: ${account.display_name}`);
        if (account.note) {
          // Strip HTML tags from bio
          const bio = account.note.replace(/<[^>]*>/g, "").trim();
          if (bio) identityFields.push(`Bio: ${bio.substring(0, 300)}`);
        }

        // Fetch recent statuses
        let recentPosts = [];
        const statusRelease = await rateLimiter.acquire();
        try {
          const statuses = await safeFetchJson(
            `https://${instance}/api/v1/accounts/${account.id}/statuses?limit=20&exclude_replies=false`
          );
          if (statuses && Array.isArray(statuses)) {
            recentPosts = statuses.map(s => ({
              content: s.content?.replace(/<[^>]*>/g, "").substring(0, 200),
              createdAt: s.created_at,
              favourites: s.favourites_count || 0,
              reblogs: s.reblogs_count || 0,
              replies: s.replies_count || 0,
              url: s.url,
            }));
          }
        } finally {
          statusRelease();
        }

        // Extract linked URLs from profile fields
        const linkedUrls = [];
        if (account.fields && Array.isArray(account.fields)) {
          for (const field of account.fields) {
            const urlMatch = field.value?.match(/href="([^"]+)"/);
            if (urlMatch) linkedUrls.push({ name: field.name, url: urlMatch[1], verified: !!field.verified_at });
          }
        }

        const severity = identityFields.length > 0 || linkedUrls.length > 0 ? "medium" : "low";

        const postSummary = recentPosts.length > 0
          ? `\nRecent toots (${recentPosts.length}):\n${recentPosts.slice(0, 5).map(p => `  [${p.createdAt?.split("T")[0] || "?"}] ${p.content?.substring(0, 100) || "(media)"}... (${p.favourites}⭐ ${p.reblogs}🔁)`).join("\n")}`
          : "";

        const linkSummary = linkedUrls.length > 0
          ? `\nLinked URLs: ${linkedUrls.map(l => `${l.name}: ${l.url}${l.verified ? " ✓" : ""}`).join(", ")}`
          : "";

        findings.push({
          category: "account_found",
          severity,
          title: `Mastodon: @${account.acct}@${instance} — ${account.followers_count || 0} followers`,
          description: [
            ...identityFields,
            `Handle: @${account.acct}@${instance}`,
            `Followers: ${account.followers_count || 0} | Following: ${account.following_count || 0}`,
            `Statuses: ${account.statuses_count || 0}`,
            account.created_at && `Joined: ${account.created_at.split("T")[0]}`,
            account.last_status_at && `Last active: ${account.last_status_at}`,
            linkSummary,
            postSummary,
          ].filter(Boolean).join("\n"),
          sourceUrl: account.url,
          rawData: {
            platform: "mastodon",
            instance,
            profileData: {
              id: account.id,
              acct: account.acct,
              display_name: account.display_name,
              note: account.note,
              avatar: account.avatar,
              header: account.header,
              followers_count: account.followers_count,
              following_count: account.following_count,
              statuses_count: account.statuses_count,
              created_at: account.created_at,
              last_status_at: account.last_status_at,
              bot: account.bot,
              locked: account.locked,
              fields: account.fields,
            },
            recentPosts: recentPosts.slice(0, 10),
            linkedUrls,
          },
          remediation: linkedUrls.length > 0
            ? "Mastodon profile fields may link to other accounts. Review linked URLs for unintended cross-referencing."
            : null,
        });

        // Don't search more instances once found
        return findings;
      } finally {
        release();
      }
    }

    return findings;
  },
};
