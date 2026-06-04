#!/usr/bin/env python3
"""
train.py — Step 9.4 of OFFENSE-FINETUNE-DESIGN.md (dir_1780595306981)

The actual LoRA training loop. Runs ON a bootstrapped DO MI300X droplet
(see bootstrap.sh, Step 9.3). Loads Qwen3-32B base, applies LoRA per the
xOffense-derived recipe, trains on chat JSONL prepared by merge.py.

bf16 throughout — no quantization. The MI300X's 192 GB VRAM fits the
full bf16 model (≈65 GB) + LoRA params + optimizer state + gradients +
activations at seq_len 4096 with batch 1 + grad-accum 16 (effective batch 16).

Adapter-only output (~600 MB) — not the full ~65 GB model. Loaded into
Ollama later via a Modelfile that references both base + adapter.

Usage on the droplet:
  cd /opt/ozzu-train && source venv/bin/activate
  python3 /root/train.py \
    --base-model Qwen/Qwen3-32B \
    --dataset /root/dataset/train.jsonl \
    --eval-dataset /root/dataset/eval.jsonl \
    --output-dir /root/output/ozzu-soc-v1 \
    --epochs 3

Resumable: --resume-from-checkpoint /root/output/ozzu-soc-v1/checkpoint-N
"""
import argparse
import json
import os
import sys
from pathlib import Path


def parse_args():
    ap = argparse.ArgumentParser(description="LoRA fine-tune Qwen3-32B for offensive-research.")
    ap.add_argument("--base-model", default="Qwen/Qwen3-32B")
    ap.add_argument("--dataset", required=True, help="Training JSONL (output of merge.py).")
    ap.add_argument("--eval-dataset", default=None, help="Optional eval JSONL.")
    ap.add_argument("--output-dir", required=True, help="Where to save adapter + checkpoints.")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--rank", type=int, default=32, help="LoRA rank (xOffense used ~16, we have headroom).")
    ap.add_argument("--alpha", type=int, default=64, help="LoRA alpha (typically 2× rank).")
    ap.add_argument("--lora-dropout", type=float, default=0.05)
    ap.add_argument("--max-seq-length", type=int, default=4096)
    ap.add_argument("--per-device-batch-size", type=int, default=1)
    ap.add_argument("--gradient-accumulation-steps", type=int, default=16)
    ap.add_argument("--warmup-ratio", type=float, default=0.03)
    ap.add_argument("--logging-steps", type=int, default=10)
    ap.add_argument("--save-steps", type=int, default=500)
    ap.add_argument("--eval-steps", type=int, default=500)
    ap.add_argument("--resume-from-checkpoint", default=None)
    ap.add_argument("--seed", type=int, default=42)
    return ap.parse_args()


def main():
    args = parse_args()

    # ── preflight: GPU sanity ──
    try:
        import torch
    except ImportError:
        print("[train] FATAL: torch not installed. Run bootstrap.sh first.", file=sys.stderr)
        sys.exit(2)
    if not torch.cuda.is_available():
        print("[train] FATAL: torch.cuda.is_available() is False — ROCm/PyTorch not wired to the GPU.",
              file=sys.stderr)
        sys.exit(3)
    n_gpu = torch.cuda.device_count()
    for i in range(n_gpu):
        p = torch.cuda.get_device_properties(i)
        print(f"[train] GPU {i}: {p.name} · {p.total_memory / 1024**3:.1f} GiB · CC {p.major}.{p.minor}",
              file=sys.stderr)

    # ── HF stack (imported here so the preflight failure shows torch issues first) ──
    from datasets import load_dataset
    from transformers import (
        AutoModelForCausalLM, AutoTokenizer,
        TrainingArguments, Trainer, DataCollatorForLanguageModeling,
        set_seed,
    )
    from peft import LoraConfig, get_peft_model, TaskType, prepare_model_for_kbit_training

    set_seed(args.seed)

    # ── load tokenizer + base model ──
    print(f"[train] loading tokenizer for {args.base_model}", file=sys.stderr)
    tokenizer = AutoTokenizer.from_pretrained(args.base_model, trust_remote_code=True)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token

    print(f"[train] loading base model {args.base_model} in bf16 (this is ~65 GB; ~3 min on fast disk)", file=sys.stderr)
    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        torch_dtype=torch.bfloat16,
        device_map="auto",       # auto-shards if multi-GPU; single MI300X gets everything
        trust_remote_code=True,
        attn_implementation="sdpa",   # PyTorch 2.5 SDPA includes flash kernel on ROCm
    )
    # Enable gradient checkpointing to free activations
    model.gradient_checkpointing_enable()
    model.enable_input_require_grads()

    # ── LoRA config (xOffense-derived) ──
    lora_cfg = LoraConfig(
        r=args.rank,
        lora_alpha=args.alpha,
        lora_dropout=args.lora_dropout,
        bias="none",
        task_type=TaskType.CAUSAL_LM,
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
    )
    model = get_peft_model(model, lora_cfg)
    trainable, total = 0, 0
    for n, p in model.named_parameters():
        total += p.numel()
        if p.requires_grad: trainable += p.numel()
    print(f"[train] LoRA enabled: trainable {trainable/1e6:.1f}M / total {total/1e9:.1f}B "
          f"({100*trainable/total:.3f}% trainable)", file=sys.stderr)

    # ── dataset ──
    print(f"[train] loading dataset {args.dataset}", file=sys.stderr)
    data_files = {"train": args.dataset}
    if args.eval_dataset and Path(args.eval_dataset).exists():
        data_files["eval"] = args.eval_dataset
    ds = load_dataset("json", data_files=data_files)

    def format_example(ex):
        """Apply Qwen3's chat template to the messages array. Returns {input_ids, labels}."""
        msgs = ex.get("messages") or []
        # Tokenize the whole conversation as one continuous sequence; labels = input_ids
        # so the model trains on every token (including the assistant turn).
        text = tokenizer.apply_chat_template(msgs, tokenize=False, add_generation_prompt=False)
        enc = tokenizer(
            text,
            truncation=True,
            max_length=args.max_seq_length,
            padding=False,
            return_tensors=None,
        )
        enc["labels"] = enc["input_ids"].copy()
        return enc

    print(f"[train] tokenizing (chat template) …", file=sys.stderr)
    train_ds = ds["train"].map(format_example, remove_columns=ds["train"].column_names, num_proc=4)
    eval_ds  = ds["eval"].map(format_example, remove_columns=ds["eval"].column_names, num_proc=4) if "eval" in ds else None
    print(f"[train] train={len(train_ds)} eval={len(eval_ds) if eval_ds is not None else 0}", file=sys.stderr)

    # ── trainer ──
    collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    training_args = TrainingArguments(
        output_dir=str(output_dir),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.per_device_batch_size,
        per_device_eval_batch_size=args.per_device_batch_size,
        gradient_accumulation_steps=args.gradient_accumulation_steps,
        learning_rate=args.lr,
        warmup_ratio=args.warmup_ratio,
        lr_scheduler_type="cosine",
        logging_steps=args.logging_steps,
        save_strategy="steps",
        save_steps=args.save_steps,
        save_total_limit=3,           # keep only the 3 most recent checkpoints
        eval_strategy="steps" if eval_ds is not None else "no",
        eval_steps=args.eval_steps if eval_ds is not None else None,
        bf16=True,
        gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        optim="adamw_torch",
        weight_decay=0.0,
        report_to="none",
        ddp_find_unused_parameters=False,
        dataloader_num_workers=2,
        seed=args.seed,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        data_collator=collator,
        tokenizer=tokenizer,
    )

    # ── train ──
    print(f"[train] starting training: {args.epochs} epochs, effective batch = "
          f"{args.per_device_batch_size * args.gradient_accumulation_steps} "
          f"(per-device {args.per_device_batch_size} × grad-accum {args.gradient_accumulation_steps})",
          file=sys.stderr)
    trainer.train(resume_from_checkpoint=args.resume_from_checkpoint)

    # ── save adapter only ──
    final_dir = output_dir / "final-adapter"
    print(f"[train] saving final LoRA adapter to {final_dir}", file=sys.stderr)
    model.save_pretrained(str(final_dir))
    tokenizer.save_pretrained(str(final_dir))

    # ── write a small manifest so deploy/load.sh knows what to load ──
    manifest = {
        "base_model": args.base_model,
        "adapter_dir": str(final_dir),
        "rank": args.rank,
        "alpha": args.alpha,
        "lora_dropout": args.lora_dropout,
        "epochs": args.epochs,
        "lr": args.lr,
        "max_seq_length": args.max_seq_length,
        "effective_batch_size": args.per_device_batch_size * args.gradient_accumulation_steps,
        "dataset": args.dataset,
        "trainable_params_M": round(trainable / 1e6, 1),
    }
    with (output_dir / "manifest.json").open("w") as f:
        json.dump(manifest, f, indent=2)

    print(f"[train] DONE — adapter at {final_dir}, manifest at {output_dir / 'manifest.json'}",
          file=sys.stderr)
    print("[train] Next: scp -r ${final_dir} back to the bridge, then deploy/load.sh", file=sys.stderr)


if __name__ == "__main__":
    main()
