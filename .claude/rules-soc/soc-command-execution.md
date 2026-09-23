# SOC Command Execution Contract

## How queue items run (LOCAL on the bridge since 2026-06-23)

When a queue item is executed (`POST /soc/execute` or `POST /soc/queue/:id/run`),
the bridge runs it **locally**:

```js
spawn('bash', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
proc.stdin.write(item.command);
proc.stdin.end();
```

The command is piped **via stdin** to a local `bash -s` — it never passes through
a shell string, so multi-statement scripts with variable assignments survive
verbatim (no base64 wrapping, no quote-escaping dances):

```bash
WORK=/tmp/foo
FW=/some/file.bin
mkdir -p "$WORK"
dd if="$FW" of="$WORK/out.bin" bs=1 count=100
```

**How it reaches the physical lab:** the bridge container is `network_mode: host`,
and the host routes the lab `/24` over `wg0` (`192.168.1.0/24 → wg0 → tablet
relay → EDIFICIO LAN`). The **bridge holds the offense toolkit** (`nmap`,
`nuclei`, `httpx`, `whatweb`, `searchsploit`, `netcat-openbsd`, curl with
`/dev/tcp` — baked into `backend/bridge/Dockerfile`); the **tablet is the L3
doorway** into the lab. An engagement's `executor_host` names the **relay**, not
an ssh target. dev-01 is OUT of the execution path (2026-06-23); it remains a
Kali RE workstation only (KK, 2026-08-03).

**Anti-cloud pre-flight:** the execute endpoints abort a command that targets
cloud infra (the GCP metadata IP `169.254.169.254` or an `*.internal` host), so
a mis-scoped operation can never hit GCP instead of the lab.

**Gates:** auto-executed items (crons/hooks) additionally pass the gate stack —
ROE blocklist → permission_mode → workspace_jail → command tokens → preflight
lint (`soc/permission-enforcer.js` + `soc/soc-command-classifier.js`).

## What to keep in mind

- The command runs as the **bridge container's** user — `$HOME`/`$USER` are the
  container's, not any remote host's. Log `whoami` early when a step's
  file-path assumptions depend on the user.
- Children that read stdin (e.g. `adb shell`) **drain the rest of the script
  from the shared stdin pipe** — the script silently exits 0 after the first
  lines. Append `</dev/null` to every such call (memory:
  `feedback_soc_adb_shell_stdin`). `exec </dev/null` at script start is NOT a
  safe shortcut — it breaks bash's own reading of the script.
- The process is in its own process group (`detached: true`) so the cancel
  endpoint can `process.kill(-pid)` the whole chain.
- Long scripts get truncated in postgres beyond the TOAST limit; prefer concise
  scripts that produce checkable artifacts on disk (`find`/`ls` summaries,
  evidence files) over dumping megabytes into the output column.
- Recon output meant for `recon_hosts` ingestion must be **nmap-NORMAL format**
  (memory: `feedback_soc_tablet_recon_parser_format`).

*History (recoverable via git): pre-2026-04-18 this path was a broken
`ssh dev-01` shell-string contract that expanded `$VAR` locally; the fix was
stdin piping, later moved fully local (2026-06-23).*
