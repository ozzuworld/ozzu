// telemetry-sanitize.js — dir_1782251824781 Fix 2
//
// Shared sanitize helper for offense_telemetry outcome_notes.
//
// WHY THIS EXISTS: 353 had 8 membrane_breach rows originating from
// outcome_notes — CVE IDs in autoverify.match, raw IPs in preflight
// matched snippets, exploit keywords in error paths. The observation
// membrane already redacts these at READ time in analyze_engagement_telemetry
// and membrane-audit.js. This module redacts them at WRITE time so the DB
// never stores the raw values in the first place.
//
// The redaction patterns mirror MEMBRANE_PATTERNS in membrane-audit.js and
// MEMBRANE_GUARD_PATTERNS in offense-engine.js — kept deliberately identical
// so the three sentinels agree on what "sensitive" means. Field-name and
// engagement-id are accepted for the warn log; sanitize() can be called
// without them and still works.
//
// Usage:
//   const { sanitizeOutcomeNotes } = require("/app/soc/telemetry-sanitize");
//   ...
//   sanitizeOutcomeNotes(dynamicString, "outcome_notes", engagementId)
//   ...

"use strict";

// Patterns mirror membrane-audit.js MEMBRANE_PATTERNS and
// offense-engine.js MEMBRANE_GUARD_PATTERNS (keep in sync).
const SANITIZE_PATTERNS = [
  { kind: "cve_id",          regex: /\bCVE-\d{4}-\d{4,7}\b/gi },
  { kind: "exploit_keyword", regex: /\b(?:nmap|metasploit|sqlmap|hydra|hashcat|john|payload|exploit|reverse[\s_-]?shell)\b/gi },
  { kind: "raw_ip",          regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
  { kind: "credential_file", regex: /\b(?:passwd|shadow|hashes?[\s_-]?dump)\b|\/etc\/(?:passwd|shadow)/gi },
];

/**
 * Sanitize a string value before it is stored in offense_telemetry outcome_notes
 * (or any other telemetry text field read by the observation membrane).
 *
 * Returns the original string when no patterns match (fast path).
 * Returns a <<redacted>> placeholder string when any pattern matches.
 * Returns the original value unchanged when it is not a string or is falsy.
 *
 * @param {string} value       - The string to sanitize
 * @param {string} [fieldName] - Name of the field (for warn log only)
 * @param {string} [engId]     - Engagement ID (for warn log only)
 * @returns {string}
 */
function sanitizeOutcomeNotes(value, fieldName, engId) {
  if (!value || typeof value !== "string") return value;
  for (const { kind, regex } of SANITIZE_PATTERNS) {
    // Reset lastIndex for global regexes (safety: regex objects are module-level)
    regex.lastIndex = 0;
    if (regex.test(value)) {
      regex.lastIndex = 0;
      const redacted = value.replace(regex, `<<${kind}-redacted>>`);
      if (process.env.NODE_ENV !== "test") {
        console.warn(
          `[telemetry-sanitize] redacted '${kind}' from ${fieldName || "field"} ` +
          `on engagement ${engId || "?"} (len ${value.length} → ${redacted.length})`
        );
      }
      // Apply all patterns so one call cleans all hits, not just the first.
      // Re-enter with the partially-redacted string.
      return sanitizeOutcomeNotes(redacted, fieldName, engId);
    }
  }
  return value;
}

module.exports = { sanitizeOutcomeNotes, SANITIZE_PATTERNS };
