"use strict";

// Himalayas source (https://himalayas.app/jobs/api — free, no key; OpenAPI-documented).
// Response: { jobs:[...], totalCount, limit, offset }. Jobs carry salary (currency +
// period), employmentType, seniority, and — uniquely useful for a Bogota (UTC-5) engineer —
// locationRestrictions (countries) + timezoneRestrictions (UTC offsets), which scope.js uses
// to rank LatAm-reachable roles. `guid` is a full URL, so we hash it to a URL-safe source_id.

const { fetchJSON, num, str, stripHtml, sha1short, tsToDate } = require("../util");

const SOURCE = "himalayas";
const BASE = process.env.JOBS_HIMALAYAS_URL || "https://himalayas.app/jobs/api";
const PAGE = parseInt(process.env.JOBS_HIMALAYAS_PAGE) || 20;   // API hard-caps page size at 20
const MAX_PAGES = parseInt(process.env.JOBS_HIMALAYAS_PAGES) || 15; // ~300 most-recent listings

async function fetch() {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${BASE}?limit=${PAGE}&offset=${page * PAGE}`;
    const d = await fetchJSON(url, { timeout: 30000 });
    const jobs = (d && Array.isArray(d.jobs)) ? d.jobs : [];
    if (jobs.length === 0) break;
    out.push(...jobs);
    if (jobs.length < PAGE) break;
  }
  return out.filter((r) => r && r.guid && r.title);
}

// Himalayas category slugs look like "Software-Engineering" → "software engineering".
const deslug = (s) => String(s || "").replace(/[-_]+/g, " ").trim();

function normalize(row) {
  const source_id = sha1short(row.guid);
  const cats = [].concat(row.categories || [], row.parentCategories || []).map(deslug).filter(Boolean);
  return {
    id: `${SOURCE}:${source_id}`,
    source: SOURCE,
    source_id,
    title: str(row.title),
    company: str(row.companyName),
    company_logo: str(row.companyLogo),
    url: str(row.guid),
    apply_url: str(row.applicationLink) || str(row.guid),
    location: null,
    location_restrictions: Array.isArray(row.locationRestrictions) ? row.locationRestrictions.map(String) : [],
    timezone_restrictions: Array.isArray(row.timezoneRestrictions) ? row.timezoneRestrictions.map(Number).filter(Number.isFinite) : [],
    remote: true,
    employment_type: str(row.employmentType),
    seniority: Array.isArray(row.seniority) ? row.seniority.map(String) : [],
    tags: cats,
    salary_min: num(row.minSalary),
    salary_max: num(row.maxSalary),
    salary_currency: str(row.currency),
    salary_period: str(row.salaryPeriod),
    description: str(row.description),
    excerpt: str(row.excerpt) || stripHtml(row.description, 300),
    posted_at: tsToDate(row.pubDate),
    expires_at: tsToDate(row.expiryDate),
    raw: row,
  };
}

module.exports = { SOURCE, fetch, normalize };
