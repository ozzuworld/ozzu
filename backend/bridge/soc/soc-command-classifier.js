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
// dir_1782480866296: added canonical names (enum, cred_test, exploit_probe, lateral)
// alongside the originals so cross-checking with autonomous-executor works.
const INTENT_RANK = {
  recon:         0,
  enum:          1,
  enumeration:   1,
  banner_grab:   1,
  service_version: 1,
  tool_setup:    1,
  cred_test:     2,
  exploit_probe: 2,
  exploit_test:  2,
  lateral:       3,
  exploit_rce:   3,
  post_exploit:  3,
  destructive:  99,
  unknown:       1,
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
  "sshpass",
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
// dir_1782239552993: python/python3/perl/ruby/node moved to CONTEXTUAL_COMMANDS
// — running `python exploit.py target` is exploit_test; only inline shell
// invocations (-c "os.system(...)" / -e "exec ...") are exploit_rce.
// dir_1782251824781 Fix 5: bash/sh/zsh moved to CONTEXTUAL_COMMANDS — the 353
// engagement had 10 permission_denied events on `bash -c "nmap ..."` patterns
// because these were classified as exploit_rce (needs full_engagement) even when
// the -c payload was a safe tool invocation. Classification now depends on the
// payload: shell listeners / /dev/tcp / pty.spawn → exploit_rce; plain -c with
// tool commands → exploit_test (allows exploitation_auto mode). powershell/pwsh
// stay EXPLOIT_RCE (Windows RCE tooling, always high-intent).
const EXPLOIT_RCE_COMMANDS = new Set([
  "powershell", "pwsh",
  // bash/sh/zsh moved to CONTEXTUAL_COMMANDS (dir_1782251824781 Fix 5)
]);

// CONTEXTUAL: same binary, different intent depending on flags. The
// classifyByFirstToken path delegates to classifyContextual() for these.
const CONTEXTUAL_COMMANDS = new Set(["nc", "ncat", "socat", "python", "python3", "perl", "ruby", "node",
  "bash", "sh", "zsh", "ssh"]);

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
// dir_1782239552993: extended to python/python3/perl/ruby/node — script-file
// invocations are exploit_test; inline shell exec (-c/-e) are exploit_rce.
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
  // dir_1782239552993: scripting-language contextual classification.
  // - python/python3/perl/ruby/node running a SCRIPT FILE → exploit_test
  //   (model is executing an exploit module, not spawning an interactive shell)
  // - inline exec flags (-c / -e / --command) that invoke shell builtins → exploit_rce
  //   (e.g. `python3 -c "import os; os.system('/bin/sh')"`)
  // Default: exploit_test (any script execution is at minimum exploit scope)
  if (token === "python" || token === "python3") {
    // dir_1782333116988: python3 -c payload inspection (same pattern as bash -c).
    // Blanket exploit_rce was blocking legitimate HTTP requests and data parsing.
    // Only escalate to exploit_rce when the payload spawns a shell or listener.
    if (/(^|\s)-c\s/.test(cmdStr)) {
      if (/pty\.spawn|os\.system\s*\(\s*['"]\/bin|os\.popen|subprocess\.call.*\/bin\/(sh|bash)|exec\s*\(\s*['"]\/bin/.test(cmdStr))
        return { intent: "exploit_rce", matched_rule: `${token}_inline_shell_spawn` };
      if (/socket\.socket.*connect.*makefile|socket\.socket.*recv/.test(cmdStr) && /\/bin\/(sh|bash)/.test(cmdStr))
        return { intent: "exploit_rce", matched_rule: `${token}_inline_reverse_shell` };
      return { intent: "exploit_test", matched_rule: `${token}_inline_exec` };
    }
    // Running a script file: positional argument ending in .py OR a path (contains /)
    if (/\s[\w./~-]*\.py(?:\s|$)/.test(cmdStr) || /\s\/\S+\.py(?:\s|$)/.test(cmdStr))
      return { intent: "exploit_test", matched_rule: `${token}_script_file` };
    // -m module execution (e.g. python3 -m http.server) → enumeration class
    if (/(^|\s)-m\s+\w/.test(cmdStr))
      return { intent: "enumeration",  matched_rule: `${token}_module_run` };
    // Bare invocation or unknown pattern → exploit_test (conservative)
    return { intent: "exploit_test",   matched_rule: `${token}_default` };
  }
  if (token === "perl") {
    // -e "..." inline execution
    if (/(^|\s)-e\s/.test(cmdStr))
      return { intent: "exploit_rce",  matched_rule: "perl_inline_exec" };
    // Script file
    if (/\s[\w./~-]*\.pl(?:\s|$)/.test(cmdStr))
      return { intent: "exploit_test", matched_rule: "perl_script_file" };
    return { intent: "exploit_test",   matched_rule: "perl_default" };
  }
  if (token === "ruby") {
    // -e "..." inline execution
    if (/(^|\s)-e\s/.test(cmdStr))
      return { intent: "exploit_rce",  matched_rule: "ruby_inline_exec" };
    // Script file
    if (/\s[\w./~-]*\.rb(?:\s|$)/.test(cmdStr))
      return { intent: "exploit_test", matched_rule: "ruby_script_file" };
    return { intent: "exploit_test",   matched_rule: "ruby_default" };
  }
  if (token === "node") {
    // -e "..." inline execution
    if (/(^|\s)-e\s/.test(cmdStr))
      return { intent: "exploit_rce",  matched_rule: "node_inline_exec" };
    // Script file
    if (/\s[\w./~-]*\.js(?:\s|$)/.test(cmdStr))
      return { intent: "exploit_test", matched_rule: "node_script_file" };
    return { intent: "exploit_test",   matched_rule: "node_default" };
  }
  // dir_1782251824781 Fix 5: bash/sh/zsh contextual classification.
  // Replaces the blanket exploit_rce classification that was causing ~10
  // permission_denied events on 353 for `bash -c "nmap ..."` tool-runner patterns.
  //
  // Intent mapping:
  //   Shell listener (-i, /dev/tcp, pty.spawn) → exploit_rce (true RCE)
  //   Reverse-shell pattern (>& or 0>&1 with /dev/tcp) → exploit_rce
  //   Plain -c "..." with recognizable pentest tool in payload → exploit_test
  //   No flags (bare invocation or script file) → exploit_test
  //   Default (anything else) → exploit_test (conservative, allows exploitation_auto)
  //
  // powershell/pwsh are still in EXPLOIT_RCE_COMMANDS — they stay always exploit_rce
  // because PowerShell payloads are almost exclusively Windows RCE tooling.
  if (token === "bash" || token === "sh" || token === "zsh") {
    // Shell listener: -i flag (interactive) or explicit RCE sink patterns
    if (/(^|\s)-i\b/.test(cmdStr))
      return { intent: "exploit_rce", matched_rule: `${token}_interactive_flag` };
    // Reverse shell via /dev/tcp (classic bash TCP-redirect RCE)
    if (/\/dev\/tcp\//.test(cmdStr) && /(>>&?|0>&1|>&\s+\/dev\/tcp)/.test(cmdStr))
      return { intent: "exploit_rce", matched_rule: `${token}_reverse_shell_devtcp` };
    // pty.spawn or python -c "/bin/sh" (subshell spawner)
    if (/pty\.spawn|pty_spawn|os\.system\s*\(['"]\s*\/bin|exec\s+\/bin\/(bash|sh)/.test(cmdStr))
      return { intent: "exploit_rce", matched_rule: `${token}_pty_or_exec_shell` };
    // Script file invocation (bash /path/to/script.sh)
    if (/\s[\w./~-]*\.(sh|bash)(?:\s|$)/.test(cmdStr))
      return { intent: "exploit_test", matched_rule: `${token}_script_file` };
    // -c "..." command runner: inspect the payload for listener / reverse-shell forms
    // before defaulting to exploit_test.
    //
    // adversarial-review fix (dir_1782251824781 adversarial pass):
    //   `bash -c "nc -lvp 4444"` was passing as exploit_test (exploitation_auto OK)
    //   even though the payload is a bind listener — one permission tier too low.
    //   We extract the -c payload and re-scan it for the same listener signatures
    //   that the standalone nc/socat/bash checks already catch.
    //
    // Patterns that escalate to exploit_rce inside a -c payload:
    //   - nc/ncat with -l/-L/-lvp/-lvnp/-e flags (listener/exec)
    //   - socat with EXEC:, SYSTEM:, SHELL:, or *-LISTEN: address (listener or exec)
    //   - bash -i / sh -i inside the payload (nested interactive shell)
    //   - /dev/tcp/ redirect (reverse-shell via bash TCP)
    if (/(^|\s)-c\s/.test(cmdStr)) {
      // Extract the payload: everything after `-c ` up to end of token (quoted or unquoted).
      const payloadMatch = cmdStr.match(/(?:^|\s)-c\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/);
      const payload = payloadMatch ? (payloadMatch[1] ?? payloadMatch[2] ?? payloadMatch[3] ?? "") : cmdStr;
      // nc/ncat listener or exec flags inside payload
      if (/\bnc(at)?\b/.test(payload)) {
        const hasListenFlag = /(^|\s)-[a-zA-Z]*[lL][a-zA-Z]*(\b|\s|$)|(^|\s)--listen\b/.test(payload);
        const hasExecFlag   = /(^|\s)-[a-zA-Z]*e[a-zA-Z]*(\b|\s|$)|(^|\s)(?:--exec|--sh-exec)\b/.test(payload);
        const hasLvp        = /(^|\s)-lvp\b|(^|\s)-lvnp\b/.test(payload);
        if (hasListenFlag || hasExecFlag || hasLvp)
          return { intent: "exploit_rce", matched_rule: `${token}_c_payload_nc_listener` };
      }
      // socat listener or exec inside payload
      if (/\bsocat\b/.test(payload)) {
        if (/(EXEC|SYSTEM|SHELL):/.test(payload) || /(TCP[46]?-LISTEN|UDP[46]?-LISTEN|OPENSSL-LISTEN|UNIX-LISTEN)/.test(payload))
          return { intent: "exploit_rce", matched_rule: `${token}_c_payload_socat_listener` };
      }
      // nested interactive shell or /dev/tcp reverse-shell inside payload
      if (/(^|\s)(?:bash|sh)\s+-i\b/.test(payload))
        return { intent: "exploit_rce", matched_rule: `${token}_c_payload_interactive_shell` };
      if (/\/dev\/tcp\//.test(payload) && /(>>&?|0>&1|>&\s*\/dev\/tcp)/.test(payload))
        return { intent: "exploit_rce", matched_rule: `${token}_c_payload_devtcp` };
      // Payload looks safe — plain tool-runner (the 353 pattern we must NOT re-gate)
      return { intent: "exploit_test", matched_rule: `${token}_command_runner` };
    }
    return { intent: "exploit_test",   matched_rule: `${token}_default` };
  }
  // dir_1782480866296: ssh contextual — plain ssh is enumeration (banner/id check),
  // but sshpass wrapping or -o PasswordAuthentication=yes with a password = cred_test.
  if (token === "ssh") {
    if (/sshpass\b/.test(cmdStr) || /-o\s*PasswordAuthentication\s*=\s*yes/.test(cmdStr))
      return { intent: "cred_test", matched_rule: "ssh_password_auth" };
    return { intent: "enumeration", matched_rule: "ssh_default" };
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
