// GitHub secret scanner module — DumpsterDiver-style search for exposed secrets
// Searches public GitHub repos for API keys, credentials, .env files, private keys
// Uses GitHub Search API (no key needed for basic, GITHUB_TOKEN for higher rate limits)

const GITHUB_API = "https://api.github.com";

// Secret patterns with regex and severity
const SECRET_PATTERNS = [
  { name: "AWS Access Key", pattern: /AKIA[0-9A-Z]{16}/g, severity: "critical" },
  { name: "AWS Secret Key", pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/g, severity: "critical" },
  { name: "Google API Key", pattern: /AIza[0-9A-Za-z_-]{35}/g, severity: "high" },
  { name: "Stripe Secret Key", pattern: /sk_live_[0-9a-zA-Z]{24,}/g, severity: "critical" },
  { name: "Stripe Publishable Key", pattern: /pk_live_[0-9a-zA-Z]{24,}/g, severity: "medium" },
  { name: "GitHub Token", pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g, severity: "critical" },
  { name: "Slack Token", pattern: /xox[bpras]-[0-9A-Za-z-]{10,}/g, severity: "high" },
  { name: "Slack Webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g, severity: "high" },
  { name: "Twilio API Key", pattern: /SK[0-9a-fA-F]{32}/g, severity: "high" },
  { name: "SendGrid API Key", pattern: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g, severity: "high" },
  { name: "Mailgun API Key", pattern: /key-[0-9a-zA-Z]{32}/g, severity: "high" },
  { name: "JWT Secret", pattern: /(?:jwt_secret|JWT_SECRET|jwt_key)\s*[=:]\s*["']([^"']{8,})["']/gi, severity: "high" },
  { name: "Database URL", pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^\s"']+/g, severity: "high" },
  { name: "Private Key", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, severity: "critical" },
  { name: "Heroku API Key", pattern: /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, severity: "medium" },
  { name: "Generic Secret", pattern: /(?:password|passwd|secret|api_key|apikey|access_token)\s*[=:]\s*["']([^"']{8,})["']/gi, severity: "medium" },
];

// Files that commonly contain secrets
const SENSITIVE_FILENAMES = [".env", ".env.local", ".env.production", "credentials.json", "service-account.json", "id_rsa", "id_ed25519", ".npmrc", ".pypirc", "wp-config.php", "config.php", "database.yml", "secrets.yml"];

async function githubFetch(url, rateLimiter) {
  const release = await rateLimiter.acquire();
  try {
    const headers = {
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "OSINT-Scanner/1.0",
    };
    const token = process.env.GITHUB_TOKEN;
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining === "0") throw new Error("GitHub rate limit exceeded");
    }
    if (!res.ok) return null;
    return await res.json();
  } finally {
    release();
  }
}

module.exports = {
  name: "secret-scanner",
  profileTypes: ["username", "email"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const value = profile.value;
    const isEmail = profile.profile_type === "email";

    // Step 1: For username profiles, search their public repos
    if (!isEmail) {
      // Check if GitHub user exists
      const userData = await githubFetch(`${GITHUB_API}/users/${value}`, rateLimiter);
      if (!userData) {
        findings.push({
          category: "exposure",
          severity: "info",
          title: `No GitHub user found for "${value}"`,
          description: "Username does not match a GitHub account. Secret scanning skipped.",
          rawData: { username: value, reason: "no_github_user" },
        });
        return findings;
      }

      const publicRepos = userData.public_repos || 0;
      findings.push({
        category: "exposure",
        severity: "info",
        title: `GitHub user "${value}" has ${publicRepos} public repo(s)`,
        description: `Account: ${userData.html_url}\nCreated: ${userData.created_at}\nBio: ${userData.bio || "N/A"}`,
        rawData: { username: value, publicRepos, profileUrl: userData.html_url },
      });

      // Step 2: Search for sensitive files in user's repos
      for (const filename of SENSITIVE_FILENAMES.slice(0, 8)) {
        try {
          const searchUrl = `${GITHUB_API}/search/code?q=filename:${filename}+user:${value}&per_page=5`;
          const data = await githubFetch(searchUrl, rateLimiter);
          if (data && data.total_count > 0) {
            const repos = [...new Set(data.items.map((i) => i.repository.full_name))];
            findings.push({
              category: "exposure",
              severity: filename.includes("key") || filename === ".env" ? "high" : "medium",
              title: `Sensitive file "${filename}" found in ${data.total_count} location(s)`,
              description: `Repos: ${repos.join(", ")}`,
              sourceUrl: data.items[0]?.html_url,
              rawData: {
                filename, totalCount: data.total_count,
                repos, items: data.items.slice(0, 5).map((i) => ({ repo: i.repository.full_name, path: i.path, url: i.html_url })),
              },
              remediation: `Remove "${filename}" from public repos. Add it to .gitignore. Rotate any exposed credentials immediately.`,
            });
          }
        } catch {
          // Rate limited or error — continue
        }
      }

      // Step 3: Search for secret patterns in user's code
      const secretQueries = [
        { query: `AKIA user:${value}`, name: "AWS keys" },
        { query: `sk_live user:${value}`, name: "Stripe keys" },
        { query: `password user:${value} filename:.env`, name: "Passwords in .env" },
        { query: `BEGIN PRIVATE KEY user:${value}`, name: "Private keys" },
        { query: `api_key user:${value} filename:.json`, name: "API keys in JSON" },
      ];

      for (const sq of secretQueries) {
        try {
          const searchUrl = `${GITHUB_API}/search/code?q=${encodeURIComponent(sq.query)}&per_page=5`;
          const data = await githubFetch(searchUrl, rateLimiter);
          if (data && data.total_count > 0) {
            findings.push({
              category: "breach",
              severity: "critical",
              title: `Potential ${sq.name} exposed in public code (${data.total_count} match(es))`,
              description: data.items.slice(0, 3).map((i) => `  ${i.repository.full_name}/${i.path}`).join("\n"),
              sourceUrl: data.items[0]?.html_url,
              rawData: {
                query: sq.query, totalCount: data.total_count,
                items: data.items.slice(0, 5).map((i) => ({ repo: i.repository.full_name, path: i.path, url: i.html_url })),
              },
              remediation: "Rotate ALL exposed credentials immediately. Remove sensitive data from git history using git filter-branch or BFG Repo-Cleaner.",
            });
          }
        } catch {
          // Rate limited — continue
        }
      }
    }

    // Step 4: For email profiles, search for email in code/configs
    if (isEmail) {
      const emailQueries = [
        { query: `"${value}" filename:.env`, name: "Email in .env files" },
        { query: `"${value}" filename:.yml`, name: "Email in YAML configs" },
        { query: `"${value}" filename:.json`, name: "Email in JSON configs" },
        { query: `"${value}" filename:.xml`, name: "Email in XML files" },
      ];

      for (const eq of emailQueries) {
        try {
          const searchUrl = `${GITHUB_API}/search/code?q=${encodeURIComponent(eq.query)}&per_page=5`;
          const data = await githubFetch(searchUrl, rateLimiter);
          if (data && data.total_count > 0) {
            findings.push({
              category: "exposure",
              severity: "medium",
              title: `Email found in ${data.total_count} public file(s): ${eq.name}`,
              description: data.items.slice(0, 3).map((i) => `  ${i.repository.full_name}/${i.path}`).join("\n"),
              sourceUrl: data.items[0]?.html_url,
              rawData: {
                email: value, query: eq.query, totalCount: data.total_count,
                items: data.items.slice(0, 5).map((i) => ({ repo: i.repository.full_name, path: i.path, url: i.html_url })),
              },
              remediation: "Your email appears in public code repositories. Review each occurrence and request removal if unauthorized.",
            });
          }
        } catch {
          // Rate limited — continue
        }
      }
    }

    if (findings.length === 0) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "No exposed secrets found on GitHub",
        description: `Searched for sensitive files and secret patterns associated with "${value}". No matches found.`,
        rawData: { value, profileType: profile.profile_type },
      });
    }

    return findings;
  },
};
