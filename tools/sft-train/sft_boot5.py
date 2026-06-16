"""boot5 SFT trainer — Qwen3-Coder-30B-A3B QLoRA, FAST config.

dir_1781203380739 — boot5 = the full-diverse held-out generalization test.
Identical OPTIMIZATION to boot3/boot4 (QLoRA r32/a64 attention-only, lr 2e-5 cosine,
3 epochs, 4-bit NF4, completion-preserving __getitem__) so the held-out v3 number is a
clean apples-to-apples comparison. ONLY the throughput levers changed vs the 3.3h H200 run:

  micro-batch 1 -> MICRO_BATCH (default 4)   : feed the under-utilized 3B-active MoE
  gradient_checkpointing True -> GRAD_CKPT   : default OFF; 80GB fits seq-4096 w/ sdpa-flash
  dataloader_num_workers 0 -> NUM_WORKERS    : overlap the 2x chat-template tokenize
  eval_strategy steps -> "no"                : no eval OOM, no wasted eval passes

All config is env-tunable so we can run a short MAX_STEPS probe to measure VRAM + s/it,
then launch the full run with the config that fits.

Env knobs: MICRO_BATCH GRAD_ACCUM EPOCHS GRAD_CKPT MAX_LEN NUM_WORKERS MAX_STEPS BASE TRAIN OUT
"""
import os, json, torch
from pathlib import Path
from torch.utils.data import Dataset
from transformers import (
    AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig,
    Trainer, TrainingArguments,
)
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

# Fast-attn + cuDNN-off (cuDNN SDPA graph-execute bug bit us at long seq on the H200)
torch.backends.cuda.enable_cudnn_sdp(False)
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")  # safe w/ dataloader workers

BASE        = os.environ.get("BASE", "/root/coder-bf16")
TRAIN       = os.environ.get("TRAIN", "/root/boot5-train.jsonl")
OUT         = os.environ.get("OUT", "/root/sft-out/bootstrap-v5")
MAX_LEN     = int(os.environ.get("MAX_LEN", "4096"))
MICRO_BATCH = int(os.environ.get("MICRO_BATCH", "4"))
GRAD_ACCUM  = int(os.environ.get("GRAD_ACCUM", "2"))
EPOCHS      = float(os.environ.get("EPOCHS", "3"))
GRAD_CKPT   = os.environ.get("GRAD_CKPT", "0") == "1"
NUM_WORKERS = int(os.environ.get("NUM_WORKERS", "4"))
MAX_STEPS   = int(os.environ.get("MAX_STEPS", "-1"))
RANK        = int(os.environ.get("RANK", "32"))     # LoRA rank — bump (e.g. 64) to test capacity vs held-out dilution
ALPHA       = int(os.environ.get("ALPHA", "64"))    # keep ALPHA = 2*RANK


def load_jsonl(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


class ChatDataset(Dataset):
    def __init__(self, items, tokenizer, max_len):
        self.items = items
        self.tok = tokenizer
        self.max_len = max_len

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        msgs = self.items[i]["messages"]
        # PRESERVE the completion. Tokenize prompt and full separately; if prompt+completion
        # exceeds max_len, LEFT-trim the prompt (drop oldest history) so the assistant CLOSE
        # always trains. Right-truncation dropped the close on long diverse-search demos.
        prompt_text = self.tok.apply_chat_template(msgs[:-1], tokenize=False, add_generation_prompt=True)
        full_text = self.tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=False)
        prompt_ids = self.tok(prompt_text, return_tensors="pt").input_ids[0]
        full_ids = self.tok(full_text, return_tensors="pt").input_ids[0]
        comp_ids = full_ids[len(prompt_ids):]
        if len(comp_ids) >= self.max_len:
            ids = comp_ids[: self.max_len]; n_prompt = 0
        else:
            keep = self.max_len - len(comp_ids)
            p = prompt_ids[-keep:] if len(prompt_ids) > keep else prompt_ids
            ids = torch.cat([p, comp_ids]); n_prompt = len(p)
        labels = ids.clone()
        labels[:n_prompt] = -100
        return {"input_ids": ids, "labels": labels, "attention_mask": torch.ones_like(ids)}


def collate(batch, pad_id):
    max_len = max(b["input_ids"].size(0) for b in batch)
    def pad_to(x, val):
        return torch.cat([x, torch.full((max_len - x.size(0),), val, dtype=x.dtype)])
    return {
        "input_ids": torch.stack([pad_to(b["input_ids"], pad_id) for b in batch]),
        "labels":    torch.stack([pad_to(b["labels"], -100) for b in batch]),
        "attention_mask": torch.stack([pad_to(b["attention_mask"], 0) for b in batch]),
    }


def main():
    eff = MICRO_BATCH * GRAD_ACCUM
    print(f"=== boot5 SFT (FAST) ===")
    print(f"base={BASE} train={TRAIN} out={OUT}")
    print(f"micro={MICRO_BATCH} accum={GRAD_ACCUM} eff_batch={eff} epochs={EPOCHS} "
          f"grad_ckpt={GRAD_CKPT} max_len={MAX_LEN} workers={NUM_WORKERS} max_steps={MAX_STEPS}")

    bnb = BitsAndBytesConfig(
        load_in_4bit=True, bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True,
    )

    tok = AutoTokenizer.from_pretrained(BASE, trust_remote_code=True)
    tok.padding_side = "right"
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    print("Loading base in 4-bit NF4 (sdpa attn)...")
    # device_map={"":0} + low_cpu_mem_usage => incremental layer-by-layer quantize that FREES
    # the bf16 originals as it goes (peak ~16GB). Without it, bnb holds bf16(61GB)+4bit(16GB)
    # = 77GB transiently, which OOMs an 80GB card at the fp32 norm-upcast in prepare_for_kbit.
    model = AutoModelForCausalLM.from_pretrained(
        BASE, quantization_config=bnb, trust_remote_code=True,
        dtype=torch.bfloat16, attn_implementation="sdpa",
        device_map={"": 0}, low_cpu_mem_usage=True,
    )
    model.config.use_cache = False
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=GRAD_CKPT)

    lora = LoraConfig(
        r=RANK, lora_alpha=ALPHA, lora_dropout=0.05, bias="none",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    train_items = load_jsonl(TRAIN)
    print(f"train_pairs={len(train_items)}")
    train_ds = ChatDataset(train_items, tok, MAX_LEN)

    Path(OUT).mkdir(parents=True, exist_ok=True)
    targs = dict(
        output_dir=OUT,
        per_device_train_batch_size=MICRO_BATCH,
        gradient_accumulation_steps=GRAD_ACCUM,
        learning_rate=2e-5,
        num_train_epochs=EPOCHS,
        max_steps=MAX_STEPS,
        lr_scheduler_type="cosine",
        warmup_ratio=0.05,
        bf16=True,
        weight_decay=0.01,
        max_grad_norm=1.0,
        gradient_checkpointing=GRAD_CKPT,
        eval_strategy="no",
        save_strategy="no" if MAX_STEPS > 0 else "epoch",
        save_total_limit=1,
        logging_steps=2,
        optim="adamw_torch_fused",
        dataloader_num_workers=NUM_WORKERS,
        dataloader_pin_memory=True,
        report_to="none",
        seed=42,
    )
    if GRAD_CKPT:
        targs["gradient_checkpointing_kwargs"] = {"use_reentrant": False}
    args = TrainingArguments(**targs)

    trainer = Trainer(
        model=model, args=args,
        train_dataset=train_ds,
        data_collator=lambda b: collate(b, tok.pad_token_id),
        processing_class=tok,
    )
    trainer.train()
    if MAX_STEPS <= 0:
        trainer.save_model(OUT)
        tok.save_pretrained(OUT)
        print(f"=== boot5 SFT DONE — adapter saved to {OUT} ===")
    else:
        print(f"=== PROBE done ({MAX_STEPS} steps) — no save ===")


if __name__ == "__main__":
    main()
