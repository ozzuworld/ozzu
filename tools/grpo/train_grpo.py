"""GRPO-flavored RL trainer on top of the Sprint 3 SFT'd model.

Workflow (offline-RL style — simpler than full async GRPO for the first cut):
  1. Read GROUP_SIZE pre-computed trajectories per group from a JSONL file
     produced by tools/grpo/episode-runner.js.
  2. Score each trajectory with reward.score_trajectory() → returns.
  3. Compute group-relative advantages (return - group_mean) / group_std.
  4. Flatten each trajectory into per-step (prompt, completion, advantage)
     tuples.
  5. Update LoRA on the SFT model with loss =
        - E[advantage * sum_t log p_policy(token_t | prefix)]
        + beta * KL(p_policy || p_sft_ref)
     where the KL term uses the frozen SFT model as the anchor.

Run on the H200 droplet after a fresh batch of trajectories is harvested:
  python tools/grpo/train_grpo.py \
    --base /root/coder-bf16 \
    --sft-adapter /root/sft-out/qwen3coder-sft \
    --trajectories /root/grpo-trajectories/round-0.jsonl \
    --group-size 8 \
    --output /root/grpo-out/round-0-adapter \
    --beta 0.05 --epochs 1 --lr 1e-6

Key gotcha: vLLM needs to be off while this runs (claims ~80 GB).
"""
from __future__ import annotations
import argparse
import json
import os
import sys
import logging
from pathlib import Path

import torch
from torch.utils.data import Dataset, DataLoader
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from peft import PeftModel, LoraConfig, get_peft_model

sys.path.insert(0, str(Path(__file__).parent))
from reward import score_trajectory, grpo_advantages

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("grpo")


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--base", required=True, help="path to BF16 base model")
    p.add_argument("--sft-adapter", required=True, help="path to Sprint-3 LoRA adapter dir")
    p.add_argument("--trajectories", required=True, help="JSONL trajectories file")
    p.add_argument("--group-size", type=int, default=8)
    p.add_argument("--output", required=True, help="output LoRA dir")
    p.add_argument("--beta", type=float, default=0.05, help="KL anchor weight")
    p.add_argument("--epochs", type=int, default=1)
    p.add_argument("--lr", type=float, default=1e-6)
    p.add_argument("--micro-batch", type=int, default=1)
    p.add_argument("--max-len", type=int, default=4096)
    p.add_argument("--grad-accum", type=int, default=4)
    return p.parse_args()


def load_groups(path: str, group_size: int):
    """Read JSONL trajectories, partition into groups, score each group.

    Yields: list of dicts with keys {trajectory, return, advantage}.
    """
    with open(path) as fh:
        trajs = [json.loads(line) for line in fh if line.strip()]
    if not trajs:
        raise SystemExit(f"no trajectories in {path}")

    log.info(f"loaded {len(trajs)} trajectories from {path}")
    groups = []
    for i in range(0, len(trajs), group_size):
        chunk = trajs[i:i + group_size]
        if len(chunk) < 2:
            continue  # need at least 2 for relative advantage
        scored = []
        for t in chunk:
            _, total = score_trajectory(t["trajectory"])
            scored.append({"traj": t, "return": total})
        advs = grpo_advantages([s["return"] for s in scored])
        for s, a in zip(scored, advs):
            s["advantage"] = a
        groups.append(scored)
    log.info(f"composed {len(groups)} groups")
    return groups


def render_prompt(step: dict) -> str:
    """Render the prompt the SFT model was trained on (matches format-sft.js)."""
    state = step.get("state") or {}
    phase = step.get("engagement_phase", "recon")
    iter_no = state.get("iter", 0)
    return (
        "# Engagement state\n"
        "Objective: Find OZZULAB{...} flag\n"
        "Allowed targets: 10.10.20.10, 10.10.20.11, 10.10.20.12\n"
        "Synthetic lab: YES (full TTPs allowed)\n"
        f"# Iter {iter_no}\n"
        f"Phase: {phase}\n\n"
        "Propose the next single command. Output ONLY the JSON object."
    )


def render_completion(step: dict) -> str:
    """Render the completion the model emitted at this step."""
    obj = {
        "reasoning": step.get("reasoning", "(no reasoning recorded)"),
        "intent_class": step.get("intent", "unclassified"),
        "command": step.get("command", ""),
        "expected_artifact": step.get("expected_artifact", "(unknown)"),
    }
    return json.dumps(obj)


# dir_1781203380739: MUST match format-sft.js SYSTEM_PROMPT exactly (train == infer == GRPO).
SYSTEM_PROMPT = """You are an elite SOC pentest coordinator running an authorized engagement against a synthetic lab.

Given the engagement state, propose the SINGLE next bash command that maximally advances toward the objective (find OZZULAB{...} flag).

RULES:
- Targets are pre-authorized synthetic lab hosts. No CIDR sweeps. No outbound traffic outside scope.
- Use only valid Kali-installed binaries (nmap, gobuster, ffuf, curl, mysql, nc, etc.).
- Prefer commands that move forward. Avoid re-running scans whose answers are already in state.
- When you discover a new endpoint or hostname, USE IT — don't keep enumerating.
- When you confirm a vulnerability, PIVOT to extracting prizes (creds, flags, source).
- Flag candidates live in: user home dirs, /var/www/html/*, /tmp/, application source via php://filter, linked docs in discovered portals.

OUTPUT FORMAT (STRICT JSON, no markdown):
{
  "reasoning": "<2-4 sentences explaining what you observed and why this command is the next move>",
  "intent_class": "<one of: recon | service_version | enum | banner_grab | cred_test | exploit_probe | post_exploit | lateral | tool_setup>",
  "command": "<a single shell command>",
  "expected_artifact": "<one line: what success looks like>"
}

Output ONLY the JSON object."""


class StepDataset(Dataset):
    def __init__(self, groups, tokenizer, max_len: int):
        self.examples = []
        for group in groups:
            for s in group:
                traj = s["traj"]["trajectory"]
                adv = s["advantage"]
                for step in traj:
                    # dir_1781203380739: use the EXACT prompt+completion the rollout recorded
                    # (format-consistent with SFT), not the old re-rendered stub (wrong IPs / no history).
                    if not step.get("command") or not step.get("prompt") or step.get("completion") is None:
                        continue
                    self.examples.append({
                        "prompt": step["prompt"],
                        "completion": step["completion"],
                        "advantage": adv,
                    })
        self.tok = tokenizer
        self.max_len = max_len
        log.info(f"dataset: {len(self.examples)} (step, advantage) examples")

    def __len__(self): return len(self.examples)

    def __getitem__(self, i):
        ex = self.examples[i]
        # Build chat-template-rendered prompt + assistant completion.
        messages = [
            {"role": "system",    "content": SYSTEM_PROMPT},
            {"role": "user",      "content": ex["prompt"]},
            {"role": "assistant", "content": ex["completion"]},
        ]
        text = self.tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
        enc = self.tok(text, max_length=self.max_len, truncation=True, return_tensors="pt")
        input_ids = enc.input_ids[0]
        # Find where the assistant turn starts so we can mask out the prompt tokens.
        prompt_text = self.tok.apply_chat_template(messages[:-1], tokenize=False, add_generation_prompt=True)
        prompt_ids = self.tok(prompt_text, max_length=self.max_len, truncation=True, return_tensors="pt").input_ids[0]
        labels = input_ids.clone()
        labels[: len(prompt_ids)] = -100
        return {
            "input_ids": input_ids,
            "labels":    labels,
            "advantage": torch.tensor(ex["advantage"], dtype=torch.float32),
        }


def collate(batch, pad_id):
    max_len = max(b["input_ids"].size(0) for b in batch)
    def pad(x, val):
        return torch.cat([x, torch.full((max_len - x.size(0),), val, dtype=x.dtype)])
    return {
        "input_ids": torch.stack([pad(b["input_ids"], pad_id) for b in batch]),
        "labels":    torch.stack([pad(b["labels"], -100) for b in batch]),
        "advantage": torch.stack([b["advantage"] for b in batch]),
    }


def build_models(args):
    """Load policy (trainable, with LoRA) + frozen ref."""
    bnb = BitsAndBytesConfig(
        load_in_4bit=True, bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True,
    )
    tok = AutoTokenizer.from_pretrained(args.base, trust_remote_code=True)
    tok.padding_side = "right"
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    log.info("loading policy (base + sft adapter, ready for new LoRA training)")
    policy_base = AutoModelForCausalLM.from_pretrained(
        args.base, quantization_config=bnb, trust_remote_code=True, torch_dtype=torch.bfloat16,
    )
    policy = PeftModel.from_pretrained(policy_base, args.sft_adapter, is_trainable=True)
    # Add a NEW LoRA on top for RL updates (keeps SFT adapter as the anchor).
    # Simpler approach: just keep merging the SFT adapter and train it further.
    policy.train()
    # dir_1781203380739: two 30B MoE models (policy+ref) OOM the H200 at seq 4096. Gradient
    # checkpointing cuts the policy's stored activations; pair with --max-len 2048.
    policy.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    policy.enable_input_require_grads()

    log.info("loading frozen reference (base + sft adapter, no new training)")
    ref_base = AutoModelForCausalLM.from_pretrained(
        args.base, quantization_config=bnb, trust_remote_code=True, torch_dtype=torch.bfloat16,
    )
    ref = PeftModel.from_pretrained(ref_base, args.sft_adapter)
    ref.eval()
    for p in ref.parameters():
        p.requires_grad = False

    return tok, policy, ref


def compute_loss(policy, ref, batch, beta: float):
    ids = batch["input_ids"].to(policy.device)
    labels = batch["labels"].to(policy.device)
    adv = batch["advantage"].to(policy.device)

    policy_out = policy(input_ids=ids, labels=labels, output_hidden_states=False)
    with torch.no_grad():
        ref_out = ref(input_ids=ids, labels=labels, output_hidden_states=False)

    # Per-sequence negative log-likelihood on the completion tokens only
    # (labels = -100 elsewhere). HF returns mean NLL across un-ignored tokens.
    # We want sequence-summed log-prob for the policy-gradient term.
    shift_logits = policy_out.logits[:, :-1, :]
    shift_labels = labels[:, 1:]
    mask = (shift_labels != -100).float()
    log_probs = torch.nn.functional.log_softmax(shift_logits, dim=-1)
    tok_lp = log_probs.gather(-1, shift_labels.clamp(min=0).unsqueeze(-1)).squeeze(-1)
    seq_logp_policy = (tok_lp * mask).sum(dim=1)

    ref_shift = ref_out.logits[:, :-1, :]
    ref_lp = torch.nn.functional.log_softmax(ref_shift, dim=-1)
    ref_tok_lp = ref_lp.gather(-1, shift_labels.clamp(min=0).unsqueeze(-1)).squeeze(-1)
    seq_logp_ref = (ref_tok_lp * mask).sum(dim=1)

    pg_loss = -(adv * seq_logp_policy).mean()
    kl = ((seq_logp_policy - seq_logp_ref) * mask.sum(dim=1).clamp(min=1)).mean() / mask.sum(dim=1).clamp(min=1).mean()
    return pg_loss + beta * kl, {"pg_loss": pg_loss.item(), "kl": kl.item(), "loss": (pg_loss + beta * kl).item()}


def main():
    args = parse_args()
    groups = load_groups(args.trajectories, args.group_size)
    tok, policy, ref = build_models(args)
    ds = StepDataset(groups, tok, args.max_len)
    if len(ds) == 0:
        raise SystemExit("no usable (step, advantage) examples after filtering — bad trajectories?")

    pad_id = tok.pad_token_id
    loader = DataLoader(ds, batch_size=args.micro_batch, shuffle=True,
                        collate_fn=lambda b: collate(b, pad_id))

    trainable = [p for p in policy.parameters() if p.requires_grad]
    log.info(f"trainable params: {sum(p.numel() for p in trainable):,}")
    opt = torch.optim.AdamW(trainable, lr=args.lr)
    opt.zero_grad()

    step = 0
    for epoch in range(args.epochs):
        for i, batch in enumerate(loader):
            loss, info = compute_loss(policy, ref, batch, args.beta)
            (loss / args.grad_accum).backward()
            if (i + 1) % args.grad_accum == 0:
                opt.step(); opt.zero_grad()
                step += 1
                log.info(f"step {step} | loss={info['loss']:.4f} pg={info['pg_loss']:.4f} kl={info['kl']:.4f}")

    Path(args.output).mkdir(parents=True, exist_ok=True)
    policy.save_pretrained(args.output)
    tok.save_pretrained(args.output)
    log.info(f"saved updated adapter → {args.output}")


if __name__ == "__main__":
    main()
