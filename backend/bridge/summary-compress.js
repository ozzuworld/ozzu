// summary-compress.js — dir_1780845071255
//
// Deterministic post-processor for LLM-generated summaries. Ported from
// claw-code rust/crates/runtime/src/summary_compression.rs.
//
// Runs AFTER an LLM summary (e.g. our performSummarizer output) to:
//   - Collapse inline whitespace
//   - Truncate over-long lines to max_line_chars
//   - Dedupe (case-insensitive)
//   - Score lines by priority (core detail > section header > bullet > other)
//   - Select within (max_chars, max_lines) preferring higher priority
//   - Append "N additional lines omitted" notice
//
// Zero LLM cost. Reproducible. Composes ON TOP of performSummarizer.

"use strict";

const DEFAULTS = {
  max_chars: 2400,        // pentest summaries hold more detail than chat — bigger budget
  max_lines: 40,
  max_line_chars: 200,
};

// SOC-specific core-detail prefixes. A line starting with any of these is
// priority 0 (always preserved if budget allows).
const SOC_CORE_PREFIXES = [
  "- Host:",
  "- CVE:",
  "- Port:",
  "- Service:",
  "- Finding:",
  "- Refuted:",
  "- Confirmed:",
  "- Cred:",
  "- PoC:",
  "- Endpoint:",
  "- Scope:",
  "- Current work:",
  "- Pending work:",
  "Summary:",
  "Conversation summary:",
  "Findings (attack graph):",
];

function collapseInlineWhitespace(s) {
  return String(s || "").split(/\s+/).filter(Boolean).join(" ");
}

function truncateLine(line, maxChars) {
  if (!maxChars || line.length <= maxChars) return line;
  if (maxChars === 1) return "…";
  return line.slice(0, maxChars - 1) + "…";
}

function linePriority(line) {
  if (line === "Summary:" || line === "Conversation summary:") return 0;
  for (const p of SOC_CORE_PREFIXES) {
    if (line.startsWith(p)) return 0;
  }
  if (line.endsWith(":")) return 1;
  if (line.startsWith("- ") || line.startsWith("  - ")) return 2;
  return 3;
}

function joinedCharCount(lines) {
  if (lines.length === 0) return 0;
  let n = 0;
  for (const l of lines) n += l.length;
  return n + (lines.length - 1); // newlines between
}

function normalizeLines(text, maxLineChars) {
  const seen = new Set();
  const lines = [];
  let removedDuplicateLines = 0;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const collapsed = collapseInlineWhitespace(raw);
    if (!collapsed) continue;
    const truncated = truncateLine(collapsed, maxLineChars);
    const key = truncated.toLowerCase();
    if (seen.has(key)) { removedDuplicateLines++; continue; }
    seen.add(key);
    lines.push(truncated);
  }
  return { lines, removedDuplicateLines };
}

// Select indexes greedily by priority, respecting both the char + line budgets.
function selectIndexes(lines, budget) {
  const selected = new Set();
  for (let priority = 0; priority <= 3; priority++) {
    for (let i = 0; i < lines.length; i++) {
      if (selected.has(i)) continue;
      if (linePriority(lines[i]) !== priority) continue;
      // Try adding this one
      const candidate = [];
      for (const idx of selected) candidate.push(lines[idx]);
      candidate.push(lines[i]);
      if (candidate.length > budget.max_lines) continue;
      if (joinedCharCount(candidate) > budget.max_chars) continue;
      selected.add(i);
    }
  }
  // Return in original document order
  return [...selected].sort((a, b) => a - b);
}

function pushLineWithBudget(lines, line, budget) {
  const candidate = [...lines, line];
  if (candidate.length <= budget.max_lines && joinedCharCount(candidate) <= budget.max_chars) {
    lines.push(line);
  }
}

function omissionNotice(n) {
  return `- … ${n} additional line(s) omitted.`;
}

function compressSummary(text, budgetOverride) {
  const budget = { ...DEFAULTS, ...(budgetOverride || {}) };
  const originalChars = String(text || "").length;
  const originalLines = String(text || "").split(/\r?\n/).length;

  const normalized = normalizeLines(text, budget.max_line_chars);
  if (normalized.lines.length === 0 || budget.max_chars === 0 || budget.max_lines === 0) {
    return {
      summary: "",
      original_chars: originalChars,
      compressed_chars: 0,
      original_lines: originalLines,
      compressed_lines: 0,
      removed_duplicate_lines: normalized.removedDuplicateLines,
      omitted_lines: normalized.lines.length,
      truncated: originalChars > 0,
    };
  }

  const indexes = selectIndexes(normalized.lines, budget);
  let chosen = indexes.map(i => normalized.lines[i]);
  if (chosen.length === 0) {
    chosen.push(truncateLine(normalized.lines[0], budget.max_chars));
  }
  const omittedLines = Math.max(0, normalized.lines.length - chosen.length);
  if (omittedLines > 0) {
    pushLineWithBudget(chosen, omissionNotice(omittedLines), budget);
  }
  const compressed = chosen.join("\n");
  return {
    summary: compressed,
    original_chars: originalChars,
    compressed_chars: compressed.length,
    original_lines: originalLines,
    compressed_lines: chosen.length,
    removed_duplicate_lines: normalized.removedDuplicateLines,
    omitted_lines: omittedLines,
    truncated: compressed !== String(text || "").trim(),
  };
}

function compressSummaryText(text, budgetOverride) {
  return compressSummary(text, budgetOverride).summary;
}

module.exports = {
  DEFAULTS,
  SOC_CORE_PREFIXES,
  compressSummary,
  compressSummaryText,
  linePriority,         // exposed for tests
  normalizeLines,       // exposed for tests
};
