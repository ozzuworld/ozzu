// GitHub Intelligence Module — public API (no auth needed for basic lookups)
// Extracts: profile, repos, contributions, organizations, email, social links

async function safeFetchJson(url, timeout = 10000) {
  try {
    const headers = { "User-Agent": "OzzuIntel/1.0", "Accept": "application/vnd.github.v3+json" };
    const token = process.env.GITHUB_TOKEN;
    if (token) headers.Authorization = `token ${token}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

module.exports = {
  name: "github-intel",
  profileTypes: ["username"],

  async scan(profile) {
    const findings = [];
    const username = profile.value;
    if (!username || username.length < 2) return findings;

    // 1. Get user profile
    const user = await safeFetchJson(`https://api.github.com/users/${encodeURIComponent(username)}`);
    if (!user || user.message) {
      findings.push({ category: "intelligence", severity: "info", title: `GitHub: user "${username}" not found`, rawData: { type: "github_miss", username } });
      return findings;
    }

    // 2. Get repos
    const repos = await safeFetchJson(`https://api.github.com/users/${encodeURIComponent(username)}/repos?sort=updated&per_page=30`);
    const repoList = (repos || []).map(r => ({
      name: r.name,
      description: r.description?.substring(0, 200),
      language: r.language,
      stars: r.stargazers_count,
      forks: r.forks_count,
      updatedAt: r.updated_at,
      url: r.html_url,
    }));

    // 3. Get orgs
    const orgs = await safeFetchJson(`https://api.github.com/users/${encodeURIComponent(username)}/orgs`);
    const orgList = (orgs || []).map(o => ({ login: o.login, description: o.description, avatarUrl: o.avatar_url }));

    // 4. Get recent events (public activity)
    const events = await safeFetchJson(`https://api.github.com/users/${encodeURIComponent(username)}/events/public?per_page=30`);
    const recentActivity = (events || []).slice(0, 20).map(e => ({
      type: e.type,
      repo: e.repo?.name,
      createdAt: e.created_at,
    }));

    const totalStars = repoList.reduce((sum, r) => sum + (r.stars || 0), 0);
    const languages = [...new Set(repoList.map(r => r.language).filter(Boolean))];

    findings.push({
      category: "intelligence",
      severity: user.public_repos > 10 || totalStars > 50 ? "high" : "medium",
      title: `GitHub: ${user.login} — ${user.public_repos} repos, ${user.followers} followers, ${totalStars} stars`,
      description: [
        user.name ? `Name: ${user.name}` : null,
        user.bio ? `Bio: ${user.bio}` : null,
        user.company ? `Company: ${user.company}` : null,
        user.location ? `Location: ${user.location}` : null,
        user.email ? `Email: ${user.email}` : null,
        user.blog ? `Website: ${user.blog}` : null,
        user.twitter_username ? `Twitter: @${user.twitter_username}` : null,
        languages.length ? `Languages: ${languages.join(", ")}` : null,
        `Account created: ${user.created_at}`,
      ].filter(Boolean).join("\n"),
      rawData: {
        type: "github_profile",
        profile: {
          login: user.login,
          name: user.name,
          bio: user.bio,
          company: user.company,
          location: user.location,
          email: user.email,
          blog: user.blog,
          twitterUsername: user.twitter_username,
          followers: user.followers,
          following: user.following,
          publicRepos: user.public_repos,
          publicGists: user.public_gists,
          createdAt: user.created_at,
          avatarUrl: user.avatar_url,
          profileUrl: user.html_url,
        },
        repos: repoList,
        organizations: orgList,
        recentActivity,
        totalStars,
        languages,
      },
    });

    // Extract social pivots
    if (user.twitter_username) {
      findings.push({
        category: "identity", severity: "medium",
        title: `GitHub: Twitter account — @${user.twitter_username}`,
        rawData: { type: "discovered_profile", platform: "twitter", username: user.twitter_username, source: "github", confidence: 0.95, pivotRecommended: true },
      });
    }
    if (user.email) {
      findings.push({
        category: "identity", severity: "medium",
        title: `GitHub: email — ${user.email}`,
        rawData: { type: "pivot_recommendation", pivotType: "email", pivotValue: user.email, confidence: 0.95, autoExecute: true },
      });
    }

    return findings;
  },
};
