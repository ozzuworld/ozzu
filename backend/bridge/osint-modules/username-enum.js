// Username enumeration module — Sherlock-style HTTP HEAD checks
// No API keys needed, just HTTP requests to public profile URLs

const PLATFORMS = [
  { name: "GitHub", url: "https://github.com/{}", category: "development" },
  { name: "GitLab", url: "https://gitlab.com/{}", category: "development" },
  { name: "Bitbucket", url: "https://bitbucket.org/{}", category: "development" },
  { name: "NPM", url: "https://www.npmjs.com/~{}", category: "development" },
  { name: "Docker Hub", url: "https://hub.docker.com/u/{}", category: "development" },
  { name: "Dev.to", url: "https://dev.to/{}", category: "development" },
  { name: "HackerNews", url: "https://news.ycombinator.com/user?id={}", category: "development" },
  { name: "Stack Overflow", url: "https://stackoverflow.com/users/?tab=accounts&SearchTerm={}", category: "development" },
  { name: "X (Twitter)", url: "https://x.com/{}", category: "social" },
  { name: "Instagram", url: "https://www.instagram.com/{}/", category: "social" },
  { name: "Reddit", url: "https://www.reddit.com/user/{}", category: "social" },
  { name: "YouTube", url: "https://www.youtube.com/@{}", category: "social" },
  { name: "TikTok", url: "https://www.tiktok.com/@{}", category: "social" },
  { name: "Twitch", url: "https://www.twitch.tv/{}", category: "social" },
  { name: "LinkedIn", url: "https://www.linkedin.com/in/{}", category: "social" },
  { name: "Facebook", url: "https://www.facebook.com/{}", category: "social" },
  { name: "Pinterest", url: "https://www.pinterest.com/{}/", category: "social" },
  { name: "Tumblr", url: "https://{}.tumblr.com", category: "social" },
  { name: "Medium", url: "https://medium.com/@{}", category: "social" },
  { name: "Mastodon (mastodon.social)", url: "https://mastodon.social/@{}", category: "social" },
  { name: "Steam", url: "https://steamcommunity.com/id/{}", category: "gaming" },
  { name: "Xbox", url: "https://xboxgamertag.com/search/{}", category: "gaming" },
  { name: "Chess.com", url: "https://www.chess.com/member/{}", category: "gaming" },
  { name: "Lichess", url: "https://lichess.org/@/{}", category: "gaming" },
  { name: "Roblox", url: "https://www.roblox.com/user.aspx?username={}", category: "gaming" },
  { name: "Spotify", url: "https://open.spotify.com/user/{}", category: "media" },
  { name: "SoundCloud", url: "https://soundcloud.com/{}", category: "media" },
  { name: "Last.fm", url: "https://www.last.fm/user/{}", category: "media" },
  { name: "Flickr", url: "https://www.flickr.com/people/{}", category: "media" },
  { name: "Vimeo", url: "https://vimeo.com/{}", category: "media" },
  { name: "Keybase", url: "https://keybase.io/{}", category: "security" },
  { name: "HackerOne", url: "https://hackerone.com/{}", category: "security" },
  { name: "Bugcrowd", url: "https://bugcrowd.com/{}", category: "security" },
  { name: "Gravatar", url: "https://gravatar.com/{}", category: "identity" },
  { name: "About.me", url: "https://about.me/{}", category: "identity" },
  { name: "Linktree", url: "https://linktr.ee/{}", category: "identity" },
  { name: "Cash App", url: "https://cash.app/${}", category: "finance" },
  { name: "Venmo", url: "https://account.venmo.com/u/{}", category: "finance" },
  { name: "PayPal", url: "https://www.paypal.me/{}", category: "finance" },
  { name: "Patreon", url: "https://www.patreon.com/{}", category: "finance" },
  { name: "Replit", url: "https://replit.com/@{}", category: "development" },
  { name: "CodePen", url: "https://codepen.io/{}", category: "development" },
  { name: "Dribbble", url: "https://dribbble.com/{}", category: "design" },
  { name: "Behance", url: "https://www.behance.net/{}", category: "design" },
  { name: "Figma", url: "https://www.figma.com/@{}", category: "design" },
  { name: "Kaggle", url: "https://www.kaggle.com/{}", category: "development" },
  { name: "Hugging Face", url: "https://huggingface.co/{}", category: "development" },
  { name: "Product Hunt", url: "https://www.producthunt.com/@{}", category: "tech" },
  { name: "Hacker Noon", url: "https://hackernoon.com/u/{}", category: "tech" },
  { name: "Substack", url: "https://{}.substack.com", category: "media" },
];

module.exports = {
  name: "username-enum",
  profileTypes: ["username"],

  async scan(profile, rateLimiter) {
    const username = profile.value;
    const findings = [];

    const checkPlatform = async (platform) => {
      const release = await rateLimiter.acquire();
      try {
        const profileUrl = platform.url.replace("{}", username);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        try {
          const res = await fetch(profileUrl, {
            method: "HEAD",
            signal: controller.signal,
            headers: { "User-Agent": "Mozilla/5.0 (compatible; OSINT-Scanner/1.0)" },
            redirect: "manual",
          });
          clearTimeout(timeout);

          // 200 = account exists, 3xx redirect to profile = exists
          if (res.status === 200 || (res.status >= 300 && res.status < 400)) {
            return {
              category: "account_found",
              severity: "medium",
              title: `Account found on ${platform.name}`,
              description: `Username "${username}" has an active profile on ${platform.name}. This publicly associates this username with the platform.`,
              sourceUrl: profileUrl,
              rawData: { platform: platform.name, status: res.status, category: platform.category },
              remediation: `Review your ${platform.name} profile privacy settings. Consider removing or anonymizing the account if it's not needed.`,
            };
          }
        } catch (err) {
          clearTimeout(timeout);
          // Timeout or network error — skip silently
        }
        return null;
      } finally {
        release();
      }
    };

    // Run all checks in parallel (rate limiter handles concurrency)
    const results = await Promise.all(PLATFORMS.map(checkPlatform));
    for (const result of results) {
      if (result) findings.push(result);
    }

    // If no accounts found, add info-level finding
    if (findings.length === 0) {
      findings.push({
        category: "account_found",
        severity: "info",
        title: "No accounts found across checked platforms",
        description: `Username "${username}" was not found on any of the ${PLATFORMS.length} platforms checked. This is a good sign for username privacy.`,
        rawData: { platformsChecked: PLATFORMS.length },
        remediation: null,
      });
    }

    return findings;
  },
};
