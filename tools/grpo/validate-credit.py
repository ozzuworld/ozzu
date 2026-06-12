#!/usr/bin/env python3
"""Local GATE for the per-step credit-assignment fix (dir_1781203380739).

CPU-only. Loads a rollout JSONL (one GRPO group), computes per-step advantages
both ways (stepwise discounted return-to-go vs old trajectory-level), and reports
whether the CLOSE steps now outrank the shared early steps. If they don't, the fix
is a no-op and there is no point spending GPU on a round.

Usage: python3 validate-credit.py /home/gcp/ozzu/private/grpo-trajectories/round2.jsonl [gamma]
"""
import json
import sys
from statistics import mean

from reward import (per_step_rewards, discounted_returns_to_go,
                    grpo_step_advantages, grpo_advantages, FLAG_RE)


def flag_step_index(traj):
    for i, s in enumerate(traj):
        out = (s.get("outcome") or {}).get("output", "") or ""
        if FLAG_RE.search(out):
            return i
    return None


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else \
        "/home/gcp/ozzu/private/grpo-trajectories/round2.jsonl"
    gamma = float(sys.argv[2]) if len(sys.argv) > 2 else 0.9

    trajs = [json.loads(l) for l in open(path) if l.strip()]
    steps_of = [t["trajectory"] for t in trajs]
    wins = [i for i, t in enumerate(trajs) if t.get("flag_captured")]
    print(f"{path}: {len(trajs)} trajectories, {len(wins)} wins, gamma={gamma}\n")

    # ---- stepwise (the fix) ----
    step_rewards = [per_step_rewards(s) for s in steps_of]
    group_returns = [discounted_returns_to_go(sr, gamma) for sr in step_rewards]
    step_advs = grpo_step_advantages(group_returns)

    # ---- trajectory (old) ----
    totals = [sum(sr) for sr in step_rewards]
    tadv = grpo_advantages(totals)

    # Buckets for the ordering test.
    close_adv, winner_early_adv, loser_adv = [], [], []
    for i, traj in enumerate(steps_of):
        sa = step_advs[i]
        if i in wins:
            fi = flag_step_index(traj)
            if fi is None:
                fi = len(traj) - 1
            close_adv.append(sa[fi])
            winner_early_adv += sa[:max(1, min(3, fi))]   # first up-to-3 recon/enum steps
        else:
            loser_adv += sa

    print("=== STEPWISE (per-step discounted return-to-go) — the fix ===")
    print(f"  close steps (flag grab)      mean adv = {mean(close_adv):+.3f}   (n={len(close_adv)})")
    print(f"  winners' early recon steps   mean adv = {mean(winner_early_adv):+.3f}   (n={len(winner_early_adv)})")
    print(f"  loser steps (no capture)     mean adv = {mean(loser_adv):+.3f}   (n={len(loser_adv)})")
    gap = mean(close_adv) - mean(winner_early_adv)
    print(f"  >> close-vs-shared gap = {gap:+.3f}")

    print("\n=== TRAJECTORY (old: one advantage per traj, smeared on every step) ===")
    win_tadv = [tadv[i] for i in wins]
    lose_tadv = [tadv[i] for i in range(len(trajs)) if i not in wins]
    print(f"  every winner step          adv = {mean(win_tadv):+.3f}  (close == early == this)")
    print(f"  every loser step           adv = {mean(lose_tadv):+.3f}")
    print("  (close and early are IDENTICAL here — that is the bug the fix removes)")

    # One concrete winner, step by step.
    if wins:
        wi = min(wins, key=lambda i: len(steps_of[i]))  # shortest win = cleanest close
        traj, sa = steps_of[wi], step_advs[wi]
        fi = flag_step_index(traj)
        print(f"\n=== concrete winner #{wi} ({len(traj)} steps, flag at step {fi}) ===")
        print("  step  phase         intent            G_t      adv(step)   adv(traj)")
        for j, s in enumerate(traj):
            mark = " <-- CLOSE" if j == fi else ""
            print(f"  {j:>3}  {s.get('engagement_phase',''):<12} {str(s.get('intent','')):<16} "
                  f"{group_returns[wi][j]:>7.2f}  {sa[j]:>+8.3f}   {tadv[wi]:>+7.3f}{mark}")

    # Verdict.
    print("\n=== GATE ===")
    ok = mean(close_adv) > mean(winner_early_adv) > mean(loser_adv) and mean(loser_adv) < 0
    print("PASS — close > shared > loser, losers negative. Spend GPU." if ok
          else "FAIL — ordering not achieved; do NOT spend GPU, rethink.")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
