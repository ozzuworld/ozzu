// permission-enforcer.js — dir_1780844590951
//
// Port of claw-analog's PermissionMode + workspace jail pattern to Ozzu's SOC
// pentest pipeline. Replaces our scattered autonomous_full_access + membrane +
// intent_class regex guards with ONE declarative enum.
//
// Modes (least → most privileged):
//   recon_only          → intent IN (recon)
//   enumeration         → recon + enumeration
//   exploitation_auto   → recon + enumeration + exploit_test
//   exploitation_prompt → same as auto, every exploit_test queues human approval
//   full_engagement     → recon + enumeration + exploit_test + exploit_rce + post_exploit

"use strict";

const MODE_RANK = {
  recon_only: 0,
  enumeration: 1,
  exploitation_auto: 2,
  exploitation_prompt: 2,    // same scope as auto, different dispatch
  full_engagement: 3,
};

// Each intent_class needs at LEAST this mode to be allowed.
const INTENT_MIN_MODE = {
  recon:         "recon_only",
  enumeration:   "enumeration",
  exploit_test:  "exploitation_auto",
  exploit_rce:   "full_engagement",
  post_exploit:  "full_engagement",
};

const ALL_MODES = Object.keys(MODE_RANK);

function isValidMode(m) { return Object.prototype.hasOwnProperty.call(MODE_RANK, m); }

// Returns {allowed, denied_reason, required_mode, current_mode}.
// engagement.permission_mode defaults to 'enumeration' (matches db.js default).
function enforcePermissionMode(engagement, intentClass) {
  const mode = (engagement && isValidMode(engagement.permission_mode)) ? engagement.permission_mode : "enumeration";
  // NULL / unknown intent class → treat as recon (safest assumption).
  const cls = (typeof intentClass === "string" && intentClass) ? intentClass : "recon";
  const required = INTENT_MIN_MODE[cls];
  if (!required) {
    return {
      allowed: true,
      current_mode: mode,
      required_mode: null,
      note: `intent_class='${cls}' has no mode requirement (passthrough)`,
    };
  }
  if (MODE_RANK[mode] >= MODE_RANK[required]) {
    return { allowed: true, current_mode: mode, required_mode: required };
  }
  return {
    allowed: false,
    denied_reason: `intent_class='${cls}' requires permission_mode '${required}' or higher, but engagement is in '${mode}'`,
    current_mode: mode,
    required_mode: required,
  };
}

// Workspace jail: extract IP/host targets from the command body and check
// against engagement.scope.targets[]. Affirmative scope (must be IN scope)
// vs the current ROE.prohibited[] blocklist (must NOT match these regexes).
//
// Scope targets may include:
//   - exact IPs: "192.168.1.19"
//   - CIDR blocks: "192.168.1.0/24"
//   - hostnames: "nvr.local"
//   - port suffix: "192.168.1.19:80"
//
// Anything else (not parseable as IP/host) is treated as a permissive substring
// match to avoid breaking legacy engagements with free-text scope.
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const HOSTNAME_RE = /\b(?!-)[a-zA-Z0-9-]{1,63}(?:\.[a-zA-Z0-9-]{1,63})+\b/g;

// dir_1780852509762: blocklist common file extensions so wordlist paths
// (common.txt, rockyou.txt), config files (config.yml, app.conf), and asset
// paths (style.css, script.js) don't get misread as hostnames by HOSTNAME_RE.
const FILE_EXT_BLOCKLIST = new Set([
  "txt", "lst", "list", "wordlist", "dic", "dict",
  "json", "yml", "yaml", "toml", "ini", "conf", "cfg",
  "sh", "bash", "zsh", "py", "pl", "rb", "lua", "js", "mjs", "ts", "php",
  "html", "htm", "css", "scss", "xml", "csv", "tsv", "sql",
  "log", "pcap", "pcapng", "out", "tmp", "bak", "old", "orig", "swp",
  "gz", "bz2", "xz", "zip", "tar", "tgz", "7z",
  "pem", "key", "crt", "cer", "p12", "pfx", "asc",
  "md", "rst", "txt", "rtf", "pdf",
  "png", "jpg", "jpeg", "gif", "svg", "ico", "webp",
  "exe", "dll", "so", "dylib", "elf", "bin", "img", "iso", "deb", "rpm", "apk",
]);

// dir_1780925940313: Python / shell module-method patterns that look like
// hostnames but aren't. Run #2 burned 5+ iters on re.findall, h.split, etc.
const PY_MODULE_BLOCKLIST = new Set([
  // stdlib modules commonly used inline
  "re", "os", "sys", "json", "time", "datetime", "math", "random", "string",
  "subprocess", "socket", "struct", "hashlib", "base64", "urllib", "requests",
  "threading", "asyncio", "collections", "itertools", "functools", "pathlib",
  "io", "csv", "ssl", "http", "xml", "html", "uuid", "logging", "pickle",
  "shutil", "tempfile", "warnings", "argparse", "operator", "copy", "abc",
  "typing", "enum", "dataclasses", "ast", "inspect", "glob", "fnmatch",
  // Common JS / shell namespace fragments
  "process", "console", "document", "window", "JSON", "Math",
  // dir_1780926990535: PHP filter wrapper module names
  // (e.g. php://filter/convert.base64-encode/resource=...)
  "convert", "iconv", "zlib", "bzip2", "mcrypt", "mdecrypt",
]);

function isLikelyFilePath(s) {
  // Anything with a slash is a path, not a host.
  if (s.includes("/") || s.includes("\\")) return true;
  // Tail extension check.
  const lastDot = s.lastIndexOf(".");
  if (lastDot <= 0) return false;
  const head = s.slice(0, lastDot).toLowerCase();
  const ext = s.slice(lastDot + 1).toLowerCase();
  // Known file extension → file
  if (FILE_EXT_BLOCKLIST.has(ext)) return true;
  // dir_1780925940313: Python module pattern (re.findall, os.path, etc.) →
  // first dot-separated token is a known module
  if (PY_MODULE_BLOCKLIST.has(head.split(".")[0])) return true;
  // Single lowercase letter as head (e.g. `h.split`, `x.replace`, `j.parse`) =
  // almost certainly a loop variable or short var, not a hostname
  const headFirst = head.split(".")[0];
  if (headFirst.length === 1 && /[a-z]/.test(headFirst)) return true;
  return false;
}

function extractTargetsFromCommand(command) {
  if (!command) return [];
  const ips = [...new Set(String(command).match(IP_RE) || [])];
  const hosts = [...new Set((String(command).match(HOSTNAME_RE) || [])
    .filter(h => !ips.includes(h)
              && !/^[0-9.]+$/.test(h)
              && !isLikelyFilePath(h)))];
  return [...ips, ...hosts];
}

function ipToInt(ip) {
  const parts = String(ip).split(".").map(Number);
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipInCidr(ip, cidr) {
  const [base, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr, 10);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const baseInt = ipToInt(base);
  const ipInt = ipToInt(ip);
  if (baseInt == null || ipInt == null) return false;
  if (bits === 0) return true;
  const mask = ((0xFFFFFFFF << (32 - bits)) >>> 0);
  return (baseInt & mask) === (ipInt & mask);
}

function targetMatchesScope(target, scopeTargets) {
  for (const raw of scopeTargets) {
    const s = String(raw).trim();
    if (!s) continue;
    // Strip optional :port suffix from both sides
    const tHost = String(target).split(":")[0];
    const sHost = s.split(":")[0];
    if (tHost === sHost) return true;
    if (sHost.includes("/")) {
      if (ipInCidr(tHost, sHost)) return true;
      continue;
    }
    // Permissive substring fallback for hostnames / free-text entries
    if (sHost.length >= 4 && tHost.includes(sHost)) return true;
    if (tHost.length >= 4 && sHost.includes(tHost)) return true;
  }
  return false;
}

function enforceWorkspaceJail(engagement, command) {
  if (!engagement) return { allowed: true };
  let scope = engagement.scope;
  try { if (typeof scope === "string") scope = JSON.parse(scope || "{}"); }
  catch (_) { scope = {}; }
  const targets = Array.isArray(scope && scope.targets) ? scope.targets : [];
  if (targets.length === 0) {
    // No declared scope → permissive (legacy engagements). Telemetry can note this.
    return { allowed: true, note: "no_scope_declared_permissive" };
  }
  const found = extractTargetsFromCommand(command);
  if (found.length === 0) {
    // Command has no extractable target (e.g. "echo hello"). Allow.
    return { allowed: true, note: "no_target_in_command" };
  }
  const oos = found.filter(t => !targetMatchesScope(t, targets));
  if (oos.length === 0) {
    return { allowed: true, scope_targets: targets, found_targets: found };
  }
  return {
    allowed: false,
    denied_reason: `out-of-scope target(s) in command: ${oos.join(", ")}. Engagement scope.targets: ${targets.slice(0, 5).join(", ")}${targets.length > 5 ? "..." : ""}`,
    out_of_scope_targets: oos,
    scope_targets: targets,
  };
}

// dir_1780845638033: command classifier — token-level intent inference that
// can't be spoofed by mis-declared intent_class. If the actual command tokens
// classify above the mode's ceiling, deny even when intent_class was lower.
function enforceCommandTokens(engagement, command) {
  try {
    const classifier = require("./soc-command-classifier");
    const mode = (engagement && isValidMode(engagement.permission_mode)) ? engagement.permission_mode : "enumeration";
    const v = classifier.validateForMode(command, mode);
    return v;
  } catch (e) {
    // Classifier failure → allow (don't block on infra bug)
    return { allowed: true, classifier_error: e.message };
  }
}

// One-call check returning the FIRST denial (mode → scope → tokens), or {allowed:true}.
function enforceAll(engagement, intentClass, command) {
  const m = enforcePermissionMode(engagement, intentClass);
  if (!m.allowed) return { layer: "permission_mode", ...m };
  const s = enforceWorkspaceJail(engagement, command);
  if (!s.allowed) return { layer: "workspace_jail", ...s };
  const t = enforceCommandTokens(engagement, command);
  if (!t.allowed) return { layer: "command_tokens", ...t };
  return { allowed: true, layer: null, current_mode: m.current_mode, command_intent: t.command_intent };
}

module.exports = {
  MODE_RANK,
  ALL_MODES,
  INTENT_MIN_MODE,
  isValidMode,
  enforcePermissionMode,
  enforceWorkspaceJail,
  enforceCommandTokens,
  enforceAll,
  extractTargetsFromCommand,
};
