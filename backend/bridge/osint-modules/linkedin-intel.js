// LinkedIn Intelligence Module — CrossLinked (Google/Bing dorks) + Google CSE
// No LinkedIn login needed for passive recon

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
  name: "linkedin-intel",
  profileTypes: ["username", "email"],

  async scan(profile, rateLimiter) {
    const value = profile.value;
    const findings = [];

    const release = await rateLimiter.acquire();
    try {
      // Strategy 1: Google CSE search for LinkedIn profiles
      const googleApiKey = process.env.GOOGLE_API_KEY;
      const googleCseId = process.env.GOOGLE_CSE_ID;

      if (googleApiKey && googleCseId) {
        const query = profile.profile_type === "email"
          ? `site:linkedin.com/in "${value.split("@")[0]}"`
          : `site:linkedin.com/in "${value}"`;

        const data = await safeFetchJson(
          `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleCseId}&q=${encodeURIComponent(query)}&num=5`
        );

        if (data?.items?.length > 0) {
          const linkedinResults = data.items.filter(i => i.link?.includes("linkedin.com/in/"));

          if (linkedinResults.length > 0) {
            const top = linkedinResults[0];
            // Parse LinkedIn title format: "Name - Title - Company | LinkedIn"
            const titleParts = top.title?.split(" - ") || [];
            const name = titleParts[0]?.replace(" | LinkedIn", "").trim();
            const headline = titleParts.slice(1).join(" - ").replace(" | LinkedIn", "").trim();

            // Extract info from snippet
            const locationMatch = top.snippet?.match(/Location:\s*([^·]+)/i) ||
                                  top.snippet?.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2})/);

            findings.push({
              category: "account_found",
              severity: "medium",
              title: `LinkedIn: ${name || value}${headline ? ` — ${headline.substring(0, 60)}` : ""}`,
              description: [
                name && `Name: ${name}`,
                headline && `Headline: ${headline}`,
                locationMatch && `Location: ${locationMatch[1].trim()}`,
                top.snippet && `Snippet: ${top.snippet.substring(0, 200)}`,
                `\nAll results (${linkedinResults.length}):`,
                ...linkedinResults.slice(0, 3).map(r => `  ${r.title}\n  ${r.link}`),
              ].filter(Boolean).join("\n"),
              sourceUrl: top.link,
              rawData: {
                platform: "linkedin",
                profileData: {
                  name,
                  headline,
                  location: locationMatch?.[1]?.trim(),
                  profileUrl: top.link,
                },
                searchResults: linkedinResults.slice(0, 5).map(r => ({
                  title: r.title, link: r.link, snippet: r.snippet,
                })),
                viaGoogle: true,
              },
              remediation: "Review LinkedIn profile visibility. Adjust 'Public profile settings' to limit what's visible to non-connections.",
            });
            return findings;
          }
        }
      }

      // Strategy 2: CrossLinked CLI (if installed in container)
      const crosslinkedResult = await runInContainer("crosslinked", [
        "-f", "{first} {last}",
        `site:linkedin.com/in intext:${value}`,
      ], 30000);

      if (crosslinkedResult && crosslinkedResult.length > 10) {
        const lines = crosslinkedResult.split("\n").filter(l => l.trim());
        const names = lines.filter(l => !l.startsWith("[") && !l.startsWith("Cross") && l.trim().length > 2).slice(0, 10);

        if (names.length > 0) {
          findings.push({
            category: "account_found",
            severity: "medium",
            title: `LinkedIn: ${names.length} profile(s) found via CrossLinked for "${value}"`,
            description: `CrossLinked passive recon results:\n${names.map(n => `  ${n}`).join("\n")}`,
            sourceUrl: `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(value)}`,
            rawData: {
              platform: "linkedin",
              crosslinkedResults: names,
              username: value,
              viaCrossLinked: true,
            },
            remediation: "LinkedIn profiles are indexed by search engines. Adjust SEO settings in LinkedIn to reduce visibility.",
          });
          return findings;
        }
      }

      // Strategy 3: Simple Bing/Google dork without API
      const dorkUrl = `https://www.linkedin.com/in/${encodeURIComponent(value)}`;
      try {
        const res = await fetch(dorkUrl, {
          method: "HEAD",
          headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
          signal: AbortSignal.timeout(8000),
          redirect: "manual",
        });
        // LinkedIn returns 200 for valid profiles, 404/999 for invalid
        if (res.status === 200) {
          findings.push({
            category: "account_found",
            severity: "low",
            title: `LinkedIn: linkedin.com/in/${value} — profile exists`,
            description: `LinkedIn profile URL is valid. Full details require authenticated access.`,
            sourceUrl: dorkUrl,
            rawData: { platform: "linkedin", username: value, directUrlValid: true },
            remediation: "Review LinkedIn public profile settings.",
          });
        }
      } catch (_) {}
    } finally {
      release();
    }

    return findings;
  },
};
