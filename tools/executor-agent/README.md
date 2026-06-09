# executor-agent — HTTP shim replacing per-command SSH dispatch

## 1. What it is + use case

Lightweight Node HTTP service on dev-01 that the bridge calls instead of `ssh dev-01 'bash -s'`. Removes the per-command sshd handshake cost (100-300ms each) that becomes a real bottleneck once we run 10+ parallel SOC engagements. Keep-alive over WG: one TCP connection from bridge → dev-01 carries hundreds of POST /exec.

Used by `routes/soc.js` when `EXEC_AGENT_URL` is set in bridge env. Falls back to the SSH spawn path when the env var is unset — backward-compatible for tablet-routed engagements that need streaming output (the HTTP path returns full output at end, no streaming).

## 2. Architecture

```
bridge (gcp-vm)                dev-01                          target host
  │                              │                                │
  │── POST /exec ───────────────→│ ─ spawn('bash', ['-s']),       │
  │   {command, timeout,         │   piped command via stdin      │
  │    engagement_id}            │                                │
  │                              │ ──── child runs (nmap, curl, …)── target
  │←── { exit_code, stdout,      │ ←─── output buffered up to 1 MiB
  │     stderr, duration_ms,     │
  │     timed_out, killed }      │
```

Listens on `EXEC_AGENT_HOST:EXEC_AGENT_PORT` (default `10.9.0.5:8888` — dev-01's WG addr). The bind to WG means the public internet can't reach the endpoint; firewall is just the WG mesh.

Auth is a single shared Bearer token (`EXEC_AGENT_TOKEN`, 32-byte hex) — same value in bridge's `.env` and dev-01's `/home/hadmin/exec-agent/.env`. Constant-time compare on the agent side.

## 3. Build

No build. Plain Node script.

```bash
mkdir -p /home/hadmin/exec-agent
cp server.js /home/hadmin/exec-agent/
echo "EXEC_AGENT_TOKEN=$(openssl rand -hex 32)" > /home/hadmin/exec-agent/.env
sudo cp exec-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now exec-agent.service
```

## 4. Configuration

| Env var | Default | Purpose |
|---|---|---|
| `EXEC_AGENT_HOST` | `10.9.0.5` | Bind address (WG iface on dev-01) |
| `EXEC_AGENT_PORT` | `8888` | Listen port |
| `EXEC_AGENT_TOKEN` | (required, no default) | 32-byte hex Bearer secret. Same value in bridge env. |
| `EXEC_AGENT_DEFAULT_TIMEOUT` | `300` | Default per-command timeout in seconds |
| `EXEC_AGENT_MAX_TIMEOUT` | `900` | Cap on requested timeouts |
| `EXEC_AGENT_MAX_OUTPUT` | `1048576` | Per-stream byte cap (truncates beyond, sets `truncated:true`) |

## 5. Deployment

Systemd service `exec-agent.service` on dev-01. Auto-start after wg-quick@wg0. Restarts on failure with 3s backoff. User: `hadmin` (non-root — the executor agent itself doesn't need root; commands it runs use whatever privileges hadmin has).

Bridge side: just set the two env vars in `backend/.env` and recreate the bridge container:
```
EXEC_AGENT_URL=http://10.9.0.5:8888
EXEC_AGENT_TOKEN=<token from dev-01>
```

Then `docker compose up -d --force-recreate bridge`.

## 6. Budget

$0 ongoing. Single Node process, ~30 MB RSS, negligible CPU until commands are dispatched.

## 7. Operation

```bash
# Status / counters
curl -s http://10.9.0.5:8888/health
# → {"ok":true,"uptime_s":..,"in_flight":..,"total_served":..,...}

# Reload after server.js edit
sudo systemctl restart exec-agent.service

# Tail logs
sudo journalctl -u exec-agent.service -f

# Manual exec smoke test (replace TOKEN)
curl -s -X POST http://10.9.0.5:8888/exec \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command":"hostname; date"}'
```

Bridge side: the patch in `backend/bridge/routes/soc.js` activates the HTTP path automatically once `EXEC_AGENT_URL` is present in the bridge process env. No code knob to flip per-engagement.

## 8. Troubleshooting

- **`-- No entries --` in journal but bridge says HTTP failed** — sudo journald can be slow to flush. `sudo systemctl status exec-agent.service` shows the live state; counters via `/health` are the fast signal.
- **bridge sends but agent total_served stays 0** — check bridge container env: `docker exec bridge env | grep EXEC_AGENT`. Compose has to be re-`up -d --force-recreate` (not just `restart`) for new env to take effect.
- **`Connection refused`** — agent not listening or WG down. Check `wg show wg0` on both sides; `sudo systemctl status exec-agent.service` on dev-01.
- **`401 auth required`** — Bearer token mismatch. Compare `/home/hadmin/exec-agent/.env` to `backend/.env`. Token is 64 hex chars.
- **Items finish but no output** — output cap was hit (1 MiB default). Check `truncated:true` in the JSON response. Bump `EXEC_AGENT_MAX_OUTPUT` and restart agent.

## 9. Limits

- **No incremental streaming.** Full stdout/stderr returned only at command exit. Operator-driven engagements that need a live hero card should NOT route through this — keep them on SSH (just unset `EXEC_AGENT_URL` for those, or wire it per-engagement later).
- **Output cap 1 MiB per stream.** Truncates and sets a flag; doesn't error. Adequate for nmap/ffuf/gobuster output; tcpdump or a long-running daemon would overflow.
- **No cancel endpoint yet.** Once the command is in flight on dev-01, only the timeout can stop it. Bridge's `/soc/cancel/:id` won't reach into the running child. Could add `POST /cancel/:session_id` later if needed.
- **No structured streaming-over-SSE.** If we ever need live progress for autonomous runs (e.g. to push partial output into the model's context mid-iter), this would need a `/exec/stream` endpoint that chunks responses. Not required for the SFT data-collection use case.
- **Single binding to WG iface.** If we ever want this reachable from other hosts on the LAN we'd add a second listener — but the design intent is bridge-only.
