# oracle — Claude-as-teacher SFT trajectory pipeline

## 1. What it is + use case

Sprint 2 of the distillation roadmap. Given a SOC engagement state at iter N, query Claude Opus (via Max-plan OAuth, no API key) for the optimal next bash command. Persist (state → opus answer) pairs as training data for Sprint 3 SFT of the offense base model.

Solves the dataset gap surfaced by Run #10/#13: the open-weights base model has the recon vocabulary but doesn't know *when* to pivot from recon to exploit, *which* discovered endpoint to use, or *where* to look once LFI works. Opus knows all of that — we capture its trajectories and SFT the base on them.

## 2. Architecture

```
backend/bridge/postgres        ──┐  (engagement history: scope, queue_history, findings)
                                 │
                                 ▼
       extract-scenarios.js  →  scenarios.jsonl       (one row per iter)
                                 │
                                 ▼
       generate-trajectories.js  →  trajectories.jsonl
                                 │
                                 │  inside, each row:
                                 │  oracle.js → @anthropic-ai/claude-agent-sdk.query()
                                 │    → claude-opus-4-7 (Max plan OAuth)
                                 │    → strict JSON parse
                                 ▼
       private/oracle-trajectories/trajectories.jsonl   ← Sprint 3 input
```

All three files run inside the bridge container so they pick up `node_modules/@anthropic-ai/claude-agent-sdk`. Auth comes from the Claude CLI session at `/root/.local/share/claude` (mounted ro into bridge per docker-compose). No `ANTHROPIC_API_KEY` required.

## 3. Build

No build step. Pure Node scripts. Dependencies are already in `backend/bridge/node_modules`:
- `@anthropic-ai/claude-agent-sdk` — Max-plan OAuth + `query()`
- `pg` — Postgres client (already used by bridge)

## 4. Configuration

| Env var | Default | What it does |
|---|---|---|
| `ORACLE_TEACHER_MODEL` | `opus` | Model alias passed to `query({options:{model:...}})`. Set to `sonnet` for cheaper batches. |
| `ORACLE_MAX_TOKENS` | `1024` | Cap per oracle response (kept tight — Opus only needs to emit one JSON object) |
| `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` | `localhost` / `5432` / `ozzu` / `ozzu` / `ozzu` | Postgres for scenario extraction |
| `NODE_PATH` | (must be `/app/node_modules` when invoked from bridge) | So Node resolves the vendored SDK |

## 5. Deployment

Runs ad-hoc inside the bridge container — not a long-running service. Output JSONL lands on `/home/gcp/ozzu/private/oracle-trajectories/` which is volume-mounted into the bridge AND visible from the host.

## 6. Budget

Token cost on Max plan = 0 USD (covered by subscription).
Wall time per call ≈ 8-12s.
For 200 trajectories ≈ 30-40 min.

## 7. Operation

Inside the bridge container (so node_modules resolves):

```bash
# 1. Extract scenarios from one or more engagements
docker exec -w /app -e NODE_PATH=/app/node_modules bridge \
  node /home/gcp/ozzu/tools/oracle/extract-scenarios.js \
    SKYLINE-SOC-2026-061 \
    > /home/gcp/ozzu/private/oracle-trajectories/run13-scenarios.jsonl

# Or pull all OzzuLab runs at once
docker exec -w /app -e NODE_PATH=/app/node_modules bridge \
  node /home/gcp/ozzu/tools/oracle/extract-scenarios.js --all-ozzulab \
    > /home/gcp/ozzu/private/oracle-trajectories/all-scenarios.jsonl

# 2. Generate trajectories (Opus answers each scenario)
docker exec -w /app -e NODE_PATH=/app/node_modules bridge \
  node /home/gcp/ozzu/tools/oracle/generate-trajectories.js \
    /home/gcp/ozzu/private/oracle-trajectories/run13-scenarios.jsonl \
    --limit 5 \
    --out /home/gcp/ozzu/private/oracle-trajectories/run13-trajectories.jsonl

# 3. Smoke test a single hand-written scenario
docker exec -w /app -e NODE_PATH=/app/node_modules bridge \
  node /home/gcp/ozzu/tools/oracle/oracle.js \
    /home/gcp/ozzu/tools/oracle/scenarios/test-scenario.json
```

## 8. Troubleshooting

- **`Cannot find module '@anthropic-ai/claude-agent-sdk'`** — running outside the bridge container. Re-run with `docker exec -w /app -e NODE_PATH=/app/node_modules bridge node ...`.
- **`Could not resolve authentication method`** — Claude CLI session expired. Re-auth: `claude` then login interactively. Or check `/root/.local/share/claude/` is mounted into the bridge.
- **`JSON parse failed`** — Opus wrapped output in markdown code fence. `oracle.js` already strips ` ```json ... ``` `, but if Opus prefaces with prose, prompt needs tightening.
- **Latency >20s** — model is slow or rate-limited. Drop `ORACLE_TEACHER_MODEL=sonnet` for 2-3× speedup with small quality loss.

## 9. Limits

- One-shot per scenario — no multi-turn reasoning across iters. (By design — we want independent decisions per state.)
- No tool use — `allowedTools: []` keeps it as pure single-completion call. Opus does NOT actually run nmap; it only proposes the command.
- Scenario extraction only sees `queue_history` (last 10) + discovered facts derived from past output. Doesn't pull findings/telemetry from offense_telemetry yet — could enrich later.
- The teacher is bound to the OAuth session — if the Max-plan session is logged out, the pipeline stops. There's no fallback to API key auth in the current code path.
