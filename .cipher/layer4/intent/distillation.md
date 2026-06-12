# Ozzu Distillation — The Master Plan

**Read every session before touching anything related to Sprint 2c, Sprint 3, Sprint 4, OzzuLab runs, the offense model, or any Opus-as-teacher work. This file is the source of truth. TaskList titles go stale — this file does not.**

Last reviewed: 2026-06-11 (Fable takeover — rewritten after the lab-verify sweep + v2 end-to-end play-harvest exposed that the prior plan was chasing winners that don't exist).

---

## THE GOAL

Build Ozzu — a self-hosted SOC pentest agent that approaches Claude 4.7-class autonomous behavior on OzzuLab.

Method: **DeepSeek-R1 distillation recipe applied to pentest** — Opus teacher → SFT a strong open base → GRPO RL with verifiable rewards.

**Success criterion (TIGHTENED 2026-06-11): the distilled model autonomously captures an `OZZULAB{}` flag on a lab variant it was NOT trained on, in a Run #N eval with the harness fully autonomous (no human intervention).**

Why "not trained on": a model trained on v1 will capture v1's flag by memorizing one exploit chain — that is a lookup table, not pentest skill. Capturing a *held-out* variant is the only result that proves the model learned to pentest. **"Captures a variant it WAS trained on" is explicitly NOT success — it is the failure that looks like success.** A v1-trained model passing v1 is allowed only as a *plumbing checkpoint*, and must be labeled "plumbing, not capability" wherever it is reported.

---

## THE RECIPE (DeepSeek-R1 actual, not vibes)

1. **Pick a strong generic base** — Qwen3-Coder-30B-A3B-Instruct (BF16 train / FP8 infer baselines). LOCKED — no base change without explicit user approval.
2. **A verifiable reward must exist** — `OZZULAB{...}` regex in lab output is deterministic. WE HAVE THIS.
3. **Diversity lives in the PROBLEM SET, not the sampler.** DeepSeek had ~800K *distinct* problems, not one problem 800K times. Our single biggest mistake: we ran ONE lab (v1) ~100× and mistook the sampler's surface variation for diversity. It is not. **Floor: ≥10 distinct vulnerability CLASSES, ~3 instances each (~30 scenarios), before any capability claim. <5 classes = guaranteed memorization.**
4. **Generate teacher demonstrations** — two valid modes:
   - (a) **per-state rejection sampling** (N candidates per frozen state, keep lab-verified winners). Produces GRPO-shaped data.
   - (b) **end-to-end play** (Opus plays a whole engagement; keep the trajectory if it captures the flag). Produces SFT cold-start data. This is `play-engagement.js`.
5. **Lab-verify by ACTUAL EXECUTION** against a fresh lab — not by Opus self-opinion. Score by the ONE reconciled reward (see SCORING).
6. **SFT on lab-verified / flag-capturing demonstrations across the DIVERSE problem set.** Diversity >> depth: ~15–30 trajectories per scenario is plenty; past that you are adding near-duplicates.
7. **GRPO on top:** K=8 candidates per state, each lab-verified, advantage = (return − group_mean)/group_std, gradient toward winners. **Only run GRPO on scenarios the SFT model wins 20–80% of the time** — scenarios it always wins or always loses produce zero within-group variance = zero gradient = wasted rollouts. Hundreds-to-thousands of states.
8. **Eval on a HELD-OUT variant.** Flag captured on data it never trained on = the goal is met.

---

## RECONCILED SCORING (ONE canonical reward — fixes two bugs found 2026-06-11)

There were TWO reward functions that disagreed on scale and on what "artifact" means: `tools/oracle/replay-and-verify.js` (data/diagnosis) and `tools/grpo/reward.py` (RL). Collapse to ONE function used for BOTH data selection and GRPO. Requirements:

- **Flag dominates.** The flag reward must exceed any achievable sum of intermediate signals. (Old `replay-and-verify.js` bug: reading `/etc/passwd` scored +11, beating the flag's +10. Cap artifacts strictly below flag.)
- **Step discount: a 3-iter flag beats a 12-iter flag.** (Old `reward.py` bug: it added +flag retroactively to every prior step, so LONGER wins scored HIGHER — it paid the model to dawdle. Use a single terminal flag reward with γ-discount, or normalize return by length.)
- New exploitation artifact (passwd / source / cred): small positive, capped.
- Redundancy (same intent_class as previous step): negative.
- Error / out-of-scope (ROE violation): negative.

Filter SFT data by the `flag_captured` boolean (clean); use the scalar score only for GRPO advantage, where the two bugs above MUST be fixed first.

---

## WHERE WE ACTUALLY ARE (2026-06-11, corrected — this replaces the old Phase A–F)

The May plan ("build replay-and-verify → sweep the 866 candidates → expect 250–450 winners → re-SFT") is **DONE and DISPROVEN**:

- `replay-and-verify.js` — BUILT, smoke-passed (LFI→passwd +11, flag path +10/flag_captured, out-of-scope −7).
- Swept all 866 Sprint 2c candidates → **0 flag captures, 3 winners (0.3%)**, not 250–450. The 3 winners all just read `view.php`'s own source via LFI and stopped short of the flag.
- **Diagnosis: TWO bugs, not one.**
  1. **Single-step prompting** ("what's the next command?" from frozen states) → Opus hedges to recon → 0 flags. **FIXED** via `play-engagement.js` (end-to-end play; ~98% flag capture across 134 engagements harvested today).
  2. **Single-vuln-class data = memorization.** The new play-harvest is still 100% OzzuLab v1 LFI — one exploit chain, ~100 near-duplicates. This is the DEEPER bug and is **NOT yet fixed.** SFT on it produces a model that memorizes nmap→LFI→grep and fails any held-out variant.

**The data-SHAPE bug is fixed. The data-DIVERSITY bug is not. Do not re-SFT-and-declare-victory on v1-only data.**

---

## THE CORRECTED PLAN (phases)

### Phase 0 — Reconcile the reward (free, no compute)
Collapse `replay-and-verify.js` scoring and `grpo/reward.py` into one function; fix the inversion + the length bug above. Add model+token logging to `play-engagement.js` so every future harvest records which model answered and what it cost (the gap that made the "Fable vs Opus" question unanswerable from files).

### Phase 1 — PILOT: the cheapest experiment that tests the real goal (1 SFT cycle)
- Train SFT on the **v1-only** play-harvest we already have (no new harvest, no quota).
- Eval on **v1 AND held-out v2.**
- **The v1→v2 gap is the entire decision.** v2 transfers even partially → the approach generalizes, widen aggressively. v2 = 0 → memorization confirmed, diversity is mandatory before any more SFT.
- This costs Path-A money (one SFT cycle) and yields Path-B information (generalization signal). A v1-only eval is a guaranteed pass and is forbidden as a success claim.

### Phase 2 — Widen to the diversity floor (gated on Phase 1)
- Source diverse vulnerable containers from **Vulhub** (`github.com/vulhub/vulhub` — dozens of CVE-class docker-compose envs: RCE, SSRF, SQLi, deserialization, …) and wrap each with a one-line re-flagging overlay that drops an `OZZULAB{...}` sentinel at the exploitation payoff. dev-01 already runs the labs as docker-compose.
- Target ≥10 vuln classes × ~3 instances. Harvest end-to-end wins per scenario (budget the Opus quota — see COST).
- Re-SFT on the diverse set. Eval on a held-out class.

### Phase 3 — Build the GRPO data generator (currently missing)
`play-engagement.js` records ONE demonstrated action per state. GRPO needs K candidates per state with K rewards. There is no generator for that yet — it is a structural blocker between SFT and GRPO, not just an "open question." Build a multi-sample-per-state harness.

### Phase 4 — GRPO at proper scale
K=8 (bump to 12–16 only where K=8 gives all-win or all-lose groups). Only on 20–80%-win-rate scenarios. LR 1e-7, β (KL anchor) 0.2, 3 epochs, micro-batch 1, grad-accum 8. **Rsync the adapter the instant it writes.**

### Phase 5 — Run #N on a HELD-OUT variant
Record iter-to-flag, command/intent diversity, flag captured y/n. Compare to Run #14/#15. Flag on held-out = done.

---

## COST REALITY (corrected — "free at quota" was a lie that burned a session)

- Teacher harvest is **Opus-tier Max-plan OAuth, NOT free.** It is quota-metered. **~50 lab engagements ≈ 70% of a 5-hour x20 session** (measured 2026-06-11).
- The free steps are the SSH-only ones: `replay-and-verify.js` and the lab-verify sweep. Lean on those for filtering instead of re-harvesting.
- Budget every harvest. Diversity (fewer, varied scenarios) costs LESS quota than volume (100 near-duplicates) AND yields better data — the cost fix and the data fix are the same fix.
- Self-hosted offense model (Qwen on the H200, `OFFENSE_MODEL_URL`) costs $/hr, not Max quota.

---

## ANTI-DRIFT RULES (each cost trust on 2026-06-11)

- **R1 — Backup adapters the instant training writes.** Rented droplets get destroyed. Lost the Sprint 3 adapter this way. rsync to GCP VM, verify size locally, before continuing.
- **R2 — Bridge env change requires `docker compose up -d bridge` (not `restart`) + `docker exec bridge env | grep` verification.** `restart` does not re-read `.env`.
- **R3 — `TaskStop` the old monitor before relaunching the process it watches.** Else ghost events from the dead run.
- **R4 — Never claim a step done without artifact proof.** Path + size, line count, smoke output, loss, eval metric. "I think it worked" is banned.
- **R5 — When asked "is X true," check live state, not memory.** Query the DB, read the file, hit the endpoint, read the recorded `model` field.
- **R6 — Targeted retrieval, honestly.** Commit to reading every line, or say "I'll grep for the anchor." Never pass a partial read as a full read.
- **R7 — Pre-harvest / pre-train gate (NEW): name the held-out test first.** Before spending ANY quota or compute, write down the held-out scenario the result must pass that is NOT in the training set, and the memorization-null ("if it only memorizes, it passes [train] and fails [held-out]"). Can't name one → STOP, you are memorizing. Count distinct vuln *classes* (not flag paths) — <5 → STOP unless explicitly stamped "plumbing test."
- **R8 — The forcing function is the harness, not willpower (NEW).** The recurring failure ("execute the visible step over reasoning whether it's correct") is a gradient problem — launching compute shows progress, designing the experiment shows nothing until later. Fix structurally: a `pre-harvest-gate.sh` that refuses to start a harvest/train run unless `EXPERIMENT.md` exists with R7's fields filled. Wire it into `play-parallel.sh` and the SFT entry point. A precondition can't be skipped under pressure; a habit can.
- **R9 — Test the goal, not the plumbing (NEW 2026-06-11 PM).** The trap: a plumbing issue surfaces (JSON format crash, harvester bug, excerpt truncation), you fix it, and *feel* like you made progress — but it didn't move the model toward a captured flag. Before fixing any infrastructure, ask: **does this block the path to capture?** If not, bank it and move on. Phase 2 burned hours polishing diversity + format plumbing and produced a model WORSE than the pilot. Only the capability lever (GRPO) moves the goal; everything else is in service of running it, not a substitute for it.

## LOCKED DECISIONS (do not relitigate without explicit user request)

- Base model: **Qwen3-Coder-30B-A3B-Instruct** (BF16 train / FP8 infer).
- Teacher: **Opus via Max-plan OAuth** (recorded model `claude-opus-4-6`; the "4.7" label was aspirational). **NOT free — quota-metered.**
- Labs: **OzzuLab v1 (LFI) + v2 (cmd-inject)** — clean payloads, these are the GRPO classes. **Vulhub diversity widening: TESTED and PARKED** — diversity-SFT did NOT lift generalization (see PHASE 2 VERDICT). Do not reopen without a new reason.
- SFT method: **QLoRA rank 32, alpha 64, attention-only** (MoE expert MLPs untouched).
- RL method: **GRPO with the ONE reconciled lab-verify reward.**
- Success criterion: **`OZZULAB{}` captured autonomously on a HELD-OUT variant.**

## CURRENT STATE (as of 2026-06-11 late — post Phase 2b)

| Step | Status | Result |
|---|---|---|
| Phase 0 (reward reconcile, trainer rescue, logging) | ✅ done + committed | reward.py dawdle+inversion fixed (proven); sft_direct.py rescued into repo |
| Phase 1 PILOT v1 (SFT on 67 v1 LFI wins) | ✅ done | **BEST MODEL.** Held-out v2 (cmd-inject, never trained): **50% exploit / 0% capture** — real RCE-on-novel-class skill transfer. v1: 2/8 capture, 6/8 exploit. Adapter: `private/sft-adapters/pilot-v1-2026-06-11`. |
| Phase 1b pilot-v2 (retrain on replay-rebuilt full-ctx data) | ✅ done — REGRESSED | worse than pilot-v1. Replay added history-inconsistency noise. Lesson: harvest fresh, never retrofit context via replay. |
| Phase 2b DIVERSITY (6 vulhub classes + v1 = 7-class SFT) | ✅ done — **NEGATIVE RESULT** | diverse model WORSE than pilot everywhere, captured 0 flags. See PHASE 2 VERDICT. |
| **GRPO on the pilot** | ⏳ **THE NEXT STEP** | the capture lever — still untried |

## PHASE 2 VERDICT — diversity is NOT the lever (settled, clean data)

7-class diverse model vs single-class pilot, hardened harness (format crashes removed):
- **Held-out v2: 50% exploit — IDENTICAL to the pilot.** Diversity did not lift generalization.
- **v1: 67% exploit / 0 capture vs pilot 75% / 2 captures.** Diversity COST sharpness (generalist tax).
- **weblogic (a TRAINED class): 0/4, 2/4 crashed** — the heavy XML deserialization payload breaks the `{reasoning,command}`-as-JSON output; the model can't reliably emit complex exploits through this protocol.
- **Diverse model captured 0 flags total; pilot captured 2.**

Banked conclusions (do NOT re-test):
1. **Diversity-SFT ≠ generalization lever.** More vuln classes = more technique coverage, NOT the planning/capture that's missing. The bottleneck is the GAME (plan → read feedback → commit → exfiltrate), not the MOVES.
2. **The output FORMAT is fragile for heavy payloads.** Protocol redesign (command as raw text, not a JSON-escaped string) is needed BEFORE training complex-payload classes — but NOT before GRPO on v1/v2 (clean payloads).
3. **The pilot is our best model** and the right base for GRPO. Diversity work + diverse model are PARKED.

## FILE LOCATIONS

- Master plan (this file): `/home/gcp/ozzu/.cipher/layer4/intent/distillation.md`
- Handoff (Opus→Fable, historical): `/home/gcp/ozzu/.cipher/layer4/intent/HANDOFF-FOR-FABLE.md`
- Trajectory datasets: `/home/gcp/ozzu/private/oracle-trajectories/`
- SFT adapters (durable): `/home/gcp/ozzu/private/sft-adapters/<sprint>-<date>/`
- GRPO adapters (durable): `/home/gcp/ozzu/private/grpo-adapters/round-<n>-<date>/`
- Oracle pipeline: `/home/gcp/ozzu/tools/oracle/` (`oracle.js`, `play-engagement.js`, `play-parallel.sh`, `replay-and-verify.js`, `grade-candidates.js`, `format-sft.js`)
- SFT training: `/home/gcp/ozzu/tools/sft-train/`
- GRPO training: `/home/gcp/ozzu/tools/grpo/` (`reward.py` ← reconcile with `replay-and-verify.js`)
- Lab orchestrator: `/home/gcp/ozzu/tools/parallel-runner/`

## NEXT CONCRETE ACTION — GRPO on the pilot (the capture lever)

Everything points here. SFT taught the moves (exploitation transfers — ~50% on a held-out class). The gap is the GAME: **0 captures — the model gets RCE but can't turn it into an exfiltrated flag.** GRPO is the only lever that targets that, because it rewards the OUTCOME instead of imitating steps. We have circled this for an entire session without running it. Run it.

1. **Base = the PILOT adapter** (`/root/sft-out/pilot-v1`, durable copy `private/sft-adapters/pilot-v1-2026-06-11`). NOT the diverse model.
2. **Classes = v1 (LFI) + v2 (cmd-inject) only.** Clean payloads; the JSON output format works. No vulhub/heavy-payload classes until the protocol is redesigned.
3. **BUILD THE MISSING PIECE FIRST: a GRPO data generator.** GRPO needs K candidate actions per state, each lab-verified. `play-engagement.js` produces ONE action per state — it cannot feed GRPO. This generator does not exist yet and is the real blocker between SFT and GRPO.
4. **Reward = the reconciled `reward.py`** (flag dominates, step-discount, no dawdle — already fixed and proven). Score by lab-verify execution.
5. **GRPO: K=8, only on states where the pilot wins 20–80%** (always-win/always-lose = zero within-group variance = wasted rollouts). LR 1e-7, β (KL) 0.2. Rsync adapter the instant it writes (R1).
6. **Eval = held-out capture.** The locked success criterion. The question GRPO answers: does it turn 50%-exploit / 0%-capture into actual held-out captures? If yes → goal. If it plateaus → that plateau is the first real evidence the 30B base is the ceiling (then, and only then, consider a bigger base).

PARKED (do not resume without a reason): vulhub diversity harvest, the diverse model, the output-format redesign. They are learnings, not active work.
