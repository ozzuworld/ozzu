// Deep social media analysis module — extract actual profile data, linked accounts, activity patterns
// Upgrades from username-enum's "exists" checks to full profile intelligence extraction
// All free APIs — no keys needed for most platforms

// Helper: safe JSON fetch with timeout
async function safeFetchJson(url, options = {}) {
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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

// Helper: safe HEAD check
async function safeHead(url) {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(8000),
      redirect: "manual",
    });
    return res.status;
  } catch (_) {
    return null;
  }
}

// Platform extractors
const EXTRACTORS = [
  // GitHub API — 60 req/hr unauth, rich profile data
  {
    name: "GitHub",
    platform: "github",
    async extract(username, rateLimiter) {
      const release = await rateLimiter.acquire();
      try {
        const data = await safeFetchJson(`https://api.github.com/users/${encodeURIComponent(username)}`);
        if (!data || data.message) return null;

        const findings = [];
        const identityFields = [];

        if (data.name) identityFields.push(`Name: ${data.name}`);
        if (data.email) identityFields.push(`Email: ${data.email}`);
        if (data.company) identityFields.push(`Company: ${data.company}`);
        if (data.location) identityFields.push(`Location: ${data.location}`);
        if (data.bio) identityFields.push(`Bio: ${data.bio}`);
        if (data.blog) identityFields.push(`Website: ${data.blog}`);

        const severity = (data.email || data.company || data.location) ? "medium" : "low";

        findings.push({
          category: "account_found",
          severity,
          title: `GitHub: ${data.login} — ${identityFields.length} identity fields exposed`,
          description: [
            ...identityFields,
            `Public repos: ${data.public_repos}`,
            `Followers: ${data.followers} | Following: ${data.following}`,
            `Created: ${data.created_at}`,
            data.twitter_username && `Twitter: @${data.twitter_username}`,
          ].filter(Boolean).join("\n"),
          sourceUrl: data.html_url,
          rawData: {
            platform: "github",
            profileData: {
              login: data.login, name: data.name, email: data.email,
              company: data.company, location: data.location, bio: data.bio,
              blog: data.blog, twitter_username: data.twitter_username,
              public_repos: data.public_repos, public_gists: data.public_gists,
              followers: data.followers, following: data.following,
              avatar_url: data.avatar_url, created_at: data.created_at,
            },
          },
          remediation: identityFields.length > 2
            ? "Review GitHub profile visibility. Remove sensitive info (real name, email, location) if privacy is a concern."
            : null,
        });

        // Check for personal email in recent commits
        if (data.public_repos > 0) {
          const reposRelease = await rateLimiter.acquire();
          try {
            const repos = await safeFetchJson(`https://api.github.com/users/${encodeURIComponent(username)}/repos?sort=updated&per_page=3`);
            if (repos && Array.isArray(repos)) {
              for (const repo of repos.slice(0, 2)) {
                const commits = await safeFetchJson(`https://api.github.com/repos/${repo.full_name}/commits?per_page=3`);
                if (commits && Array.isArray(commits)) {
                  for (const commit of commits) {
                    const email = commit?.commit?.author?.email;
                    if (email && !email.includes("noreply") && !email.includes("users.noreply")) {
                      findings.push({
                        category: "exposure",
                        severity: "high",
                        title: `Personal email exposed in GitHub commits: ${email}`,
                        description: `Found in ${repo.full_name}: commit ${commit.sha?.substring(0, 7)} by ${commit.commit.author.name}`,
                        sourceUrl: commit.html_url,
                        rawData: { platform: "github", email, repo: repo.full_name, commitSha: commit.sha },
                        remediation: "Set a noreply email in GitHub settings (Settings > Emails > Keep my email addresses private). Old commits still expose the email.",
                      });
                      return findings; // One is enough to prove exposure
                    }
                  }
                }
              }
            }
          } catch (_) {
            // Skip commit check
          } finally {
            reposRelease();
          }
        }

        return findings;
      } finally {
        release();
      }
    },
  },

  // Reddit — /user/{name}/about.json
  {
    name: "Reddit",
    platform: "reddit",
    async extract(username, rateLimiter) {
      const release = await rateLimiter.acquire();
      try {
        const data = await safeFetchJson(`https://www.reddit.com/user/${encodeURIComponent(username)}/about.json`);
        if (!data?.data) return null;

        const user = data.data;
        const accountAgeYears = ((Date.now() / 1000 - user.created_utc) / (365.25 * 86400)).toFixed(1);
        const identityParts = [];

        if (user.subreddit?.public_description) identityParts.push(`Bio: ${user.subreddit.public_description}`);
        if (user.subreddit?.title && user.subreddit.title !== user.name) identityParts.push(`Display name: ${user.subreddit.title}`);

        return [{
          category: "account_found",
          severity: identityParts.length > 0 ? "medium" : "low",
          title: `Reddit: u/${user.name} — ${accountAgeYears}yr account, ${user.total_karma || 0} karma`,
          description: [
            `Account age: ${accountAgeYears} years`,
            `Total karma: ${user.total_karma || 0} (${user.link_karma || 0} post, ${user.comment_karma || 0} comment)`,
            ...identityParts,
            user.has_verified_email ? "Email verified: yes" : "Email verified: no",
          ].join("\n"),
          sourceUrl: `https://www.reddit.com/user/${user.name}`,
          rawData: {
            platform: "reddit",
            profileData: {
              name: user.name, created_utc: user.created_utc,
              total_karma: user.total_karma, link_karma: user.link_karma,
              comment_karma: user.comment_karma, has_verified_email: user.has_verified_email,
              icon_img: user.icon_img, snoovatar_img: user.snoovatar_img,
              bio: user.subreddit?.public_description, displayName: user.subreddit?.title,
            },
          },
          remediation: identityParts.length > 0
            ? "Review Reddit profile bio for personal information. Activity patterns may reveal location/timezone."
            : null,
        }];
      } finally {
        release();
      }
    },
  },

  // Instagram — check profile page meta tags (no auth needed for public profiles)
  {
    name: "Instagram",
    platform: "instagram",
    async extract(username, rateLimiter) {
      const release = await rateLimiter.acquire();
      try {
        const status = await safeHead(`https://www.instagram.com/${encodeURIComponent(username)}/`);
        if (status !== 200) return null;

        return [{
          category: "account_found",
          severity: "low",
          title: `Instagram: @${username} — public profile exists`,
          description: `Instagram profile is publicly accessible. Full profile data requires authenticated access.`,
          sourceUrl: `https://www.instagram.com/${username}/`,
          rawData: { platform: "instagram", username, accessible: true, status },
          remediation: "Set Instagram account to private if you don't want your posts publicly visible.",
        }];
      } finally {
        release();
      }
    },
  },

  // TikTok — check profile page
  {
    name: "TikTok",
    platform: "tiktok",
    async extract(username, rateLimiter) {
      const release = await rateLimiter.acquire();
      try {
        const status = await safeHead(`https://www.tiktok.com/@${encodeURIComponent(username)}`);
        if (status !== 200) return null;

        return [{
          category: "account_found",
          severity: "low",
          title: `TikTok: @${username} — profile exists`,
          description: `TikTok profile found at tiktok.com/@${username}.`,
          sourceUrl: `https://www.tiktok.com/@${username}`,
          rawData: { platform: "tiktok", username, accessible: true, status },
          remediation: "Review TikTok privacy settings. Consider making your account private if not intended for public audience.",
        }];
      } finally {
        release();
      }
    },
  },

  // Twitter/X via Nitter instances
  {
    name: "Twitter/X",
    platform: "twitter",
    async extract(username, rateLimiter) {
      const nitterInstances = [
        `https://nitter.privacydev.net/${username}`,
        `https://nitter.poast.org/${username}`,
      ];

      for (const url of nitterInstances) {
        const release = await rateLimiter.acquire();
        try {
          const status = await safeHead(url);
          if (status === 200) {
            return [{
              category: "account_found",
              severity: "low",
              title: `Twitter/X: @${username} — profile accessible via Nitter`,
              description: `Twitter/X profile found. Access via Nitter for privacy-preserving viewing.`,
              sourceUrl: `https://x.com/${username}`,
              rawData: { platform: "twitter", username, nitterUrl: url, accessible: true },
              remediation: "Review Twitter/X privacy settings. Consider protecting tweets if account is personal.",
            }];
          }
        } finally {
          release();
        }
      }
      return null;
    },
  },

  // LinkedIn — Google CSE dork (no direct API without auth)
  {
    name: "LinkedIn",
    platform: "linkedin",
    async extract(username, rateLimiter) {
      const googleApiKey = process.env.GOOGLE_API_KEY;
      const googleCseId = process.env.GOOGLE_CSE_ID;

      if (!googleApiKey || !googleCseId) {
        return [{
          category: "account_found",
          severity: "info",
          title: `LinkedIn: manual check needed for "${username}"`,
          description: `LinkedIn requires Google CSE for automated lookup. Manual search: site:linkedin.com/in/ "${username}"`,
          rawData: { platform: "linkedin", username, reason: "no_google_api_key", manualQuery: `site:linkedin.com/in/ "${username}"` },
        }];
      }

      const release = await rateLimiter.acquire();
      try {
        const query = `site:linkedin.com/in/ "${username}"`;
        const url = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleCseId}&q=${encodeURIComponent(query)}&num=5`;
        const data = await safeFetchJson(url, { timeout: 10000 });

        if (!data || !data.items || data.items.length === 0) return null;

        const topResult = data.items[0];
        return [{
          category: "account_found",
          severity: "medium",
          title: `LinkedIn: "${topResult.title}" matches username`,
          description: `Google found ${data.items.length} LinkedIn result(s):\n${data.items.slice(0, 3).map((i) => `  ${i.title}\n  ${i.link}`).join("\n")}`,
          sourceUrl: topResult.link,
          rawData: {
            platform: "linkedin", username, query,
            results: data.items.slice(0, 3).map((i) => ({ title: i.title, link: i.link, snippet: i.snippet })),
          },
          remediation: "Review LinkedIn profile visibility settings. Limit public profile information to essential details.",
        }];
      } finally {
        release();
      }
    },
  },
];

module.exports = {
  name: "social-deep",
  profileTypes: ["username"],

  async scan(profile, rateLimiter) {
    const username = profile.value;
    const findings = [];

    for (const extractor of EXTRACTORS) {
      try {
        const result = await extractor.extract(username, rateLimiter);
        if (result && result.length > 0) {
          findings.push(...result);
        }
      } catch (err) {
        console.error(`[social-deep] ${extractor.name} error:`, err.message);
      }
    }

    if (findings.length === 0) {
      findings.push({
        category: "account_found",
        severity: "info",
        title: "No deep social media data found",
        description: `No deep profile data could be extracted for "${username}". Profiles may be private or username may not exist on checked platforms.`,
        rawData: { username, found: false },
      });
    }

    return findings;
  },
};
