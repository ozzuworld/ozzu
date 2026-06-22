# Ozzu Offense-Model / SOC Autonomy — Project Overview (tracked, sanitized)

**This is the git-tracked, shareable overview.** Spend figures, target network details, the
physical lab's identity, GPU instance addresses, and flag strings are intentionally omitted —
the full detail lives in the gitignored `private/distillation/PROJECT-DOCUMENTATION.md` on the
bridge VM. Compiled 2026-06-22 from a full reconstruction of the June 2026 work.

---

## Bottom line

Goal: a **self-hosted, autonomous offensive-security capability** for the Ozzu SOC platform — a
model that drives recon → enumeration → exploitation → flag-capture inside a human-overseeable harness.

Two approaches were tried:

1. **Train our own offense model** (distillation: teacher → SFT → GRPO on Qwen3). **NEGATIVE** —
   the trained model does not generalize across vulnerability classes; it memorizes trained
   instances, and adding instances *or* breadth lowered held-out capture.
2. **Rent a frontier reasoning model + keep the harness** (DeepSeek V4 via OpenRouter). **POSITIVE** —
   untrained on our labs, it beat the distilled model on held-out synthetic labs and captured flags
   on the physical lab.

**Confirmed path = approach #2: DeepSeek V4 (`deepseek/deepseek-v4-pro`) via OpenRouter, driving the
existing harness. No fine-tuning.** The trained-model work is a closed research result, not a fallback.

Headline learning: *there is no "magic pentest model" — pentest skill is emergent from strong general
reasoning. The leverage is the harness, not bespoke weights.*

---

## The harness (the durable asset)

Two execution paths:
- **Path A — standalone eval harness** (`tools/oracle/eval-offense.js`): an agentic loop — model
  returns a JSON action `{reasoning, intent_class, command, expected_artifact}` → command executes →
  output folds into the next step → repeat until capture / max-iter / repeated parse-fail / transport-dead.
  Model is pluggable (local vLLM **or** DeepSeek via OpenRouter) through `OFFENSE_MODEL_URL`. File-based state.
- **Path B — bridge production driver** (`backend/bridge/offense-agent.js` + MCP tools): a multi-agent,
  membrane-isolated pipeline (orchestrator → synthesize → queue → aggregate), Postgres-backed.

**The membrane (~12 gate layers):** write-guard, intent classifier, phase-gated auto-executor,
permission modes / workspace_jail, 7 typed recovery recipes, mentor/planner/reflector/refiner loops,
bash-validation, claim-verifier, CVE/NSE/exploit knowledge tools, sub-agent coordinator, sanitized
telemetry (raw offensive output stays server-side and is never returned to the orchestrator), and a
two-report finish (full operator report + sanitized debrief).

**Transport:** WireGuard → rooted Android tablet bridge → target LAN. Must run from the bridge VM, not
the lab host, to avoid a same-subnet routing collision that contaminates results.

---

## Distillation pipeline (abandoned — research record)

- **Teacher harvest** (`tools/oracle/`): Claude played full engagements end-to-end; trajectories were
  best-of-N sampled + grader-scored into a curated SFT set. (An early *single-step* prompting design was
  recon-biased and near-zero capture — fixed by end-to-end play.)
- **SFT** (`tools/sft-train/`, `tools/finetune/`): QLoRA on Qwen3-Coder-30B-A3B / Qwen3-32B. Gotcha: the
  MoE experts are a fused tensor (not `nn.Linear`) → don't bnb-4bit-quantize → needs a 141 GB GPU.
- **GRPO** (`tools/grpo/`): outcome-based RL with a verifiable reward. Bug fixed: right-truncation at
  max-len dropped the completion (the "close") of long-prompt steps → zero gradient on the flag grab.

---

## Results (qualitative)

| Experiment | Held-out capture | Note |
|---|---|---|
| Pilot SFT (1-class) | held-out ~0% (exploit ~50%) | learns recon, not the close |
| Diverse SFT (7-class) | held-out ~0% | diversity *hurt* at this scale |
| GRPO rounds | looked stuck at 0 | masked by a too-low iteration cap |
| GRPO + raised iter cap | capture jumped to ~75% in-dist | the iteration-cap confound |
| 5-class focused (best) | **~44–50% held-out** | peak generalizer |
| + more instances | ~19% | multi-instance memorizes |
| + more classes (8) | ~25% | breadth dilutes depth |
| **DeepSeek V4 (untrained)** | beat the trained model; captured flags on the physical lab | **the solution** |

**Key findings:**
1. Custom distillation does not generalize across vuln classes (memorization).
2. Reward = flag-string is a proxy → Goodhart (the model chases the token, not access).
3. The iteration cap masks capability — always evaluate at a sufficient cap.
4. A bought frontier reasoning model + the harness beats the trained model, untrained.

---

## Infrastructure

- **GPUs (all rent-and-destroy; none running now):** vast.ai (harness-dev inference) + DigitalOcean H200
  (SFT/GRPO training) + DigitalOcean MI300X (large-model inference). A pre-baked vast.ai image cut per-rental setup.
- **Tablet bridge:** rooted Android tablet reflashed to LineageOS, with a durable root `wireguard-go`
  daemon + watchdog + boot-persistence (replaced a doze-fragile VPN app that produced dead tunnels → invalid runs).
- **Labs:** isolated docker vulnerable services on the lab host (cmd-injection, LFI, SQLi, SSTI, Redis,
  SSRF, IDOR, auth-bypass, + held-out variants), each carrying a flag sentinel.

---

## Current state & next step

- **Solution:** DeepSeek V4 via OpenRouter, driving the harness. No fine-tuning.
- **Last live action:** a physical-lab run on the durable tablet (a prior run already captured flags). The
  run is detached and model-driven — it does not require the orchestrator in the loop.
- **No GPU running.** All training adapters archived on the durable GCP VM.
- **Open decisions:** keep/cancel the frontier-model subscription; clear a small cloud-GPU billing block
  only if that provider is needed again.

---

## File map

| Area | Path |
|---|---|
| Eval harness (Path A) | `tools/oracle/eval-offense.js`, `format-sft.js`, `report-via-model.js` |
| Teacher harvest | `tools/oracle/play-engagement.js`, `oracle.js` |
| SFT / GRPO (research) | `tools/sft-train/`, `tools/finetune/`, `tools/grpo/` |
| Bridge driver (Path B) | `backend/bridge/offense-agent.js`, `offense-orchestrator.js`, `offense-engine.js` |
| Architecture docs | `backend/bridge/SOC-PIPELINE-ARCHITECTURE.md`, `OFFENSE-AGENT-DESIGN.md`, `SOC-OFFENSE-MODEL-RUNBOOK.md` |
| Research record | `.cipher/layer4/intent/distillation.md` (historical), full detail in gitignored `private/distillation/PROJECT-DOCUMENTATION.md` |
