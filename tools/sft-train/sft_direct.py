"""Self-contained SFT trainer for Qwen3-Coder-30B with QLoRA.

No llamafactory dependency — just transformers + peft + bitsandbytes.
Mirrors the original Sprint 3 SFT config:
  - QLoRA: 4-bit NF4 base, LoRA rank 32 alpha 64 on attention
  - lr 2e-5, cosine schedule, 3 epochs
  - bf16, gradient checkpointing
  - eval every 50 steps

Usage:
  python sft_direct.py
"""
import json
import torch
from pathlib import Path
from torch.utils.data import Dataset
from transformers import (
    AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig,
    Trainer, TrainingArguments, DataCollatorForLanguageModeling,
)
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

BASE = "/root/coder-bf16"
TRAIN = "/root/sft-train.jsonl"
EVAL = "/root/sft-eval.jsonl"
OUT = "/root/sft-out/qwen3coder-sft"
MAX_LEN = 4096


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
        text = self.tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=False)
        enc = self.tok(text, max_length=self.max_len, truncation=True, return_tensors="pt", padding=False)
        ids = enc.input_ids[0]
        # Mask everything up to the last assistant turn so we only train on the response.
        prompt_msgs = msgs[:-1]
        prompt_text = self.tok.apply_chat_template(prompt_msgs, tokenize=False, add_generation_prompt=True)
        prompt_ids = self.tok(prompt_text, max_length=self.max_len, truncation=True, return_tensors="pt").input_ids[0]
        labels = ids.clone()
        labels[: len(prompt_ids)] = -100
        return {"input_ids": ids, "labels": labels, "attention_mask": enc.attention_mask[0]}


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
    print("=== SFT (Sprint 3 redo) on H200 ===")
    print(f"base={BASE}  train={TRAIN}  eval={EVAL}  out={OUT}")

    bnb = BitsAndBytesConfig(
        load_in_4bit=True, bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True,
    )

    tok = AutoTokenizer.from_pretrained(BASE, trust_remote_code=True)
    tok.padding_side = "right"
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    print("Loading base in 4-bit NF4...")
    model = AutoModelForCausalLM.from_pretrained(
        BASE, quantization_config=bnb, trust_remote_code=True, torch_dtype=torch.bfloat16,
    )
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)

    lora = LoraConfig(
        r=32, lora_alpha=64, lora_dropout=0.05, bias="none",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    train_items = load_jsonl(TRAIN)
    eval_items = load_jsonl(EVAL)
    print(f"train={len(train_items)}  eval={len(eval_items)}")

    train_ds = ChatDataset(train_items, tok, MAX_LEN)
    eval_ds = ChatDataset(eval_items, tok, MAX_LEN)

    Path(OUT).mkdir(parents=True, exist_ok=True)
    args = TrainingArguments(
        output_dir=OUT,
        per_device_train_batch_size=1,
        per_device_eval_batch_size=2,
        gradient_accumulation_steps=4,
        learning_rate=2e-5,
        num_train_epochs=3,
        lr_scheduler_type="cosine",
        warmup_ratio=0.05,
        bf16=True,
        weight_decay=0.01,
        max_grad_norm=1.0,
        gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        eval_strategy="steps",
        eval_steps=50,
        save_strategy="epoch",
        save_total_limit=2,
        logging_steps=5,
        optim="adamw_torch_fused",
        report_to="none",
        seed=42,
    )

    trainer = Trainer(
        model=model, args=args,
        train_dataset=train_ds, eval_dataset=eval_ds,
        data_collator=lambda b: collate(b, tok.pad_token_id),
        processing_class=tok,
    )
    trainer.train()
    trainer.save_model(OUT)
    tok.save_pretrained(OUT)
    print(f"=== SFT DONE — adapter saved to {OUT} ===")


if __name__ == "__main__":
    main()
