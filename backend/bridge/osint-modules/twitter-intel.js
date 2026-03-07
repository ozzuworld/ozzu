// Twitter/X Intelligence Module — twscrape (with credentials) + Nitter + Google cache
// Extracts: display name, bio, follower/following counts, recent tweets

const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

async function runInContainer(cmd, args, timeout = 30000) {
  try {
    const { stdout } = await execFileAsync("docker", [
      "exec", "osint-tools", cmd, ...args,
    ], { timeout, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    return null;
  }
}

async function safeFetchJson(url, options = {}) {
  try {
    const res = await fetch(url, {
      ...options,
      headers: { "Accept": "application/json", ...options.headers },
      signal: AbortSignal.timeout(options.timeout || 12000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function safeFetchHtml(url, timeout = 10000) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(timeout),
      redirect: "manual",
    });
    if (res.status === 200) return await res.text();
    return null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  name: "twitter-intel",
  profileTypes: ["username"],

  async scan(profile, rateLimiter) {
    const username = profile.value;
    const findings = [];

    const release = await rateLimiter.acquire();
    try {
      // Strategy 1: twscrape (if installed and credentials available)
      const twscrapeResult = await runInContainer("python3", [
        "-c", `
import json, asyncio
try:
    from twscrape import API
    async def main():
        api = API()
        user = await api.user_by_login("${username.replace(/"/g, '')}")
        if user:
            tweets = []
            async for t in api.user_tweets(user.id, limit=20):
                tweets.append({
                    "text": t.rawContent[:200] if t.rawContent else "",
                    "date": str(t.date),
                    "likes": t.likeCount,
                    "retweets": t.retweetCount,
                    "replies": t.replyCount,
                })
            print(json.dumps({
                "id": user.id,
                "username": user.username,
                "displayname": user.displayname,
                "description": user.rawDescription,
                "location": user.location,
                "followers": user.followersCount,
                "following": user.friendsCount,
                "tweets_count": user.statusesCount,
                "verified": user.verified or user.blueVerified,
                "created": str(user.created),
                "profile_image": user.profileImageUrl,
                "profile_banner": user.profileBannerUrl,
                "recent_tweets": tweets
            }))
    asyncio.run(main())
except Exception as e:
    print(json.dumps({"error": str(e)}))
`,
      ], 45000);

      if (twscrapeResult) {
        try {
          const data = JSON.parse(twscrapeResult);
          if (data.username && !data.error) {
            const identityFields = [];
            if (data.displayname) identityFields.push(`Name: ${data.displayname}`);
            if (data.description) identityFields.push(`Bio: ${data.description}`);
            if (data.location) identityFields.push(`Location: ${data.location}`);

            const tweetSummary = data.recent_tweets?.length > 0
              ? `\nRecent tweets (${data.recent_tweets.length}):\n${data.recent_tweets.slice(0, 5).map(t => `  [${t.date?.split(" ")[0] || "?"}] ${t.text?.substring(0, 100) || ""}... (${t.likes}❤ ${t.retweets}🔁)`).join("\n")}`
              : "";

            findings.push({
              category: "account_found",
              severity: identityFields.length > 1 ? "medium" : "low",
              title: `Twitter/X: @${data.username} — ${data.followers?.toLocaleString() || 0} followers${data.verified ? " ✓" : ""}`,
              description: [
                ...identityFields,
                `Followers: ${data.followers?.toLocaleString() || 0} | Following: ${data.following?.toLocaleString() || 0}`,
                `Tweets: ${data.tweets_count?.toLocaleString() || 0}`,
                data.verified && "Verified: yes",
                data.created && `Joined: ${data.created.split(" ")[0]}`,
                tweetSummary,
              ].filter(Boolean).join("\n"),
              sourceUrl: `https://x.com/${data.username}`,
              rawData: {
                platform: "twitter",
                profileData: {
                  id: data.id,
                  username: data.username,
                  displayname: data.displayname,
                  description: data.description,
                  location: data.location,
                  followers: data.followers,
                  following: data.following,
                  tweets_count: data.tweets_count,
                  verified: data.verified,
                  created: data.created,
                  profile_image: data.profile_image,
                  profile_banner: data.profile_banner,
                },
                recentTweets: data.recent_tweets,
              },
              remediation: identityFields.length > 1
                ? "Review Twitter/X profile for personal information. Location and bio are publicly visible."
                : null,
            });
            return findings;
          }
        } catch (_) {}
      }

      // Strategy 2: Nitter instances
      const nitterInstances = [
        `https://nitter.privacydev.net/${username}`,
        `https://nitter.poast.org/${username}`,
      ];

      for (const nitterUrl of nitterInstances) {
        const html = await safeFetchHtml(nitterUrl);
        if (html) {
          const nameMatch = html.match(/<a class="profile-card-fullname"[^>]*>([^<]+)/);
          const bioMatch = html.match(/<div class="profile-bio"[^>]*>([\s\S]*?)<\/div>/);
          const statsMatch = html.match(/<li class="posts"[^>]*>[\s\S]*?<span class="profile-stat-num">([^<]+)/);
          const followersMatch = html.match(/<li class="followers"[^>]*>[\s\S]*?<span class="profile-stat-num">([^<]+)/);
          const followingMatch = html.match(/<li class="following"[^>]*>[\s\S]*?<span class="profile-stat-num">([^<]+)/);

          if (nameMatch || followersMatch) {
            const name = nameMatch?.[1]?.trim();
            const bio = bioMatch?.[1]?.replace(/<[^>]*>/g, "").trim();

            findings.push({
              category: "account_found",
              severity: (name || bio) ? "medium" : "low",
              title: `Twitter/X: @${username}${name ? ` (${name})` : ""} — ${followersMatch?.[1] || "?"} followers`,
              description: [
                name && `Name: ${name}`,
                bio && `Bio: ${bio}`,
                `Tweets: ${statsMatch?.[1] || "?"}`,
                `Followers: ${followersMatch?.[1] || "?"} | Following: ${followingMatch?.[1] || "?"}`,
                `(via Nitter)`,
              ].filter(Boolean).join("\n"),
              sourceUrl: `https://x.com/${username}`,
              rawData: {
                platform: "twitter",
                profileData: {
                  username,
                  displayname: name,
                  description: bio,
                  followers: followersMatch?.[1],
                  following: followingMatch?.[1],
                  tweets: statsMatch?.[1],
                },
                viaNitter: true,
              },
              remediation: "Review Twitter/X profile privacy. Consider protecting tweets if account is personal.",
            });
            return findings;
          }
        }
      }

      // Strategy 3: Simple existence check via x.com
      try {
        const res = await fetch(`https://x.com/${encodeURIComponent(username)}`, {
          method: "HEAD",
          headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
          signal: AbortSignal.timeout(8000),
          redirect: "manual",
        });
        if (res.status === 200) {
          findings.push({
            category: "account_found",
            severity: "info",
            title: `Twitter/X: @${username} — profile exists (limited data)`,
            description: `Twitter/X profile exists but detailed data requires authentication.`,
            sourceUrl: `https://x.com/${username}`,
            rawData: { platform: "twitter", username, accessible: true, limited: true },
          });
        }
      } catch (_) {}
    } finally {
      release();
    }

    return findings;
  },
};
