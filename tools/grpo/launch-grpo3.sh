#!/bin/bash
# GRPO round3 (dir_1781203380739) — per-step credit assignment.
# Only diffs vs round2: --credit stepwise --gamma 0.9 (concentrate credit on the
# close), --group-size 64 (one pooled group = dense per-step advantages, no dead
# zero-advantage chunks), --epochs 2 (reinforce the now-upweighted close).
# SFT base = pilot-v1 (the best model). beta/lr/max-len unchanged from round2.
cd /root
source /root/sftvenv/bin/activate
export LD_LIBRARY_PATH=/usr/local/cuda-13.0/targets/x86_64-linux/lib:/root/sftvenv/lib/python3.12/site-packages/nvidia/cu13/lib:${LD_LIBRARY_PATH:-}
exec python3 /root/train_grpo.py \
  --base /root/coder-bf16 \
  --sft-adapter /root/sft-out/pilot-v1 \
  --trajectories /root/round2.jsonl \
  --group-size 64 \
  --output /root/grpo-out/round3-pilot \
  --beta 0.2 \
  --lr 1e-6 \
  --epochs 2 \
  --micro-batch 1 \
  --grad-accum 4 \
  --max-len 2048 \
  --credit stepwise \
  --gamma 0.9
