"""Verifiable reward for SOC pentest trajectories.

Input shape: a trajectory is a list of step dicts, each with:
  {
    "state":   <engagement state at decision time>,
    "command": <bash command the model proposed>,
    "intent":  <intent_class from the model's JSON output>,
    "outcome": {
      "exit_code": int,
      "output":    str,
      "duration_s": float,
    },
    "engagement_phase": <"recon"|"enum"|"exploit"|"post_exploit"|"done">,
  }

Output: per-step rewards array + scalar total return.

Reward components (signed contributions, summed):
- flag_capture  : +1.0  if OZZULAB{...} pattern in any step's output  (terminal)
- phase_advance : +0.2  whenever engagement_phase progresses one rank
- new_artifact  : +0.1  per new (host:port) or new URL discovered in this step's output
                        relative to all PRIOR steps in the trajectory
- redundancy    : -0.1  if this step's intent_class is the same as the previous
                        TWO steps (3rd-in-a-row penalty — discourages the gobuster loop)
- malformed     : -0.2  if the model's command failed to parse or shell-quoted improperly
                        (we let the harness lint catch the obvious cases; this is a backstop)

Episode-end shaping (reconciled 2026-06-11, dir_1781203380739):
- The flag is a SINGLE terminal reward on the capturing step. It is NOT smeared across
  prior steps. The old version added +W_FLAG to every prior step, which made the TOTAL
  return scale with trajectory LENGTH — a 12-iter win out-scored a 3-iter win, i.e. it
  paid the model to dawdle before grabbing the flag. GRPO normalizes the trajectory-level
  return within the group, so per-step credit smearing is unnecessary and was harmful.
- W_STEP_COST per step makes a short win out-score a long win.
- W_FLAG dominates any achievable sum of shaping signals, so info-leak recon can never
  out-score an actual flag capture (the inversion that lived in replay-and-verify.js).
"""
from __future__ import annotations
import os
import re
from dataclasses import dataclass
from typing import Iterable

# dir_1781203380739: CAPTURE_ONLY=1 strips the positive exploitation shaping so GRPO chases
# ONLY the flag. Diagnoses "GRPO improved exploit not capture" — is it the reward distracting
# it (fixable) or the 30B's ceiling on the close (capacity)?
CAPTURE_ONLY = os.environ.get("CAPTURE_ONLY") == "1"

PHASE_RANK = {"recon": 0, "enum": 1, "exploit": 2, "post_exploit": 3, "done": 4}
FLAG_RE = re.compile(r"OZZULAB\{[^}]+\}")
HOSTPORT_RE = re.compile(r"\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)\b")
URL_RE = re.compile(r"https?://[A-Za-z0-9._:/?&=%~+,!@$*-]+", re.IGNORECASE)

# Reconciled dir_1781203380739. Invariants enforced (final values tuned empirically
# at GRPO time): (1) flag dominates any achievable shaping sum; (2) shorter win > longer win.
W_FLAG = 10.0          # terminal, dominant. Max shaping ~ (4 phase advances * 0.3) +
                       # (12 steps * 0.5 artifact cap) ~= 7.2 < 10, so flag always wins.
# capture-only mode zeros the positive shaping so exploit-without-capture gets NO credit and
# can't compete with the flag (the round-1/2 failure mode: exploit climbed, capture didn't).
W_PHASE_ADVANCE = 0.0 if CAPTURE_ONLY else 0.3
W_NEW_ARTIFACT = 0.0 if CAPTURE_ONLY else 0.1
W_REDUNDANCY = -0.3
W_MALFORMED = -0.5
W_STEP_COST = -0.2     # per-step time penalty -> 3-iter win out-scores 12-iter win

# Cap on new-artifact bonus per step so a single nmap of /24 doesn't dominate.
MAX_NEW_ARTIFACTS_PER_STEP = 5


@dataclass
class StepReward:
    step_index: int
    flag: float = 0.0
    phase_advance: float = 0.0
    new_artifact: float = 0.0
    redundancy: float = 0.0
    malformed: float = 0.0
    step_cost: float = 0.0

    @property
    def total(self) -> float:
        return (self.flag + self.phase_advance + self.new_artifact
                + self.redundancy + self.malformed + self.step_cost)


def _extract_artifacts(text: str) -> set[str]:
    if not text:
        return set()
    found: set[str] = set()
    for m in HOSTPORT_RE.finditer(text):
        found.add(f"hp:{m.group(1)}:{m.group(2)}")
    for m in URL_RE.finditer(text):
        # Normalize trailing punctuation.
        url = m.group(0).rstrip(".,);")
        found.add(f"url:{url}")
    return found


def _is_malformed(command: str) -> bool:
    if not command or not command.strip():
        return True
    if command.count('"') % 2 != 0:
        return True
    if command.count("'") % 2 != 0:
        return True
    return False


def score_trajectory(trajectory: list[dict]) -> tuple[list[StepReward], float]:
    """Score a trajectory; return (per-step rewards, total return).

    The total return assigns credit to PRIOR steps if a flag is captured,
    so the policy gradient sees the full path that worked, not just the
    terminal step.
    """
    n = len(trajectory)
    rewards = [StepReward(step_index=i) for i in range(n)]
    seen_artifacts: set[str] = set()
    prev_phase = None
    flag_step: int | None = None

    for i, step in enumerate(trajectory):
        outcome = step.get("outcome") or {}
        output = outcome.get("output", "") or ""

        if flag_step is None and FLAG_RE.search(output):
            flag_step = i
            rewards[i].flag = W_FLAG

        cur_phase = step.get("engagement_phase")
        if prev_phase is not None and cur_phase in PHASE_RANK and prev_phase in PHASE_RANK:
            if PHASE_RANK[cur_phase] > PHASE_RANK[prev_phase]:
                rewards[i].phase_advance = W_PHASE_ADVANCE
        prev_phase = cur_phase if cur_phase in PHASE_RANK else prev_phase

        new = _extract_artifacts(output) - seen_artifacts
        seen_artifacts |= new
        rewards[i].new_artifact = W_NEW_ARTIFACT * min(len(new), MAX_NEW_ARTIFACTS_PER_STEP)

        intent = step.get("intent")
        if i >= 2 and intent and intent == trajectory[i-1].get("intent") == trajectory[i-2].get("intent"):
            rewards[i].redundancy = W_REDUNDANCY

        if _is_malformed(step.get("command", "")):
            rewards[i].malformed = W_MALFORMED

        rewards[i].step_cost = W_STEP_COST

    # NOTE (dir_1781203380739): the old retroactive "+W_FLAG to every prior step" loop was
    # removed here — it made the total return scale with trajectory LENGTH (rewarded dawdling).
    # The flag is a single terminal reward on flag_step; GRPO's group-relative advantage over
    # the trajectory-level return handles credit assignment to the path that worked.

    total = sum(r.total for r in rewards)
    return rewards, total


def grpo_advantages(returns: Iterable[float], epsilon: float = 1e-8) -> list[float]:
    """Group-relative advantage normalization used by GRPO.

    Each rollout's advantage = (return - group_mean) / (group_std + eps).
    Pass in the K returns from one group (same prompt, K samples).
    """
    rs = list(returns)
    if not rs:
        return []
    mean = sum(rs) / len(rs)
    var = sum((r - mean) ** 2 for r in rs) / len(rs)
    std = var ** 0.5
    return [(r - mean) / (std + epsilon) for r in rs]


# ---------------------------------------------------------------------------
# Per-step credit assignment (dir_1781203380739).
#
# WHY THIS EXISTS: rounds 0-2 used ONE trajectory-level advantage applied
# uniformly to every step. Exploitation reliably improved (v1 6->8) but CAPTURE
# stayed stuck (~1-2/8) and held-out v2 never transferred. Structural cause:
# wins and losses SHARE the recon+exploit steps (abundant — every trajectory has
# them), while the CLOSE (the flag grab + the exfil that reaches it) appears ONLY
# in the rare captures. With one advantage smeared evenly, the gradient mass lands
# on the shared moves the model already does, not on the differentiating close.
#
# THE FIX (standard RL credit assignment we had simplified away): per-step
# DISCOUNTED return-to-go. With gamma<1 the terminal flag reward decays into
# earlier steps, so the steps NEAR the flag carry the most credit and far-upstream
# recon carries least. Then group-normalize over the POOLED per-step returns so a
# winner's close towers over the group while losers go negative. Trajectory-level
# is the gamma->1 + per-trajectory-baseline special case; keep it for A/B.
# ---------------------------------------------------------------------------

def per_step_rewards(trajectory: list[dict]) -> list[float]:
    """Per-step scalar reward r_t (StepReward.total) for one trajectory."""
    rewards, _ = score_trajectory(trajectory)
    return [r.total for r in rewards]


def discounted_returns_to_go(step_rewards: list[float], gamma: float) -> list[float]:
    """G_t = sum_{k>=t} gamma^(k-t) * r_k  (Monte-Carlo discounted return-to-go).

    gamma<1 concentrates credit on the steps closest to where reward landed (the
    close); gamma=1 reduces to "every step sees the full remaining return".
    """
    G = [0.0] * len(step_rewards)
    running = 0.0
    for t in range(len(step_rewards) - 1, -1, -1):
        running = step_rewards[t] + gamma * running
        G[t] = running
    return G


def grpo_step_advantages(group_step_returns: list[list[float]],
                         epsilon: float = 1e-8) -> list[list[float]]:
    """Group-relative advantage at the STEP level.

    group_step_returns: per-trajectory lists of per-step returns-to-go G_t for the
    K trajectories of ONE group. Pool every G_t across the group, normalize against
    that pool. A winning trajectory's close steps (G_t ~ W_FLAG) sit far above the
    pooled mean -> large +adv; loser steps (G_t < 0 from step costs) -> -adv. This
    replaces the single per-trajectory advantage that was applied to every step.
    """
    flat = [g for traj in group_step_returns for g in traj]
    if not flat:
        return [[0.0] * len(traj) for traj in group_step_returns]
    mean = sum(flat) / len(flat)
    var = sum((x - mean) ** 2 for x in flat) / len(flat)
    std = var ** 0.5
    return [[(g - mean) / (std + epsilon) for g in traj] for traj in group_step_returns]
