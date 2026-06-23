# SOC Command Execution Contract

## How queue items run (2026-06-23: dev-01 OUT — execution is LOCAL on the bridge)

When a queue item is executed (`POST /soc/execute` or `POST /soc/queue/:id/run`),
the bridge runs it **locally** — NOT over ssh to dev-01:

```js
spawn('bash', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
proc.stdin.write(item.command);
proc.stdin.end();
```

The command is piped **via stdin** to a local `bash -s`. It never passes through a
local shell string (so `$VAR` assignments survive — see below).

**Why local, and how it reaches a physical lab:** the bridge container is
`network_mode: host`, and the host routes the lab `/24` over `wg0`
(`192.168.1.0/24 → wg0 → tablet relay → EDIFICIO LAN`). So **the bridge holds the
offense toolkit** (`nmap` et al., baked into `backend/bridge/Dockerfile`) and **the
tablet is the L3 doorway** into the lab. The engagement's `executor_host` names the
**relay**, not an ssh target.

**dev-01 is REMOVED from the offense pipeline** (King Kazuma 2026-06-23). It's a GCP
cloud VM with its own conflicting `192.168.1.x` (the sim labs) — running offense
there scanned the cloud, not the lab. It's no longer surfaced as an executor, no
longer a default, and the `ssh dev-01` / `dev-01:8888` exec-agent paths are gone
from both execute endpoints.

**Anti-cloud pre-flight:** both endpoints abort a command that targets cloud infra
(the GCP metadata IP `169.254.169.254` or an `*.internal` host), so a mis-scoped
scan can never hit GCP/dev-01 instead of the lab.

## Why this matters for Cipher

You can write natural multi-statement scripts with variable assignments:

```bash
WORK=/tmp/foo
FW=/some/file.bin
mkdir -p "$WORK"
dd if="$FW" of="$WORK/out.bin" bs=1 count=100
```

All variables survive. No base64 wrapping needed. No `--break-system-packages`
dance for quote escaping. No semicolon subshell splits.

## The OLD broken contract (fixed 2026-04-18)

Previously the bridge built the SSH invocation as:

```js
const sshCommand = `ssh dev-01 "${command.replace(/"/g, '\\"')}"`;
spawn('bash', ['-c', sshCommand]);
```

The local `bash -c` parsed the outer double-quoted string and expanded
`$VAR` **before** ssh sent anything. So this broke:

```bash
WORK=/tmp/foo; mkdir -p "$WORK"    # $WORK evaluated empty LOCALLY, remote sees "mkdir -p \"\""
```

Symptoms in queue output: `mkdir: cannot create directory ''`, `stat: cannot
statx '""':`, empty `$HOME`, `$PATH` export not sticking.

The workaround was base64-wrapping every multi-statement script:
`echo <b64> | base64 -d | bash`. That's no longer necessary.

## What to still keep in mind

- `set -e` inside the piped script still applies on the remote side — if one
  command fails, the script aborts.
- `$HOME` / `$USER` are whatever the remote shell sees, not the bridge's env.
  (Bridge occasionally dispatches as root vs hadmin; log `whoami` early when
  a step's file-path assumptions depend on user.)
- Long scripts still get truncated in postgres if larger than TOAST limit;
  prefer concise scripts that produce checkable artifacts and `find`/`ls`
  summaries rather than dumping megabytes of disassembly.
- The local process is in its own process group (`detached: true`) so the cancel
  endpoint can `process.kill(-pid)` the whole chain.
- `whoami` is now the **bridge** user (the command runs locally), not dev-01's.
  File-path assumptions that depended on dev-01's `$HOME` no longer hold.
