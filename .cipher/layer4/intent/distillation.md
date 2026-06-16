# Ozzu Distillation — The Master Plan

**Read every session before touching anything related to Sprint 2c, Sprint 3, Sprint 4, OzzuLab runs, the offense model, or any Opus-as-teacher work. This file is the source of truth. TaskList titles go stale — this file does not.**

Last reviewed: 2026-06-12 (GRPO rounds 0–3 ran: in-distribution capture SOLVED, self-hosted, zero Opus; held-out v2 still 0 — see CURRENT STATE + NEXT CONCRETE ACTION). Prior review 2026-06-11 (Fable takeover — rewritten after the lab-verify sweep + v2 end-to-end play-harvest exposed that the prior plan was chasing winners that don't exist).

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
- Labs: **OzzuLab v1 (LFI) + v2-v9 (cmd-inject, clean)** — clean payloads. **Within-class diversity verdict (2026-06-14, full v4-v9 / boot5): NEGATIVE — no benefit, likely mild cost. boot3 stays the best model.** Cap-30 n=8 said boot5 led held-out v3 (44% vs 25%) — a SMALL-N MIRAGE. The thorough cap-50 eval shows boot5 **consistently at-or-below boot3 on ALL three variants: v1 75<88, v2 69<88, held-out v3 29<38** (thin-diverse boot4: 58% on v3 by being a slow-persistent searcher). Differences are within n=16-24 noise individually, but the direction is consistent across all 3 → the 1405 diverse pairs gave NO lift and dinged in-dist v1/v2. **RETRACT the "63%/diversity wins" headline.** ROBUST findings: (a) all three GENERALIZE — 100% exploit + ~30-58% held-out capture (locked criterion holds for all); (b) boot5 captures FAST-but-shallow (~13-19 iters then plateaus) vs boot3/boot4 SLOW-but-persistent (~27-29). **Diversity changed search BEHAVIOR, not capture RATE. The earlier "decisive win" was a cap-30 small-n artifact — do not cite it.** **Vulhub CVE-box diversity stays PARKED** (version-exact CVE = 30B ceiling). **NEXT lever: cross-class CLEAN-lab harvest → boot6, justified by CAPABILITY COVERAGE** (boot5 can only do 2 vuln classes; it CANNOT do SQLi/SSRF/deser/… at all — acquire the missing skills), NOT by a within-class generalization boost. Spec: `tools/oracle/CROSSCLASS-HARVEST-SPEC.md`.
- SFT method: **QLoRA rank 32, alpha 64, attention-only** (MoE expert MLPs untouched).
- RL method: **GRPO with the ONE reconciled lab-verify reward.**
- Success criterion: **`OZZULAB{}` captured autonomously on a HELD-OUT variant.**

## CURRENT STATE (as of 2026-06-12 — post GRPO round 3)

| Step | Status | Result |
|---|---|---|
| Phase 0 (reward reconcile, trainer rescue, logging) | ✅ done + committed | reward.py dawdle+inversion fixed (proven); sft_direct.py rescued into repo |
| Phase 1 PILOT v1 (SFT on 67 v1 LFI wins) | ✅ done | **BEST SFT MODEL.** Held-out v2 (cmd-inject, never trained): **50% exploit / 0% capture** — real RCE-on-novel-class skill transfer. v1: 2/8 capture, 6/8 exploit. Adapter: `private/sft-adapters/pilot-v1-2026-06-11`. |
| Phase 1b pilot-v2 (retrain on replay-rebuilt full-ctx data) | ✅ done — REGRESSED | worse than pilot-v1. Replay added history-inconsistency noise. Lesson: harvest fresh, never retrofit context via replay. |
| Phase 2b DIVERSITY (6 vulhub classes + v1 = 7-class SFT) | ✅ done — **NEGATIVE RESULT** | diverse model WORSE than pilot everywhere, captured 0 flags. See PHASE 2 VERDICT. |
| **GRPO rounds 0–3 on the pilot (v1+v2)** | ✅ done 2026-06-12 — **IN-DIST CAPTURE SOLVED** | grpo3 captures **v1 75% (6/8)** @max_iter=30, self-hosted, **zero Opus**; edges pilot (63%) at equal budget. Rounds 0–2 were crippled by the close-step truncation bug, now fixed — see [[reference_sft_completion_truncation]]. Adapter: `private/grpo-adapters/round3-pilot-2026-06-12` (backed up, R1). Served via vLLM-LoRA on DO 107.170.49.159 (BILLING). |
| **Iteration-cap finding** | ✅ banked 2026-06-12 | Eval `max_iter=15` was guillotining captures ~1 step before the flag. @30 capture TRIPLES (grpo3 0→6/8, pilot 2→5/8). Eval at ≥30; raise the cap before judging any "can't capture." See [[feedback_offense_eval_iteration_cap]]. **Prod offense harness likely capped too low — free capture win.** |
| **Held-out v2 capture (the LOCKED goal)** | ❌ **NOT met** — 0/8, now **TRUSTWORTHY** | grpo3 gets RCE on the unseen box (**75% exploit**), 7/8 run the FULL 30 iters, captures 0. CAVEAT RESOLVED 2026-06-12: re-eval with a faithful parser → **0 parser-miss, 0 model-no-cmd**; the old "parse_fails" were CONTEXT-OVERFLOW (`api_error`), not command-truncation. The 0 is REAL. Root cause = **perseveration**: it hammers `exploit_probe ×18–27` (re-picking a lock it already owns) instead of sweeping the filesystem for the flag. Learned v1's specific close, not a general "I have RCE → hunt the flag" habit. |
| Harness hardening (2026-06-12) | ✅ done — `tools/oracle/eval-offense.js` | (1) parser anchors close on last-quote-before-brace → faithful; (2) crash-safe + 3-way failure tagging (api_error/parse-miss/no-cmd) so overflow is never again miscounted as parse-fail; (3) history sliding-window (≤22K chars) so long engagements don't overflow 16K (was killing 3/8 exploiting v1 runs); (4) **flag-check hardened — a capture must be in OUTPUT, NOT in the model's command** → kills hallucinated/echoed `OZZULAB{}` fakes. NOT YET COMMITTED. |
| v2 bootstrap SFT (2026-06-12) | ✅ done — **split: v1 BEST-EVER, v2 still 0** | Re-SFT on 616 pairs (275 v1 + 341 from `sprint2c-v2-opus-play`) → `qwen3-coder-30b-boot` (eval_loss 0.455; adapter `private/sft-adapters/bootstrap-v1v2-2026-06-12`, R1-backed). Eval @30 faithful harness: **v1 7/8 (88%, BEST EVER, all REAL flag2) · v2 0/8 (exploit 63%)**. **ROOT CAUSE: the "v2 demos" are MISLABELED v1 data** — they capture `flag2-internal-web-LFI` (65×) + `flag3-db-pivot` (2×), i.e. v1 closes, NOT the v2 cmd-inject close. So the bootstrap taught MORE v1 (→88%) and ZERO real v2 close. **The SFT-close mechanism WORKS (v1 proof); we fed it the wrong data.** No real v2-cmd-inject demos exist on disk — the prior session trusted the filename, never checked flag values. |
| Diverse-data boot4 (25 demos / 6 variants, 2026-06-13) | ⚠️ **held-out FLAT at 25% — thin diversity didn't lift it** | Built 6 new cmd-inject variants (v4-v9, flag relocated to a different path each) + harvested 25 real demos (quota walls + dev-01 outage capped it FAR below the ~20/variant plan: v4:8 v5:6 but v6-v9 only 2-3 each). SFT boot4 (1257 pairs, completion-preserving trunc fix). Eval: **v3 HELD-OUT 25%→25% (FLAT)**, v2 50→63% (↑ in-dist), v1 63% (flat). The thin/lopsided diverse set did NOT lift generalization. **VERDICT: thesis UNCONFIRMED, not disproven** — never reached the demo depth (~120) the plan required; quota-per-account (~12-22 plays) makes the full harvest a multi-session grind. boot4 ≈ boot3 on the goal; marginally better in-dist. Adapter `private/sft-adapters/bootstrap-v4-2026-06-13` (R1). sft_direct.py close-truncation fix (completion-preserving) is committed-worthy + reusable. |
| GRPO round4 on boot3 (2026-06-13) | ⚠️ **NET NEGATIVE for the goal — SFT boot3 stays best** | grpo4 vs boot3: v2 50→75% (↑, the win-heavy 14/16 rollout class), but v1 63→38% (↓) and **HELD-OUT v3 25→0% (↓)**. Clean eval (0 api_error/parse_fail). GRPO over-fit to the dominant rollout class and DRIFTED off the generalizing SFT behavior (KL moved ~55 from anchor). **Lesson: GRPO-as-configured sharpens in-dist but COSTS generalization when one class dominates rollouts.** To improve held-out, the proven lever is DATA scaling (what built it), or a BALANCED/reward-shaped GRPO — not this round. Adapter `private/grpo-adapters/round4-boot3-2026-06-13` (R1, kept for reference). **boot3 remains the production/best model.** |
| **v3 HELD-OUT generalization (boot3) — 2026-06-13** | ✅✅ **LOCKED SUCCESS CRITERION MET** | Built a genuinely-unseen v3 lab (NEW box `10.10.22.x`, cmd-inject flag RELOCATED to `/var/backups/.flag_recovery` w/ new value — the memorized `/var/lib/ops-tools/.flag` path GONE). boot3 (never trained on v3): **capture 2/8 (25%), exploit 8/8 (100%)**, both the real `OZZULAB{cmdi_v3_heldout_relocated_2026}`. It broke into the unseen box every time, then SEARCHED the filesystem (149 post_exploit steps) and found a flag at a path it never memorized. **This is GENERALIZATION, not memorization — the model learned the SKILL.** The project's locked criterion ("capture on a variant NOT trained on") is ACHIEVED. GRPO round4 now training to lift 25%→reliable. |
| Data-scaling boot3 (88 v2 demos, 2026-06-13) | ✅ done — **v2 DATA-LIMITED, NOT capability: 0→50%** | Scaled real v2 demos 24→**88** (harvested 64 more, 64/64 real) → 926-pair SFT (275 v1 + 651 v2) → `qwen3-coder-30b-boot3`. Eval @30: **v2 4/8 (50%) capture, all REAL cmd_injection · v1 5/8 (63%), real flag3 · 100%/88% exploit · 0 api_error**. The floor-vs-plateau test RESOLVED: more demos lifted v2 from ~0-6% → **50%**. **The 30B is NOT the ceiling; no bigger model needed** (the 75% exploit was the tell). v1 held at 63% (v2-heavy data didn't crater it). Adapter `private/sft-adapters/bootstrap-v3-2026-06-13` (R1). **Both classes now in GRPO's 20–80% sweet spot.** |
| Real-v2 bootstrap SFT (boot2, 2026-06-13) | ✅ done — **v2 BREAKTHROUGH: first capture EVER** | Harvested 24 REAL v2 cmd-inject Opus captures (`v2-real-opus-play.jsonl`, all `OZZULAB{cmd_injection_via_ping_diagnose_2026}`, 4-11 iters — after fixing oracle.js's harvester parser, same bug as eval-offense.js). Re-SFT on 440 pairs (275 v1 + 165 real-v2, no replay) → `qwen3-coder-30b-boot2` (adapter `private/sft-adapters/bootstrap-v2real-2026-06-13`, R1). Eval @30: **v2 1/8 (13%) capturing the REAL flag — first v2 capture in project history** (pilot/grpo3/mislabeled-boot were all hard 0). v1 5/8 (63%, real flag3). The real-v2 close TRANSFERRED. CAVEAT: 3/8 v2 engagements died to `api_error` (empty vLLM responses, raw_len=0 — concurrent-load flake, NOT parser/model), so true rate ~1/5 on clean runs. **v2 is now >0% → finally in GRPO's learnable (20–80%-win) range; it never was before (0% = nothing to amplify).** SFT lab gotchas this run: cuDNN-SDPA crash (use MAX_LEN 4096 + `enable_cudnn_sdp(False)`); eval-loop CUDA OOM (disable eval, `expandable_segments`); Opus quota exhausts (switch account). |
| Vulhub generalization re-test (2026-06-12, fixed parser) | ✅ done — **diversity ceiling CONFIRMED (solid)** | Re-ran diverse model on vh-drupal/laravel/weblogic/nexus @30 with the faithful parser. parse_fail deaths **4/6/5/1 → 0/0/0/0** (parser confound REMOVED), but **exploit still 0/6** and all "captures" were HALLUCINATED fakes (caught by the flag-check fix). The 30B can't blind-exploit version-exact CVEs even with recon hints — a real capability ceiling, not scaffolding. "Diversity failed" now stands SOLIDLY. **Contrast — v1 captures verified REAL** (`flag2-internal-web-LFI`, `flag3-db-pivot-via-mysql`): the headline 75% is genuine, NOT inflated. Scaffolding was the wall on v1/v2 (the model's real domain); the CVE wall is genuine. |

## CROSS-CLASS RESULT (2026-06-16) — boot6 (1-inst) generalizes; multi-inst MEMORIZES

The cross-class lever (line 116) was tested end-to-end with a proper **held-out** (not the trained-instance "plumbing" that an earlier session wrongly called GREEN).

- **boot6** (cross-class SFT, **1 instance/class**: sqli-i1 + ssti-i1 + redis-i1 on top of cmd-inject/LFI): on a **held-out** SQLi lab (`sqli-ho30`, never trained, deliberately divergent Py+SQLite/`?ref=` stack) it captures **44-50%** (n=16) vs the untrained baseline boot3's 31% — **real cross-class generalization**, criterion met. And **zero forgetting** (boot6 ≥ boot3 on every old cmd-inject class). **boot6 is the best cross-class model.** Caveat: the margin over base is modest (base Qwen has decent SQLi); absolute held-out (50%) is 2× boot3's prior v3 milestone.
- **boot6-v2** (added a **2nd** SQLi train instance `sqli-i2`, Py+PG, balanced ~19 demos): **NEGATIVE.** Trained sqli-i1 **88%** + sqli-i2 **88%** (memorized both) but held-out **dropped to 19%** (vs boot6's 44%). Adding clean instances → memorization, NOT generalization.

**BANKED:** the spec's "≥2-3 instances/class" premise is **WRONG for clean labs** — same shape as boot5 within-class diversity NEGATIVE, now confirmed cross-class. Do NOT scale multi-instance. If 12-class coverage is pursued, use **1 instance/class**. The generalization lever from here is **GRPO** (R9), not more SFT instances. Labs/data: `tools/oracle/labs/sqli-{ho30,i2}`, adapters `private/sft-adapters/boot6-pilot-2026-06-15` (best) + `boot6-v2-2026-06-16` (memorizes, ref only).

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

## NEXT CONCRETE ACTION — GRPO on boot2 (v2 is finally in range) (2026-06-13)

The real-v2 bootstrap WORKED: 24 real v2 cmd-inject demos harvested → `boot2` → **v2 captured the real flag for the first time (1/8, true ~1/5 clean).** The "harvest real v2 demos → re-SFT" plan is DONE. **v2 is now >0% → for the first time it sits in GRPO's learnable 20–80%-win band** (it was a hard 0 before, so GRPO had zero within-group variance = nothing to amplify). That's the unlock.

THE STEPS:
1. **[free, do first] Clean v2 re-eval** to get the TRUE rate: re-run boot2 v2 @30 with (a) eval concurrency lowered / api_error retried — 3/8 died to empty vLLM responses (`api_error`, raw_len=0) under concurrent load, suppressing the count. Also worth: rename the `parse_fail_x4` end_reason when the deaths are actually `api_error` (currently mislabeled). Cheap, sharpens the number.
2. **GRPO on `boot2`** — the capability lever, now viable on BOTH classes: base = bootstrap-v2real adapter; K=8 rollouts/state; **only on states the model wins 20–80%** (v1 ~63%, v2 ~13–20% both qualify now); reward = reconciled `reward.py` (flag dominates, step-discount, redundancy−); LR 1e-7, β(KL) 0.2; per-step discounted return-to-go; completion-preserving tokenization. Rsync adapter the instant it writes (R1).
3. **Eval on a genuinely-unseen variant** = the LOCKED success criterion (v2 is now in-distribution for boot2). Options for held-out: a fresh OzzulLab variant, or accept the vulhub ceiling is real and define "held-out" within the LFI/cmd-inject family.

PROVEN MECHANISM (banked): SFT-on-real-close-demos teaches the close — v1 75→88, and v2 0→capture. Diversity-SFT does NOT (vulhub ceiling). GRPO is the remaining capability lever; this is the first time it can act on v2.

ANTI-DRIFT (this session's lessons): (a) **verify flag VALUES, not filenames** — the v2-bootstrap detour ran on mislabeled v1 data because a filename was trusted. (b) Harness bugs masked truth repeatedly (eval parser, harvester parser, overflow, api_error mislabel) — confirm the harness faithfully runs what the model emits AND doesn't flake before any "can't" claim. (c) SFT lab gotchas: cuDNN-SDPA crash → MAX_LEN 4096 + `enable_cudnn_sdp(False)`; eval-loop OOM → disable eval + `expandable_segments`; `pkill -f play-parallel.sh` self-kills the launcher. (d) Stay filter-safe: sanitized telemetry only — [[reference_blocked_session_recovery]].

PARKED (do not resume without a reason): vulhub diversity harvest + the diverse model (NEGATIVE result, settled).
