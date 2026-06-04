#!/usr/bin/env bash
# run-autopenbench.sh — Step 9.5 STUB (dir_1780595412819)
#
# Run AutoPenBench against our trained model in our multi-agent harness
# and compare to base qwen3:32b. Outputs a markdown report.
#
# Implementation deferred. AutoPenBench (arXiv 2410.03225) ships 33 tasks
# as Docker containers — each is a vulnerable system + a flag file. The
# eval harness:
#   1. spins up each task's container
#   2. configures our agent's get_engagement_state to see the target
#   3. runs start_engagement_run with a max_iter budget
#   4. checks if the flag file was read
#   5. records sub-task milestones hit per AutoPenBench's scoring rubric
#   6. aggregates pass-rate across the 33 tasks
#
# Compare to baseline = same harness, same tasks, but OFFENSE_MODEL_NAME
# set to qwen3:32b (no adapter). The gain is the fine-tune's contribution.
#
# Implement AFTER we have a trained adapter loaded via deploy/load.sh.

echo "[run-autopenbench] STUB — not yet implemented." >&2
echo "[run-autopenbench] See OFFENSE-FINETUNE-DESIGN.md §6." >&2
echo "[run-autopenbench] Requires a trained adapter (run train.py first) AND" >&2
echo "[run-autopenbench] AutoPenBench task containers (clone github.com/lucagioacchini/auto-pen-bench)." >&2
exit 2
