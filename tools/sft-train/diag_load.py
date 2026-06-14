"""40s diagnostic: is the 4-bit quant actually applying, or is the OOM in PEFT prepare?"""
import torch
from transformers import AutoModelForCausalLM, BitsAndBytesConfig

bnb = BitsAndBytesConfig(
    load_in_4bit=True, bnb_4bit_quant_type="nf4",
    bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True,
)
m = AutoModelForCausalLM.from_pretrained(
    "/root/coder-bf16", quantization_config=bnb, dtype=torch.bfloat16,
    device_map={"": 0}, low_cpu_mem_usage=True, trust_remote_code=True,
)
print("=== AFTER LOAD (before any prepare) ===")
print(f"ALLOC_GB = {torch.cuda.memory_allocated()/1e9:.1f}")
print(f"RESERVED_GB = {torch.cuda.memory_reserved()/1e9:.1f}")
# class + dtype of a base attention weight
for n, p in m.named_parameters():
    if "q_proj.weight" in n:
        print(f"SAMPLE q_proj: cls={type(p).__name__} dtype={p.dtype} numel={p.numel()} bytes={p.numel()*p.element_size()}")
        break
from collections import Counter
dt = Counter(str(p.dtype) for p in m.parameters())
print(f"PARAM_DTYPE_COUNTS = {dict(dt)}")
print("DIAG_DONE")
