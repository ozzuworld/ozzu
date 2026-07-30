"use strict";

// Relevance + scoring for the Jobs inbox (dir_1785424018953). Turns a raw remote-job
// feed (mostly non-engineering noise) into a ranked list of software-engineering roles
// King Kazuma could actually take. Config lives in scope.json (tunable, like SECOP's
// overlay.json): edit it, then re-score with POST /jobs/rescore — no re-fetch needed.
//
// A job is RELEVANT when its title is not vetoed by exclude_title AND (its title carries a
// software-engineering role signal OR it matches >= min_skill_matches skill keywords).
// SCORE ranks the inbox: skills matched + role signal + salary known + LatAm-reachable +
// recent + seniority.

const SCOPE = require("./scope.json");

// Normalize to a space-delimited, boundary-safe haystack. Keeps + # . (c++, node.js) but
// turns every other separator into a space, and wraps in spaces so " go " can't match
// "google". Both the haystack and each needle are normalized the same way, so a multi-word
// needle (" react native ") only matches a contiguous run.
function norm(s) {
  return " " + String(s || "").toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").replace(/\s+/g, " ").trim() + " ";
}
function contains(haystack, needle) {
  const n = norm(needle);
  return n.length > 2 && haystack.includes(n);
}

function isLatamReachable(rec) {
  const tzs = Array.isArray(rec.timezone_restrictions) ? rec.timezone_restrictions : [];
  if (tzs.length && tzs.some((t) => SCOPE.latam_reachable.timezones.includes(Number(t)))) return true;

  const countries = (Array.isArray(rec.location_restrictions) ? rec.location_restrictions : []).map((c) => String(c).toLowerCase());
  // No explicit country restriction on a remote board = worldwide = reachable.
  if (countries.length === 0) {
    const loc = String(rec.location || "").toLowerCase();
    if (!loc) return true; // RemoteOK etc. — global remote, no restriction data
    return /worldwide|anywhere|global|remote|americas|latin|latam|south america|colombia|united states|canada|brazil|mexico|argentina/.test(loc);
  }
  return countries.some((c) => SCOPE.latam_reachable.countries.some((ok) => c.includes(ok)));
}

// rec: normalized job record (pre-score). Returns { relevant, score, matched_skills, latam_reachable }.
function scoreJob(rec) {
  const titleHay = norm(rec.title);
  // Title veto — precise, so a real eng job that merely mentions "sales" in its body survives.
  if (SCOPE.exclude_title.some((t) => titleHay.includes(norm(t)))) {
    return { relevant: false, score: 0, matched_skills: [], latam_reachable: isLatamReachable(rec) };
  }

  const tags = Array.isArray(rec.tags) ? rec.tags.join(" ") : "";
  const hay = norm([rec.title, rec.title, tags, rec.excerpt, String(rec.description || "").slice(0, 800)].join(" "));

  const matched = SCOPE.skills.filter((s) => contains(hay, s));
  const roleSignal = SCOPE.role_signals.some((r) => titleHay.includes(norm(r)));
  const latam = isLatamReachable(rec);

  const salaryPresent = Number(rec.salary_max) > 0 || Number(rec.salary_min) > 0;
  const minSal = Number(SCOPE.min_salary_usd) || 0;
  // Only excludes when a KNOWN salary is below floor; unknown-salary jobs pass.
  const salaryVeto = minSal > 0 && salaryPresent && Number(rec.salary_max || rec.salary_min) < minSal;

  const relevant = !salaryVeto && (roleSignal || matched.length >= (SCOPE.min_skill_matches || 2));

  const w = SCOPE.score_weights || {};
  const recent7d = rec.posted_at && (Date.now() - new Date(rec.posted_at).getTime()) < 7 * 864e5;
  const seniorPlus =
    (Array.isArray(rec.seniority) && rec.seniority.some((x) => /senior|staff|principal|lead/i.test(x))) ||
    /senior|staff|principal|lead/i.test(titleHay);

  const score =
    matched.length * (w.per_skill ?? 1) +
    (roleSignal ? (w.role_signal ?? 4) : 0) +
    (salaryPresent ? (w.salary_present ?? 2) : 0) +
    (latam ? (w.latam_reachable ?? 3) : 0) +
    (recent7d ? (w.recent_7d ?? 2) : 0) +
    (seniorPlus ? (w.senior_plus ?? 1) : 0);

  return { relevant, score, matched_skills: matched, latam_reachable: latam };
}

module.exports = { scoreJob, isLatamReachable, norm };
