#!/usr/bin/env python3
"""
build-soc-synthetic.py — generate template-based synthetic training
examples for our specific MCP tool schemas (queue_step, advance_offense,
wait_for_outcome, get_engagement_state, etc.).

The 12% Glaive teaches the GENERAL form of function-calling, but the
model has never seen OUR specific tool names + schemas at training time.
A small batch of synthetic examples bridges that gap.

Conservative approach:
  - SMALL batch (~100 examples, ~0.5% of total v1.3 mix) — synthetic
    data has quality risks; keep it dilute
  - TEMPLATE-based — only 4 scenario types, each with parameter variation
  - REVIEW-able — print samples before persisting; operator can inspect
  - Qwen3-NATIVE format — emits <tool_call>\\n{json}\\n</tool_call> wrap
    matching what Qwen3's chat template expects

Usage:
  python3 build-soc-synthetic.py --out /home/gcp/ozzu/private/finetune/dataset-v1.3/soc-synthetic.jsonl
"""
import argparse
import json
import random
from pathlib import Path

# Realistic-but-anonymized engagement contexts
ENGAGEMENT_CONTEXTS = [
    {"id": "SK-2026-A", "scope": "192.168.50.0/24", "phase": "recon",        "executor": "dev-01",      "hosts_known": 0},
    {"id": "SK-2026-B", "scope": "10.10.10.0/24",   "phase": "enumeration",  "executor": "dev-01",      "hosts_known": 3},
    {"id": "SK-2026-C", "scope": "172.16.0.0/16",   "phase": "foothold",     "executor": "tablet-p610", "hosts_known": 7},
    {"id": "SK-2026-D", "scope": "10.99.99.0/24",   "phase": "exploitation", "executor": "dev-01",      "hosts_known": 2},
]

SYSTEM_PROMPT_TEMPLATES = [
    "You are the COMMAND SYNTHESIZER of an offensive-research multi-agent system. "
    "Translate task directives into shell commands by calling queue_step. Use the available tools to interact with the engagement state.",
    "You are the TASK ORCHESTRATOR of a SOC pipeline. Decide which engagement_task to execute next. Call the available tools to inspect state and queue work.",
    "You are an autonomous offensive-research agent. The available tools let you queue steps for the PA engineer, wait for outcomes, and advance engagement phases.",
]

# ─────────────────────────── Scenario templates ───────────────────────────

def gen_recon_scan(ctx):
    """User asks for recon → assistant calls queue_step with an nmap-style command."""
    return {
        "system": random.choice(SYSTEM_PROMPT_TEMPLATES),
        "user":   f"Run a TCP port sweep against the {ctx['scope']} subnet for engagement {ctx['id']}. Use a top-1000-port nmap with service version detection.",
        "assistant_call": {
            "name": "queue_step",
            "arguments": {
                "engagement_id": ctx["id"],
                "title": "TCP port sweep + service detection",
                "command": f"nmap -sV --top-ports 1000 -oA recon-tcp {ctx['scope']}",
                "expected_artifact": "list of open TCP ports with service banners per host",
                "references": [],
            },
        },
        "tool_result": {"queue_id": random.randint(100, 999), "seq": ctx["hosts_known"] + 1, "title": "TCP port sweep + service detection", "note": "queued"},
        "assistant_followup": "Queued. I'll wait for the outcome before deciding next steps.",
    }


def gen_state_check(ctx):
    """User asks for current state → assistant calls get_engagement_state."""
    return {
        "system": random.choice(SYSTEM_PROMPT_TEMPLATES),
        "user":   f"What's the current state of engagement {ctx['id']}? I need a summary of known hosts and queued items before deciding the next move.",
        "assistant_call": {
            "name": "get_engagement_state",
            "arguments": {"engagement_id": ctx["id"]},
        },
        "tool_result": {
            "engagement_id": ctx["id"],
            "phase": ctx["phase"],
            "scope": ctx["scope"],
            "executor_host": ctx["executor"],
            "n_recon_hosts": ctx["hosts_known"],
            "n_findings": 0,
            "recent_queue": [],
        },
        "assistant_followup": (
            f"Engagement {ctx['id']} is in phase '{ctx['phase']}' with {ctx['hosts_known']} known hosts. "
            f"Executor is {ctx['executor']}. Next: I'll {'start with recon' if ctx['hosts_known'] == 0 else 'enumerate the discovered services'}."
        ),
    }


def gen_wait_outcome(ctx):
    """Multi-turn: queue_step → wait_for_outcome → handle result."""
    queue_id = random.randint(100, 999)
    return {
        "system": random.choice(SYSTEM_PROMPT_TEMPLATES),
        "user":   f"Step #{queue_id} on engagement {ctx['id']} should be running. Check if it's finished and tell me what happened.",
        "assistant_call": {
            "name": "wait_for_outcome",
            "arguments": {"queue_item_id": queue_id, "timeout_sec": 300},
        },
        "tool_result": {
            "queue_item_id": queue_id,
            "status": "done",
            "output_preview": f"Discovered {random.randint(2, 8)} responsive hosts on {ctx['scope']}. Common services: SSH (22), HTTP (80), SMB (445).",
        },
        "assistant_followup": (
            f"Step #{queue_id} completed. Output shows responsive hosts in {ctx['scope']} with SSH/HTTP/SMB exposed. "
            f"Next phase candidates: enumerate SMB shares for sensitive data, fingerprint HTTP for known vulnerable web apps."
        ),
    }


def gen_advance_phase(ctx):
    """Move engagement to next phase."""
    phase_order = ["recon", "enumeration", "foothold", "exploitation", "post_exploit", "reporting"]
    current_idx = phase_order.index(ctx["phase"]) if ctx["phase"] in phase_order else 0
    next_phase = phase_order[min(current_idx + 1, len(phase_order) - 1)]
    return {
        "system": random.choice(SYSTEM_PROMPT_TEMPLATES),
        "user":   f"Engagement {ctx['id']} is done with {ctx['phase']}. Move to the next phase.",
        "assistant_call": {
            "name": "advance_phase",
            "arguments": {"engagement_id": ctx["id"], "new_phase": next_phase},
        },
        "tool_result": {"engagement_id": ctx["id"], "old_phase": ctx["phase"], "new_phase": next_phase, "note": "phase advanced"},
        "assistant_followup": (
            f"Phase advanced from {ctx['phase']} to {next_phase}. "
            f"I'll now focus on {next_phase}-appropriate actions."
        ),
    }


SCENARIOS = [gen_recon_scan, gen_state_check, gen_wait_outcome, gen_advance_phase]


def build_messages(scenario):
    """Convert a scenario dict into Qwen3-native messages with <tool_call> wrap."""
    msgs = [
        {"role": "system", "content": scenario["system"]},
        {"role": "user",   "content": scenario["user"]},
    ]
    call_json = json.dumps(scenario["assistant_call"], ensure_ascii=False)
    msgs.append({"role": "assistant", "content": f"<tool_call>\n{call_json}\n</tool_call>"})
    msgs.append({"role": "tool",      "content": json.dumps(scenario["tool_result"], ensure_ascii=False)})
    msgs.append({"role": "assistant", "content": scenario["assistant_followup"]})
    return msgs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=100, help="Number of synthetic examples to generate (default 100)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--preview", action="store_true", help="Print 3 sample rows then exit")
    args = ap.parse_args()
    random.seed(args.seed)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    examples = []
    for i in range(args.n):
        ctx = random.choice(ENGAGEMENT_CONTEXTS)
        scenario = random.choice(SCENARIOS)(ctx)
        ex = {
            "messages": build_messages(scenario),
            "source": "ozzu-soc-synthetic",
            "scenario": scenario["assistant_call"]["name"],
            "id": f"synth-{i}",
        }
        examples.append(ex)

    if args.preview:
        for ex in examples[:3]:
            print(f"--- scenario: {ex['scenario']} ---")
            for m in ex["messages"]:
                c = (m.get("content") or "")[:300]
                print(f"  [{m['role']}] {c}{'...' if len(m.get('content','')) > 300 else ''}")
            print()
        return

    with out_path.open("w") as f:
        f.write(json.dumps({"_meta": True, "source": "ozzu-soc-synthetic", "n": len(examples)}) + "\n")
        for ex in examples:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")

    from collections import Counter
    by_scenario = Counter(ex["scenario"] for ex in examples)
    print(f"wrote {len(examples)} synthetic examples → {out_path}", flush=True)
    print(f"  scenario distribution:")
    for s, n in by_scenario.most_common():
        print(f"    {s:<24} {n}")


if __name__ == "__main__":
    main()
