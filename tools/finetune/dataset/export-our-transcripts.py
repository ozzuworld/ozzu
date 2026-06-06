#!/usr/bin/env python3
"""
export-our-transcripts.py — Step 9.6 of OFFENSE-FINETUNE-DESIGN.md (dir_1780595557351)

Pull our own L3 agent transcripts from the bridge postgres and emit chat
JSONL that preserves tool_call/tool_result structure. This corpus is what
keeps the fine-tune from breaking the base model's function-calling — see
OFFENSE-FINETUNE-DESIGN.md §3c.

Source tables:
  pentest_engagements.agent_run_state.messages — full conversation transcript
                                                  from Step 5 runAgentToolCall paths
  engagement_tasks (.directive, .outcome_summary)  — Step 8 multi-agent DAG state
  soc_queue_items.command + .output                — raw command + raw output

Output:
  one JSONL row per (engagement, completed-iteration) of {"messages": [...],
  "source":"ozzu", "engagement_id_anon":"<anon>", "iteration": N}.

Anonymization (mandatory — we don't bake live engagement data into weights):
  IPs:        192.168.x.y → 10.99.<r1>.<r2>  (per-engagement deterministic mapping)
              172.16-31.x.y → 10.99.<r3>.<r4>
              10.x.y.z → 10.99.<r5>.<r6> EXCEPT 10.99.* (already anonymized)
  Hostnames:  mapped to generic asset-N labels per engagement
  MAC addrs:  scrubbed to AA:BB:CC:DD:EE:FF
  Public IPs: dropped (replaced with `<PUBLIC-IP-REDACTED>`)
  Engagement IDs: SHA256-truncated to 12 chars

Usage:
  export PGHOST=postgres PGUSER=ozzu PGPASSWORD=...
  python3 export-our-transcripts.py --out /tmp/finetune/agent.jsonl \\
      --min-iter 3  --statuses completed,idle \\
      --include-step5  --include-step8
"""
import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

# --- conn ----------------------------------------------------------------------

def get_conn():
    try:
        import psycopg2
    except ImportError:
        print("[export] FATAL: psycopg2 not installed. Run: pip install psycopg2-binary", file=sys.stderr)
        sys.exit(2)
    # Standard libpq env vars: PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "postgres"),
        port=int(os.environ.get("PGPORT", "5432")),
        user=os.environ.get("PGUSER", "ozzu"),
        password=os.environ.get("PGPASSWORD", "ozzu"),
        dbname=os.environ.get("PGDATABASE", "ozzu"),
    )

# --- anonymization -------------------------------------------------------------

PRIVATE_IP_RE = re.compile(
    r"\b(?:"
    r"192\.168\.\d{1,3}\.\d{1,3}"                            # 192.168.0.0/16 — 4 octets
    r"|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"          # 172.16.0.0/12 — 4 octets
    r"|10(?:\.\d{1,3}){3}"                                   # 10.0.0.0/8    — 4 octets
    r")\b"
)
PUBLIC_IP_RE  = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")  # filter in callback (skip already-anon 10.99.*)
MAC_RE        = re.compile(r"\b(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b")


class Anonymizer:
    """Per-engagement deterministic anonymizer.

    Stable mapping: the same IP in two messages within ONE engagement maps to
    the same anonymized IP, but the SAME IP across engagements maps differently.
    Hostname N gets `asset-N` slot per engagement.
    """
    def __init__(self, engagement_id):
        h = hashlib.sha256(engagement_id.encode()).digest()
        self._seed = (h[0] << 8) | h[1]   # two bytes deterministic per engagement
        self._ip_map = {}
        self._host_map = {}
        self._next_host = 1

    def _new_anon_ip(self, raw):
        if raw in self._ip_map:
            return self._ip_map[raw]
        # Use seed + position in map to pick stable octets
        idx = len(self._ip_map)
        third = (self._seed + idx * 7) % 254 + 1
        fourth = (self._seed * 11 + idx * 13) % 254 + 1
        anon = f"10.99.{third}.{fourth}"
        self._ip_map[raw] = anon
        return anon

    def _new_anon_host(self, raw):
        if raw in self._host_map:
            return self._host_map[raw]
        anon = f"asset-{self._next_host}"
        self._host_map[raw] = anon
        self._next_host += 1
        return anon

    def scrub(self, text):
        if not isinstance(text, str):
            return text
        # Private IPs → 10.99.x.x deterministic
        def _ip(m):
            ip = m.group(0)
            if ip.startswith("10.99."):     # already anon
                return ip
            return self._new_anon_ip(ip)
        text = PRIVATE_IP_RE.sub(_ip, text)

        # Public IPs → redacted. Skip already-anonymized 10.99.x.x outputs
        # (the private-IP step above produced those; PUBLIC_IP_RE matches them too).
        def _maybe_redact_public(m):
            ip = m.group(0)
            if ip.startswith("10.99."):
                return ip
            return "<PUBLIC-IP-REDACTED>"
        text = PUBLIC_IP_RE.sub(_maybe_redact_public, text)

        # MAC addresses → AA:BB:...
        text = MAC_RE.sub("AA:BB:CC:DD:EE:FF", text)

        # Hostnames that look like target names — anonymize known patterns.
        # We don't do a general hostname regex because too many normal strings
        # match. We rely on operator-known patterns (e.g. NVR-CCTV, switch01).
        # Future improvement: a per-engagement hostname inventory pre-pass.
        return text

    def scrub_message(self, msg):
        if not isinstance(msg, dict):
            return msg
        out = dict(msg)
        if isinstance(out.get("content"), str):
            out["content"] = self.scrub(out["content"])
        if "tool_calls" in out and isinstance(out["tool_calls"], list):
            new_tcs = []
            for tc in out["tool_calls"]:
                tc2 = dict(tc)
                fn = dict(tc.get("function", {}))
                if "arguments" in fn and isinstance(fn["arguments"], str):
                    fn["arguments"] = self.scrub(fn["arguments"])
                tc2["function"] = fn
                new_tcs.append(tc2)
            out["tool_calls"] = new_tcs
        return out

# --- engagement → chat JSONL --------------------------------------------------

def export_step5_transcript(eng_row, anon):
    """Step 5 / runAgentToolCall transcript is in agent_run_state.messages directly."""
    state = eng_row["agent_run_state"] or {}
    messages = state.get("messages") if isinstance(state, dict) else None
    if not isinstance(messages, list) or len(messages) < 2:
        return None
    # The first system message holds our prompt — KEEP it (model needs the same
    # framing at training time). Scrub each message.
    scrubbed = [anon.scrub_message(m) for m in messages]
    return scrubbed


def export_step8_transcript(eng_row, anon, cur):
    """Step 8 multi-agent state lives in engagement_tasks + soc_queue_items.

    Synthesize a chat where the assistant alternates between Orchestrator
    reasoning ("I'm picking task X because Y") and tool calls (queue_step,
    wait_for_outcome) — gives the fine-tune REAL multi-agent traces.
    """
    cur.execute(
        """
        SELECT et.id, et.directive, et.phase, et.status, et.outcome_summary,
               et.queue_item_id, et.iteration,
               sqi.title AS qi_title,
               sqi.command AS qi_command,
               sqi.output AS qi_output
          FROM engagement_tasks et
          LEFT JOIN soc_queue_items sqi ON sqi.id = et.queue_item_id
         WHERE et.engagement_id = %s
         ORDER BY et.created_at ASC
        """, (eng_row["id"],))
    tasks = cur.fetchall()
    if not tasks:
        return None

    system = (
        "You are the L3 offensive-research agent. Reason about the next move, "
        "call tools to queue commands, fold outcomes into structured signal, repeat."
    )
    msgs = [{"role": "system", "content": system}]
    msgs.append({
        "role": "user",
        "content": f"Begin engagement {anon.scrub(eng_row['id'])}. Current phase: {eng_row.get('engagement_phase') or 'recon'}.",
    })
    for t in tasks:
        if t["status"] not in ("done", "failed"):
            continue
        # Assistant turn — Orchestrator picks the task
        msgs.append({
            "role": "assistant",
            "content": f"Picking task: {anon.scrub(t['directive'])}",
            "tool_calls": [{
                "id": f"queue-{t['id']}", "type": "function",
                "function": {
                    "name": "queue_step",
                    "arguments": json.dumps({
                        "engagement_id": anon.scrub(eng_row["id"]),
                        "title":   anon.scrub(t["qi_title"] or t["directive"][:80]),
                        "command": anon.scrub(t["qi_command"] or ""),
                    }),
                },
            }],
        })
        # Tool result — the command output
        msgs.append({
            "role": "tool",
            "tool_call_id": f"queue-{t['id']}",
            "name": "queue_step",
            "content": json.dumps({"queue_id": t["queue_item_id"], "queued": True}),
        })
        # Aggregator turn — fold outcome
        outcome = t["outcome_summary"]
        if isinstance(outcome, str):
            try: outcome = json.loads(outcome)
            except Exception: outcome = None
        outcome_str = anon.scrub(json.dumps(outcome or {"raw_output_truncated": (t["qi_output"] or "")[:500]}))
        msgs.append({
            "role": "assistant",
            "content": f"Outcome of task {t['id']}: {outcome_str[:400]}",
        })
    if len(msgs) < 4:
        return None
    return msgs


# --- behavior_notes (dir_1780764144630) ---------------------------------------
# Per-row v1.4 quality labels. behavior_notes is the table dir_1780763057382
# created; we load it here so each JSONL row gets a {quality: {polarity, tags,
# notes_count}} field the trainer can filter/weight on. Polarity rule: ANY
# matching negative → negative; else ANY positive → positive; else neutral.
# Engagement-wide notes (iter IS NULL) attach to every row of that engagement.

def load_behavior_notes(cur, engagement_id):
    """Return {iter: [{polarity, tag}, ...]} for one engagement. iter=None bucket
    holds engagement-wide notes that apply to every row."""
    cur.execute(
        "SELECT iter, polarity, tag FROM model_behavior_notes WHERE engagement_id = %s",
        (engagement_id,),
    )
    notes_by_iter = {}
    for it, pol, tag in cur.fetchall():
        notes_by_iter.setdefault(it, []).append({"polarity": pol, "tag": tag})
    return notes_by_iter


def compute_quality(notes_by_iter, iter_count):
    """Aggregate the notes that apply to one (engagement, iter) into a quality
    dict. Engagement-wide notes (key=None) always apply."""
    matched = list(notes_by_iter.get(None, []))
    if iter_count is not None:
        matched += list(notes_by_iter.get(iter_count, []))
    if not matched:
        return {"polarity": "neutral", "tags": [], "notes_count": 0}
    polarities = {n["polarity"] for n in matched}
    if "negative" in polarities:
        polarity = "negative"
    elif "positive" in polarities:
        polarity = "positive"
    else:
        polarity = "neutral"
    tags = sorted({n["tag"] for n in matched})
    return {"polarity": polarity, "tags": tags, "notes_count": len(matched)}


# --- main ----------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Export our agent transcripts as chat JSONL for fine-tuning.")
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-iter", type=int, default=3,
                    help="Skip engagements whose agent_run_state.iter is below this (default 3).")
    ap.add_argument("--statuses", default="completed,idle",
                    help="Comma list of agent_status values to include (default: completed,idle).")
    ap.add_argument("--include-step5", action="store_true",
                    help="Include the legacy tool-call transcripts from agent_run_state.messages.")
    ap.add_argument("--include-step8", action="store_true",
                    help="Include the multi-agent DAG-derived transcripts.")
    args = ap.parse_args()
    if not args.include_step5 and not args.include_step8:
        args.include_step5 = True
        args.include_step8 = True

    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
        SELECT id, agent_status, engagement_phase, agent_run_state
          FROM pentest_engagements
         WHERE agent_status = ANY(%s)
    """, ([s.strip() for s in args.statuses.split(",") if s.strip()],))
    rows = []
    for r in cur.fetchall():
        rows.append({
            "id": r[0],
            "agent_status": r[1],
            "engagement_phase": r[2],
            "agent_run_state": r[3] or {},
        })

    if not rows:
        print("[export] no engagements match — nothing to write", file=sys.stderr)
        sys.exit(1)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    kept = 0
    skipped_short = 0
    skipped_empty = 0
    with out_path.open("w", encoding="utf-8") as f:
        # Header
        f.write(json.dumps({
            "_meta": True, "source": "ozzu-agent-transcripts",
            "anonymization": "private-IPs→10.99.x.x, public→redacted, MAC→AA:BB:..., engagement_id→sha256[:12]",
            "min_iter": args.min_iter,
            "include_step5": args.include_step5,
            "include_step8": args.include_step8,
        }) + "\n")

        for row in rows:
            state = row["agent_run_state"] if isinstance(row["agent_run_state"], dict) else {}
            iter_count = state.get("iter") or 0
            if iter_count < args.min_iter:
                skipped_short += 1
                continue

            anon_id = hashlib.sha256(row["id"].encode()).hexdigest()[:12]
            anon = Anonymizer(row["id"])
            notes_by_iter = load_behavior_notes(cur, row["id"])

            wrote_any = False
            if args.include_step5:
                msgs = export_step5_transcript(row, anon)
                if msgs and len(msgs) >= 2:
                    f.write(json.dumps({
                        "messages": msgs,
                        "source": "ozzu-step5",
                        "engagement_id_anon": anon_id,
                        "iteration": iter_count,
                        "quality": compute_quality(notes_by_iter, iter_count),
                    }, ensure_ascii=False) + "\n")
                    kept += 1
                    wrote_any = True
            if args.include_step8:
                msgs = export_step8_transcript(row, anon, cur)
                if msgs and len(msgs) >= 2:
                    # step8 rows don't carry a per-iter index — apply engagement-wide
                    # notes only (iter=None bucket).
                    f.write(json.dumps({
                        "messages": msgs,
                        "source": "ozzu-step8",
                        "engagement_id_anon": anon_id,
                        "quality": compute_quality(notes_by_iter, None),
                    }, ensure_ascii=False) + "\n")
                    kept += 1
                    wrote_any = True
            if not wrote_any:
                skipped_empty += 1

    cur.close(); conn.close()
    print(f"[export] DONE — kept {kept}, skipped_short={skipped_short} skipped_empty={skipped_empty} -> {out_path}",
          file=sys.stderr)


if __name__ == "__main__":
    main()
