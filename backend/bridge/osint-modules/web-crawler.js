// Web crawler module — Photon-style link/email/social extraction from web pages
// Crawls target domain or known profile pages to discover emails, phone numbers, social links
// No API keys needed

const db = require("../db");

// Social media URL patterns for detection
const SOCIAL_PATTERNS = [
  { name: "Twitter/X", pattern: /https?:\/\/(www\.)?(twitter\.com|x\.com)\/[a-zA-Z0-9_]+/gi },
  { name: "Facebook", pattern: /https?:\/\/(www\.)?facebook\.com\/[a-zA-Z0-9._]+/gi },
  { name: "Instagram", pattern: /https?:\/\/(www\.)?instagram\.com\/[a-zA-Z0-9_.]+/gi },
  { name: "LinkedIn", pattern: /https?:\/\/(www\.)?linkedin\.com\/(in|company)\/[a-zA-Z0-9_-]+/gi },
  { name: "GitHub", pattern: /https?:\/\/(www\.)?github\.com\/[a-zA-Z0-9_-]+/gi },
  { name: "YouTube", pattern: /https?:\/\/(www\.)?youtube\.com\/(c|channel|user|@)[a-zA-Z0-9_-]+/gi },
  { name: "TikTok", pattern: /https?:\/\/(www\.)?tiktok\.com\/@[a-zA-Z0-9_.]+/gi },
  { name: "Reddit", pattern: /https?:\/\/(www\.)?reddit\.com\/(user|u)\/[a-zA-Z0-9_-]+/gi },
  { name: "Pinterest", pattern: /https?:\/\/(www\.)?pinterest\.com\/[a-zA-Z0-9_]+/gi },
  { name: "Telegram", pattern: /https?:\/\/(t\.me|telegram\.me)\/[a-zA-Z0-9_]+/gi },
  { name: "Discord", pattern: /https?:\/\/(www\.)?discord\.(gg|com\/invite)\/[a-zA-Z0-9]+/gi },
  { name: "Medium", pattern: /https?:\/\/(www\.)?medium\.com\/@[a-zA-Z0-9._]+/gi },
  { name: "Mastodon", pattern: /https?:\/\/[a-zA-Z0-9.-]+\/@[a-zA-Z0-9_]+/gi },
];

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Require + prefix or (area code) format to reduce false positives from random digit sequences
const PHONE_REGEX = /(?:\+[1-9]\d{0,2}[-.\s]?)(?:\(?[0-9]{2,3}\)?[-.\s]?)?[0-9]{3,4}[-.\s]?[0-9]{3,4}|\(?[0-9]{3}\)[-.\s][0-9]{3}[-.\s]?[0-9]{4}/g;

const MAX_PAGES = 20;
const PAGE_TIMEOUT = 5000;
const MAX_BODY_SIZE = 500000; // 500KB per page

async function fetchPage(url, rateLimiter) {
  const release = await rateLimiter.acquire();
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OSINT-Scanner/1.0)",
        "Accept": "text/html",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(PAGE_TIMEOUT),
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) return null;
    const text = await res.text();
    return text.slice(0, MAX_BODY_SIZE);
  } catch {
    return null;
  } finally {
    release();
  }
}

function extractLinks(html, baseUrl) {
  const links = new Set();
  // Match href attributes
  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    let href = match[1];
    if (href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) continue;
    try {
      const resolved = new URL(href, baseUrl).href;
      links.add(resolved);
    } catch { /* invalid URL */ }
  }
  return links;
}

function extractEmails(html) {
  const matches = html.match(EMAIL_REGEX) || [];
  // Filter out common false positives
  return [...new Set(matches)].filter((e) =>
    !e.endsWith(".png") && !e.endsWith(".jpg") && !e.endsWith(".gif") &&
    !e.endsWith(".css") && !e.endsWith(".js") && !e.includes("example.com") &&
    !e.includes("sentry.io") && !e.includes("webpack")
  );
}

function extractPhones(html) {
  const matches = html.match(PHONE_REGEX) || [];
  return [...new Set(matches)].filter((p) => {
    const digits = p.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) return false;
    // Filter out sequential/repeated patterns (0123456789, 1111111111, etc.)
    if (/^(\d)\1+$/.test(digits)) return false;
    if (/0123456789|1234567890|9876543210/.test(digits)) return false;
    return true;
  });
}

function extractSocialLinks(html) {
  const found = [];
  for (const social of SOCIAL_PATTERNS) {
    const matches = html.match(social.pattern) || [];
    for (const url of [...new Set(matches)]) {
      found.push({ platform: social.name, url });
    }
  }
  return found;
}

function extractMeta(html) {
  const meta = {};
  // Title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) meta.title = titleMatch[1].trim();
  // Meta description
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  if (descMatch) meta.description = descMatch[1].trim();
  // Generator
  const genMatch = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i);
  if (genMatch) meta.generator = genMatch[1].trim();
  // OG tags
  const ogMatch = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  if (ogMatch) meta.siteName = ogMatch[1].trim();
  return meta;
}

module.exports = {
  name: "web-crawler",
  profileTypes: ["domain", "username"],

  async scan(profile, rateLimiter) {
    const findings = [];
    const allEmails = new Set();
    const allPhones = new Set();
    const allSocial = new Map(); // url -> {platform, url}
    const crawledPages = new Set();

    let seedUrls = [];

    if (profile.profile_type === "domain") {
      seedUrls = [`https://${profile.value}`, `http://${profile.value}`];
    } else {
      // For username profiles, crawl known profile pages from previous findings
      try {
        const existingFindings = await db.getOsintFindings({ profileId: profile.id, limit: 100 });
        for (const f of existingFindings) {
          if (f.source_url && f.source_url.startsWith("http")) {
            seedUrls.push(f.source_url);
          }
        }
      } catch { /* db error */ }
    }

    if (seedUrls.length === 0) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "No pages to crawl",
        description: "Run other scans first (username-enum, domain-recon) to discover URLs, then re-run web-crawler.",
        rawData: { reason: "no_seed_urls" },
      });
      return findings;
    }

    // Crawl seed pages + discovered internal links (depth 2)
    const toVisit = [...new Set(seedUrls)].slice(0, 5); // Start with up to 5 seeds
    const baseDomain = profile.profile_type === "domain" ? profile.value : null;

    for (const url of toVisit) {
      if (crawledPages.size >= MAX_PAGES) break;
      if (crawledPages.has(url)) continue;
      crawledPages.add(url);

      const html = await fetchPage(url, rateLimiter);
      if (!html) continue;

      // Extract data from this page
      const emails = extractEmails(html);
      const phones = extractPhones(html);
      const social = extractSocialLinks(html);
      const meta = extractMeta(html);

      emails.forEach((e) => allEmails.add(e));
      phones.forEach((p) => allPhones.add(p));
      social.forEach((s) => allSocial.set(s.url, s));

      // Discover internal links for further crawling (domain profiles only)
      if (baseDomain && crawledPages.size < MAX_PAGES) {
        const links = extractLinks(html, url);
        for (const link of links) {
          try {
            const linkDomain = new URL(link).hostname;
            if ((linkDomain === baseDomain || linkDomain.endsWith(`.${baseDomain}`)) && !crawledPages.has(link)) {
              if (toVisit.length < MAX_PAGES) toVisit.push(link);
            }
          } catch { /* invalid */ }
        }
      }

      // Report meta/technology for first page
      if (crawledPages.size === 1 && Object.keys(meta).length > 0) {
        findings.push({
          category: "exposure",
          severity: "info",
          title: `Site metadata for ${url}`,
          description: Object.entries(meta).map(([k, v]) => `  ${k}: ${v}`).join("\n"),
          rawData: { url, meta },
        });
      }
    }

    // Report findings
    findings.push({
      category: "exposure",
      severity: "info",
      title: `Crawled ${crawledPages.size} page(s)`,
      description: `Seed URLs: ${seedUrls.length}, Pages crawled: ${crawledPages.size}/${MAX_PAGES}`,
      rawData: { pagesCrawled: crawledPages.size, seedUrls: seedUrls.slice(0, 5) },
    });

    // Emails found
    if (allEmails.size > 0) {
      findings.push({
        category: "exposure",
        severity: "medium",
        title: `${allEmails.size} email address(es) discovered on web pages`,
        description: [...allEmails].map((e) => `  ${e}`).join("\n"),
        rawData: { emails: [...allEmails] },
        remediation: "Review publicly visible email addresses. Use contact forms instead of exposing emails directly. Consider using aliases.",
      });
    }

    // Phone numbers found
    if (allPhones.size > 0) {
      findings.push({
        category: "exposure",
        severity: "medium",
        title: `${allPhones.size} phone number(s) discovered on web pages`,
        description: [...allPhones].map((p) => `  ${p}`).join("\n"),
        rawData: { phones: [...allPhones] },
        remediation: "Phone numbers on public pages can be used for social engineering. Use virtual numbers or contact forms.",
      });
    }

    // Social media links
    if (allSocial.size > 0) {
      const socialList = [...allSocial.values()];
      const byPlatform = {};
      for (const s of socialList) {
        if (!byPlatform[s.platform]) byPlatform[s.platform] = [];
        byPlatform[s.platform].push(s.url);
      }

      findings.push({
        category: "account_found",
        severity: "low",
        title: `${allSocial.size} social media link(s) found on web pages`,
        description: Object.entries(byPlatform).map(([p, urls]) => `  ${p}: ${urls.join(", ")}`).join("\n"),
        rawData: { socialLinks: socialList, byPlatform },
        remediation: "Linked social accounts can be used to build a complete profile. Review which accounts are cross-linked.",
      });
    }

    return findings;
  },
};
