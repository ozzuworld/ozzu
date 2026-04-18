# SOC Command Execution Contract

## How queue items run

When a queue item is executed (`POST /soc/execute` or `POST /soc/queue/:id/run`),
the bridge does:

```js
spawn(
  'ssh',
  ['-o', '...', 'dev-01', 'bash', '-s'],
  { stdio: ['pipe', 'pipe', 'pipe'], detached: true }
);
proc.stdin.write(item.command);
proc.stdin.end();
```

The command is shipped **via ssh stdin** to a remote `bash -s`. It never passes
through a local shell string.

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
- SSH process is in its own process group (`detached: true`) so the cancel
  endpoint can `process.kill(-pid)` the whole chain.
