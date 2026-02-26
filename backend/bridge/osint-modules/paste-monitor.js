// Paste site monitoring + search exposure module
// Checks public paste sites and search engine caches for exposed information
// Free — HTTP requests only, no API keys needed

// Google dork patterns for finding exposed personal info
const DORK_PATTERNS = [
  {
    name: "site_linkedin",
    template: 'site:linkedin.com/in/ "{}"',
    description: "LinkedIn public profile",
    severity: "medium",
    remediation: "Review LinkedIn privacy settings. Set profile visibility to connections only if needed.",
  },
  {
    name: "site_facebook",
    template: 'site:facebook.com "{}"',
    description: "Facebook public profile or mentions",
    severity: "medium",
    remediation: "Review Facebook privacy settings. Lock your profile to friends only.",
  },
  {
    name: "filetype_pdf",
    template: 'filetype:pdf "{}"',
    description: "PDF documents containing this value",
    severity: "high",
    remediation: "Request removal of PDFs containing personal info. Use Google's removal tool for cached results.",
  },
  {
    name: "filetype_doc",
    template: 'filetype:doc OR filetype:docx "{}"',
    description: "Word documents containing this value",
    severity: "high",
    remediation: "Request removal from hosting sites. File DMCA or privacy removal requests with Google.",
  },
  {
    name: "filetype_xls",
    template: 'filetype:xls OR filetype:xlsx "{}"',
    description: "Spreadsheets containing this value (potential data leaks)",
    severity: "critical",
    remediation: "Spreadsheets with personal data are serious leaks. Request immediate removal from the hosting site.",
  },
  {
    name: "paste_sites",
    template: 'site:pastebin.com OR site:ghostbin.com OR site:paste.ee "{}"',
    description: "Paste site mentions (potential credential dumps)",
    severity: "high",
    remediation: "If found in paste sites, change associated passwords immediately. Report the paste for removal.",
  },
  {
    name: "github_exposure",
    template: 'site:github.com "{}"',
    description: "GitHub code/repo mentions",
    severity: "medium",
    remediation: "Review any code or configs that expose this value. Rotate secrets that may have been committed.",
  },
];

// Public paste sites to check directly
const PASTE_SITES = [
  { name: "Pastebin", url: "https://pastebin.com/search?q={}", searchable: true },
  { name: "GitHub Gists", url: "https://gist.github.com/search?q={}", searchable: true },
];

module.exports = {
  name: "paste-monitor",
  profileTypes: ["email", "username"],

  async scan(profile, rateLimiter) {
    const value = profile.value;
    const findings = [];

    // 1. Check paste sites directly (those with search)
    for (const site of PASTE_SITES) {
      if (!site.searchable) continue;

      const release = await rateLimiter.acquire();
      try {
        const searchUrl = site.url.replace("{}", encodeURIComponent(value));
        const res = await fetch(searchUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html",
          },
          signal: AbortSignal.timeout(12000),
          redirect: "follow",
        });

        if (res.ok) {
          const body = await res.text();
          // Check if search returned results (not just the search page)
          const hasResults = (
            (site.name === "Pastebin" && body.includes("search-result") && !body.includes("Nothing found")) ||
            (site.name === "GitHub Gists" && body.includes("gist-snippet") && !body.includes("We couldn't find any"))
          );

          if (hasResults) {
            findings.push({
              category: "exposure",
              severity: "high",
              title: `Found on ${site.name} paste search`,
              description: `The value "${value}" appears in search results on ${site.name}. Paste sites often contain leaked credentials, data dumps, or personal information.`,
              sourceUrl: searchUrl,
              rawData: { site: site.name, searchUrl, hasResults: true },
              remediation: `Check ${site.name} results and request removal of any pastes containing your information.`,
            });
          }
        }
      } catch (_) {
        // Timeout or network error — skip
      } finally {
        release();
      }
    }

    // 2. Generate Google dork findings
    const applicableDorks = DORK_PATTERNS.filter((d) => {
      if (profile.profile_type === "password") return false;
      return true;
    });

    // Try Google Custom Search if API key is available
    const googleApiKey = process.env.GOOGLE_API_KEY;
    const googleCseId = process.env.GOOGLE_CSE_ID;

    if (googleApiKey && googleCseId) {
      for (const dork of applicableDorks.slice(0, 3)) {
        const release = await rateLimiter.acquire();
        try {
          const query = dork.template.replace("{}", value);
          const url = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleCseId}&q=${encodeURIComponent(query)}&num=5`;
          const res = await fetch(url, {
            signal: AbortSignal.timeout(10000),
          });

          if (res.ok) {
            const data = await res.json();
            const totalResults = parseInt(data.searchInformation?.totalResults || "0", 10);

            if (totalResults > 0 && data.items) {
              findings.push({
                category: "exposure",
                severity: dork.severity,
                title: `Google dork: ${dork.description} (${totalResults} results)`,
                description: `Search query "${query}" returned ${totalResults} results. Top results: ${data.items.slice(0, 3).map((i) => i.title).join("; ")}`,
                sourceUrl: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
                rawData: {
                  dork: dork.name,
                  query,
                  totalResults,
                  topResults: data.items.slice(0, 3).map((i) => ({ title: i.title, link: i.link })),
                },
                remediation: dork.remediation,
              });
            }
          }
        } catch (_) {
          // Skip on error
        } finally {
          release();
        }
      }
    } else {
      // No Google API — generate manual dork checklist
      findings.push({
        category: "exposure",
        severity: "info",
        title: `${applicableDorks.length} Google dork queries to check manually`,
        description: `Without a Google Custom Search API key, these dork queries should be checked manually in a browser:\n\n${applicableDorks.map((d) => `• ${d.template.replace("{}", value)}`).join("\n")}`,
        rawData: {
          dorks: applicableDorks.map((d) => ({
            name: d.name,
            query: d.template.replace("{}", value),
            description: d.description,
          })),
          reason: "no_google_api_key",
        },
        remediation: "Set GOOGLE_API_KEY and GOOGLE_CSE_ID environment variables for automated Google dork checking (100 free queries/day).",
      });
    }

    if (findings.length === 0) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "No paste/search exposure found",
        description: `No mentions of "${value}" were found on paste sites or in cached search results.`,
        rawData: { value, found: false },
        remediation: null,
      });
    }

    return findings;
  },
};
