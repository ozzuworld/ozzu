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

function extractTargetsFromCommand(command) {
  if (!command) return [];
  const ips = [...new Set(String(command).match(IP_RE) || [])];
  const hosts = [...new Set((String(command).match(HOSTNAME_RE) || [])
    .filter(h => !ips.includes(h) && !/^[0-9.]+$/.test(h)))];
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

// One-call check returning the FIRST denial (mode or scope), or {allowed:true}.
function enforceAll(engagement, intentClass, command) {
  const m = enforcePermissionMode(engagement, intentClass);
  if (!m.allowed) return { layer: "permission_mode", ...m };
  const s = enforceWorkspaceJail(engagement, command);
  if (!s.allowed) return { layer: "workspace_jail", ...s };
  return { allowed: true, layer: null, current_mode: m.current_mode };
}

module.exports = {
  MODE_RANK,
  ALL_MODES,
  INTENT_MIN_MODE,
  isValidMode,
  enforcePermissionMode,
  enforceWorkspaceJail,
  enforceAll,
  extractTargetsFromCommand,
};
