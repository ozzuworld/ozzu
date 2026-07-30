"use strict";

// RemoteOK source (https://remoteok.com/api — free, no auth). Returns a JSON array whose
// FIRST element is metadata (legal/last_updated), the rest are jobs. All listings are
// remote; salaries are annual USD (0 = unknown). RemoteOK's ToS asks for attribution +
// a linkback to the job's remoteok.com URL — the app credits `source` and links `url`.

const { fetchJSON, num, str, stripHtml } = require("../util");

const SOURCE = "remoteok";
const BASE = process.env.JOBS_REMOTEOK_URL || "https://remoteok.com/api";

async function fetch() {
  const arr = await fetchJSON(BASE, { timeout: 30000 });
  if (!Array.isArray(arr)) return [];
  // Drop the leading metadata object (has `legal`, no `id`).
  return arr.filter((r) => r && r.id && (r.position || r.company));
}

function normalize(row) {
  const source_id = String(row.id);
  return {
    id: `${SOURCE}:${source_id}`,
    source: SOURCE,
    source_id,
    title: str(row.position),
    company: str(row.company),
    company_logo: str(row.company_logo) || str(row.logo),
    url: str(row.url),
    apply_url: str(row.apply_url) || str(row.url),
    location: str(row.location),
    location_restrictions: [],
    timezone_restrictions: [],
    remote: true,
    employment_type: null,
    seniority: [],
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    salary_min: num(row.salary_min),
    salary_max: num(row.salary_max),
    salary_currency: (num(row.salary_min) || num(row.salary_max)) ? "USD" : null,
    salary_period: (num(row.salary_min) || num(row.salary_max)) ? "annual" : null,
    description: str(row.description),
    excerpt: stripHtml(row.description, 300),
    posted_at: str(row.date),
    expires_at: null,
    raw: row,
  };
}

module.exports = { SOURCE, fetch, normalize };
