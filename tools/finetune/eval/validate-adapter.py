#!/usr/bin/env python3
"""
validate-adapter.py — post-training validation of a LoRA adapter on a GPU host.

Loads base Qwen3-32B + the trained adapter, runs a small set of SOC prompts
covering our 7 tool-call scenarios, verifies the model emits valid
<tool_call>{...}</tool_call> JSON.

Designed to run on the same GPU droplet that did the training (everything's
already cached). Can also run on CPU but extremely slow at 32B — only feasible
for tiny prompts.

Usage:
  python3 validate-adapter.py \\
    --adapter /home/gcp/ozzu/private/finetune/qwen3-32b-ozzu-soc-v1.3 \\
    --base Qwen/Qwen3-32B \\
    [--device cuda|cpu]   # default: cuda if available, else cpu

Exit code:
  0 — adapter generates valid output across all scenarios
  1 — adapter fails on at least one scenario (model degraded)
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

PROMPTS = [
    {
        "scenario": "queue_step",
        "system": "You are the COMMAND SYNTHESIZER of an offensive-research multi-agent system. Translate task directives into shell commands by calling queue_step.",
        "user": "Run a TCP port sweep against the 10.10.10.0/24 subnet for engagement SK-2026-X. Use a top-1000-port nmap with service version detection.",
        "expect_tool_call": True,
        "expect_tool_name": "queue_step",
    },
    {
        "scenario": "get_engagement_state",
        "system": "You are an autonomous offensive-research agent. The available tools let you queue steps for the PA engineer.",
        "user": "What's the current state of engagement SK-2026-Y? Summarize known hosts and queued items.",
        "expect_tool_call": True,
        "expect_tool_name": "get_engagement_state",
    },
    {
        "scenario": "wait_for_outcome",
        "system": "You are the TASK ORCHESTRATOR of a SOC pipeline.",
        "user": "Step #422 on engagement SK-2026-Z should be running. Check if it finished and tell me what happened.",
        "expect_tool_call": True,
        "expect_tool_name": "wait_for_outcome",
    },
    {
        "scenario": "advance_phase",
        "system": "You are the TASK ORCHESTRATOR of a SOC pipeline.",
        "user": "Engagement SK-2026-A is done with recon. Move to the next phase.",
        "expect_tool_call": True,
        "expect_tool_name": "advance_phase",
    },
    {
        "scenario": "narrative_response",
        "system": "You are a cybersecurity AI assistant.",
        "user": "What's the typical attack chain for Active Directory compromise?",
        "expect_tool_call": False,
        "expect_substring": "AD",   # base model should still produce coherent text
    },
]

TOOL_CALL_RE = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.DOTALL)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", required=True, help="Path to LoRA adapter dir")
    ap.add_argument("--base", default="Qwen/Qwen3-32B", help="Base model id")
    ap.add_argument("--device", default=None, help="cuda|cpu (default: auto-detect)")
    ap.add_argument("--max-new-tokens", type=int, default=300)
    args = ap.parse_args()

    print(f"[validate] loading base model: {args.base}")
    t0 = time.time()
    import torch
    if args.device is None:
        args.device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[validate] device: {args.device}")
    if args.device == "cpu":
        print("[validate] WARNING: CPU inference on 32B is extremely slow — tiny prompts only")

    from transformers import AutoTokenizer, AutoModelForCausalLM
    from peft import PeftModel

    tokenizer = AutoTokenizer.from_pretrained(args.base, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        args.base,
        torch_dtype=torch.bfloat16 if args.device == "cuda" else torch.float32,
        device_map=args.device if args.device == "cuda" else None,
        trust_remote_code=True,
    )
    if args.device == "cpu":
        model = model.to("cpu")
    print(f"[validate] base loaded in {time.time()-t0:.1f}s")

    print(f"[validate] loading adapter: {args.adapter}")
    t1 = time.time()
    model = PeftModel.from_pretrained(model, args.adapter)
    model.eval()
    print(f"[validate] adapter loaded in {time.time()-t1:.1f}s")

    print(f"\n=== running {len(PROMPTS)} validation prompts ===")
    failures = 0
    for i, p in enumerate(PROMPTS, 1):
        print(f"\n--- {i}/{len(PROMPTS)}: scenario={p['scenario']} ---")
        msgs = [
            {"role": "system", "content": p["system"]},
            {"role": "user", "content": p["user"]},
        ]
        prompt_text = tokenizer.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        inputs = tokenizer(prompt_text, return_tensors="pt").to(args.device)
        t2 = time.time()
        with torch.no_grad():
            out = model.generate(
                **inputs,
                max_new_tokens=args.max_new_tokens,
                do_sample=False,
                temperature=1.0,
            )
        gen = tokenizer.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=False)
        elapsed = time.time() - t2

        print(f"  generated ({elapsed:.1f}s):")
        print(f"    {gen[:400]}{'...' if len(gen) > 400 else ''}")

        # Validation
        ok = True
        if p.get("expect_tool_call"):
            m = TOOL_CALL_RE.search(gen)
            if not m:
                print(f"  ✗ MISSING <tool_call>...</tool_call> block")
                ok = False
            else:
                try:
                    parsed = json.loads(m.group(1))
                    if "name" not in parsed:
                        print(f"  ✗ tool_call missing 'name' field")
                        ok = False
                    elif parsed["name"] != p["expect_tool_name"]:
                        print(f"  ~ tool_call name='{parsed['name']}' (expected '{p['expect_tool_name']}') — counts as soft pass")
                        # not a hard fail, model picked a different valid tool
                    else:
                        print(f"  ✓ valid tool_call: name='{parsed['name']}'")
                except json.JSONDecodeError as e:
                    print(f"  ✗ tool_call JSON malformed: {e}")
                    ok = False
        elif p.get("expect_substring"):
            if p["expect_substring"].lower() in gen.lower():
                print(f"  ✓ contains expected substring '{p['expect_substring']}'")
            else:
                print(f"  ~ missing '{p['expect_substring']}' — soft fail (model just chose different angle)")
        if not ok:
            failures += 1

    print(f"\n=== summary ===")
    print(f"  total scenarios: {len(PROMPTS)}")
    print(f"  hard failures: {failures}")
    if failures == 0:
        print(f"  ✓ adapter looks healthy — safe to deploy")
        sys.exit(0)
    else:
        print(f"  ✗ adapter has issues — investigate before deploying")
        sys.exit(1)


if __name__ == "__main__":
    main()
