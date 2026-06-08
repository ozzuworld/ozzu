// soc-command-classifier.js — dir_1780845638033
//
// Token-level command classifier + per-mode allowlist for SOC pentest commands.
// Ports claw-code rust/crates/runtime/src/bash_validation.rs pattern adapted to
// SOC-specific command sets.
//
// Anti-spoof: the model can DECLARE intent_class='recon' on a queue item but the
// command body might actually be `hydra ssh://...`. permission-enforcer trusts
// the declared intent. This classifier inspects the actual command tokens and
// returns its OWN intent estimate, which gets cross-checked against the mode.

"use strict";

const MODE_RANK = {
  recon_only: 0,
  enumeration: 1,
  exploitation_auto: 2,
  exploitation_prompt: 2,
  full_engagement: 3,
};

// Each intent level needs at LEAST the matching mode.
const INTENT_RANK = {
  recon:        0,
  enumeration:  1,
  exploit_test: 2,
  exploit_rce:  3,
  post_exploit: 3,
  destructive: 99,            // always blocked, regardless of mode
  unknown:      1,            // default conservative — treat as enumeration
};

// ── Command sets ──────────────────────────────────────────────────────────

// RECON: probes that READ from target without modifying state.
const RECON_COMMANDS = new Set([
  "nmap", "masscan", "rustscan", "zmap", "naabu",
  "dig", "nslookup", "host", "drill",
  "ping", "ping6", "fping", "arping", "traceroute", "tracepath", "mtr",
  "whois", "rwho",
  "tcpdump", "tshark",   // passive listen
  "amass", "subfinder", "assetfinder", "findomain", "dnsx",
  "whatweb", "wafw00f", "httpx",
  "shodan",
  "snmpwalk",            // depends; SNMP walk of v1/v2c PUBLIC is recon
]);

// ENUMERATION: auth probing, version detection, service enumeration.
// HTTP curl/wget without payloads are HERE (read auth-walled endpoints).
const ENUMERATION_COMMANDS = new Set([
  "curl", "wget", "httpie", "http",            // HTTP probes
  "enum4linux", "enum4linux-ng",
  "smbclient", "smbmap", "rpcclient",
  "ldapsearch",
  "showmount",
  "onesixtyone",
  "ike-scan",
  "gobuster", "ffuf", "dirb", "feroxbuster", "wfuzz",    // dir/sub fuzzing
  "nikto",
  "sslscan", "sslyze", "testssl.sh",
  "wpscan",
  "droopescan",
  "joomscan",
  "cmsmap",
  "openssl",                                   // s_client banner grabs
]);

// EXPLOIT_TEST: credential brute/spray, soft cred testing, harmless PoC scripts.
const EXPLOIT_TEST_COMMANDS = new Set([
  "hydra", "medusa", "ncrack", "patator",
  "crackmapexec", "cme", "nxc", "netexec",
  "kerbrute",
  "responder",                                  // can be passive but typically used in active attack chains
  "impacket-secretsdump", "impacket-GetNPUsers", "impacket-GetUserSPNs", "impacket-psexec",
  "evil-winrm",
  "sqlmap",
  "metasploit", "msfconsole", "msfvenom",
  "exploit-db", "searchsploit",
  "burpsuite", "zap",
  "john", "hashcat",                            // local cracking is exploit_test scope
]);

// EXPLOIT_RCE: shell delivery, RCE payloads, lateral establishment.
// dir_1780854637935: nc/ncat/socat moved to CONTEXTUAL_COMMANDS — their
// intent depends on flags (-z = recon, -l/-e = exploit_rce). See
// classifyContextual() below.
const EXPLOIT_RCE_COMMANDS = new Set([
  "python", "python3", "perl", "ruby", "node",  // when used to spawn shells
  "powershell", "pwsh",
  "bash", "sh", "zsh",                          // remote shell invocation
]);

// CONTEXTUAL: same binary, different intent depending on flags. The
// classifyByFirstToken path delegates to classifyContextual() for these.
const CONTEXTUAL_COMMANDS = new Set(["nc", "ncat", "socat"]);

// POST_EXPLOIT: persistence, lateral movement, credential theft on host.
const POST_EXPLOIT_COMMANDS = new Set([
  "mimikatz",
  "bloodhound", "bloodhound-python", "sharphound",
  "rubeus",
  "powerview",
  "pypykatz",
  "lazagne",
  "linpeas", "winpeas",
  "linenum",
  "pspy",
]);

// ALWAYS DESTRUCTIVE: never run, regardless of mode. Bridge-side guard.
const ALWAYS_DESTRUCTIVE_PATTERNS = [
  { re: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(?:\s|$)/, why: "rm -rf / would destroy the bridge filesystem" },
  { re: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+~(?:\s|$)/,   why: "rm -rf ~ would destroy home directory" },
  { re: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\*/,           why: "rm -rf * would destroy cwd contents" },
  { re: /\bdd\s+(?:if|of)=\/dev\//,                    why: "dd to /dev would overwrite a raw device" },
  { re: /\b(mkfs|wipefs|shred)\b/,                     why: "filesystem-format / data-wipe utility" },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,    why: "fork bomb signature" },
  { re: /\bchmod\s+-R\s+(?:0|7)77\s+\//,               why: "recursive permission wipe at root" },
  // dir_1780957501726: block mutations to executor's /etc/{hosts,resolv.conf,
  // nsswitch.conf,passwd,shadow,sudoers}. Run #12 sub#-/echo + sudo tee
  // /etc/hosts mapped internal-web.skyline.local to the wrong IP and
  // misdirected ffuf/curl for the remaining iters. State leak from lab.
  { re: /\btee\s+(?:-[a-zA-Z]+\s+)*\/etc\/(?:hosts|resolv\.conf|nsswitch\.conf|passwd|shadow|sudoers)(?:\s|$)/, why: "writes to executor's /etc/ would leak state across runs and misdirect subsequent commands" },
  { re: />>?\s*\/etc\/(?:hosts|resolv\.conf|nsswitch\.conf|passwd|shadow|sudoers)(?:\s|$)/,                       why: "shell redirect to /etc/ would mutate executor host state" },
];

// ── Classification ───────────────────────────────────────────────────────

function firstNonFlagToken(command) {
  // Strip leading "sudo" / env-wrapper words
  const raw = String(command || "").trim();
  if (!raw) return "";
  // Split on whitespace, take the first token that doesn't look like a flag,
  // env-prefix (FOO=bar), or sudo invocation.
  const tokens = raw.split(/\s+/);
  for (const t of tokens) {
    if (!t) continue;
    if (t.startsWith("-")) continue;          // a flag (no command yet?)
    if (/^[A-Z_][A-Z0-9_]*=/.test(t)) continue; // env var assignment
    if (t === "sudo" || t === "doas" || t === "nice" || t === "ionice" || t === "timeout") continue;
    // Strip path prefix
    const base = t.includes("/") ? t.split("/").pop() : t;
    return base.toLowerCase();
  }
  return "";
}

// dir_1780854637935: flag-aware classification for nc/ncat/socat. Same
// binary maps to different intents based on what flags follow it.
function classifyContextual(token, fullCommand) {
  const cmdStr = String(fullCommand || "");
  if (token === "nc" || token === "ncat") {
    // Match short-flag CLUSTERS: any -<chars> containing the flag letter we want.
    // Pattern (^|\s)-[a-zA-Z]*X[a-zA-Z]*\b matches -X, -Xv, -vX, -zvn, etc.
    const hasFlag = (letter) => new RegExp(`(^|\\s)-[a-zA-Z]*${letter}[a-zA-Z]*(\\b|\\s|$)`).test(cmdStr);
    // exploit_rce signals first (most dangerous wins)
    if (hasFlag("e") || /(^|\s)(--exec\b|--sh-exec\b|--ssl-cert\b)/.test(cmdStr) || /-c\s+\/bin/.test(cmdStr))
      return { intent: "exploit_rce",  matched_rule: `${token}_with_exec_flag` };
    if (hasFlag("l") || hasFlag("L") || /(^|\s)(--listen\b)/.test(cmdStr))
      return { intent: "exploit_rce",  matched_rule: `${token}_listener_flag` };
    if (hasFlag("z"))
      return { intent: "recon",        matched_rule: `${token}_zero_io_port_check` };
    // raw nc host port = banner grab → enumeration
    return { intent: "enumeration",    matched_rule: `${token}_banner_grab_default` };
  }
  if (token === "socat") {
    if (/(EXEC|SYSTEM|SHELL):/.test(cmdStr))
      return { intent: "exploit_rce",  matched_rule: "socat_exec_or_shell_handler" };
    if (/(TCP[46]?-LISTEN|UDP[46]?-LISTEN|OPENSSL-LISTEN|UNIX-LISTEN)/.test(cmdStr))
      return { intent: "exploit_rce",  matched_rule: "socat_listener_handler" };
    return { intent: "enumeration",    matched_rule: "socat_client_default" };
  }
  return { intent: "unknown", matched_rule: `contextual_unhandled:${token}` };
}

function classifyByFirstToken(token, fullCommand) {
  if (!token) return { intent: "unknown", matched_rule: "no_first_token" };
  if (CONTEXTUAL_COMMANDS.has(token))   return classifyContextual(token, fullCommand);
  if (RECON_COMMANDS.has(token))       return { intent: "recon",        matched_rule: `recon_set:${token}` };
  if (ENUMERATION_COMMANDS.has(token)) return { intent: "enumeration",  matched_rule: `enum_set:${token}` };
  if (EXPLOIT_TEST_COMMANDS.has(token))return { intent: "exploit_test", matched_rule: `exploit_test_set:${token}` };
  if (POST_EXPLOIT_COMMANDS.has(token))return { intent: "post_exploit", matched_rule: `post_exploit_set:${token}` };
  if (EXPLOIT_RCE_COMMANDS.has(token)) return { intent: "exploit_rce",  matched_rule: `exploit_rce_set:${token}` };
  return { intent: "unknown", matched_rule: `unclassified:${token}` };
}

function classifyCommand(command) {
  const cmdStr = String(command || "");
  // Pass 1: destructive patterns — anywhere in the command body wins everything.
  for (const p of ALWAYS_DESTRUCTIVE_PATTERNS) {
    if (p.re.test(cmdStr)) {
      return { first_token: firstNonFlagToken(cmdStr), intent: "destructive", matched_rule: `destructive_pattern:${p.why}` };
    }
  }
  // Pass 2: command-substitution + pipe expansions — if ANY piece looks
  // higher-intent than the leading command, escalate. This catches
  //   `echo hello | hydra ...` or `nc 1.2.3.4 22 < cmd.sh`
  // dir_1780854637935: pass each PIECE through classifyByFirstToken so
  // contextual classifiers (nc/ncat/socat) see only their own flags, not
  // the whole pipeline (avoids `echo X | nc -z` being misclassified).
  const tokens = cmdStr.split(/[|;&]/);
  let highest = { intent: "unknown", matched_rule: null, first_token: "" };
  for (const piece of tokens) {
    const ft = firstNonFlagToken(piece);
    if (!ft) continue;
    const c = classifyByFirstToken(ft, piece);
    if (!highest.first_token) highest = { ...c, first_token: ft };
    if (INTENT_RANK[c.intent] > INTENT_RANK[highest.intent]) {
      highest = { ...c, first_token: ft };
    }
  }
  return highest;
}

// ── Mode validation ──────────────────────────────────────────────────────

function validateForMode(command, mode) {
  const safeMode = Object.prototype.hasOwnProperty.call(MODE_RANK, mode) ? mode : "enumeration";
  const c = classifyCommand(command);
  if (c.intent === "destructive") {
    return {
      allowed: false,
      command_intent: "destructive",
      first_token: c.first_token,
      matched_rule: c.matched_rule,
      reason: `Command matches always-destructive pattern: ${c.matched_rule}`,
      required_mode: null,
    };
  }
  const intentRank = INTENT_RANK[c.intent] ?? INTENT_RANK.unknown;
  const ceilingForMode = (
    safeMode === "recon_only"          ? 0 :
    safeMode === "enumeration"         ? 1 :
    safeMode === "exploitation_auto"   ? 2 :
    safeMode === "exploitation_prompt" ? 2 :
    safeMode === "full_engagement"     ? 3 :
    1
  );
  if (intentRank <= ceilingForMode) {
    return {
      allowed: true,
      command_intent: c.intent,
      first_token: c.first_token,
      matched_rule: c.matched_rule,
    };
  }
  // intent above ceiling → deny
  const minMode = (
    intentRank === 0 ? "recon_only" :
    intentRank === 1 ? "enumeration" :
    intentRank === 2 ? "exploitation_auto" :
                       "full_engagement"
  );
  return {
    allowed: false,
    command_intent: c.intent,
    first_token: c.first_token,
    matched_rule: c.matched_rule,
    reason: `Command's actual intent (classified='${c.intent}', first_token='${c.first_token}', rule='${c.matched_rule}') exceeds current permission_mode='${safeMode}'. Need mode '${minMode}' or higher.`,
    required_mode: minMode,
  };
}

module.exports = {
  MODE_RANK,
  INTENT_RANK,
  RECON_COMMANDS,
  ENUMERATION_COMMANDS,
  EXPLOIT_TEST_COMMANDS,
  EXPLOIT_RCE_COMMANDS,
  POST_EXPLOIT_COMMANDS,
  CONTEXTUAL_COMMANDS,
  ALWAYS_DESTRUCTIVE_PATTERNS,
  classifyCommand,
  classifyByFirstToken,
  classifyContextual,
  firstNonFlagToken,
  validateForMode,
};
