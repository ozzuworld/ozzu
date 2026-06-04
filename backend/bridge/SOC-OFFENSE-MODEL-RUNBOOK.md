# SOC Offense-Model Runbook — on-demand vast.ai (Layer L3)

**Status:** vast-rental-ready prep (`dir_1780575644710`). **NOTHING here rents a GPU.**
The `gpu_create` call is the spend trigger and is gated on King Kazuma's approval
(defer-spend rule). This runbook makes that rental turnkey + per-engagement.

## Purpose

Stand up the Layer L3 offense-synthesis model on-demand per engagement, run it, tear
it down — so GPU cost is per-engagement, not owned hardware. L3 holds the offensive
context (structured findings + retained raw evidence) that must NOT enter Claude's
(L4) context. See `SOC-PIPELINE-ARCHITECTURE.md`.

## Prereqs (already in place)

- vast.ai API key: `/root/.config/vastai/vast_api_key`
- MCP tools: `gpu_create`, `gpu_status`, `gpu_ssh_exec`, `gpu_destroy` (`routes/mcp.js`) — wraps the vast.ai API directly; no custom spin-up needed.

## Model + GPU matrix

| Model | Base | Quant | ~Size | GPU | `gpu_create` args | ~$/hr |
|---|---|---|---|---|---|---|
| **WhiteRabbitNeo-V3-7B** *(start here)* | Qwen 2.5, 131K ctx | Q4_K_M | ~4.5 GB | RTX 4090 24 GB | `{gpu_model:"RTX_4090", disk_gb:40, max_cost:0.45}` | ~0.29 |
| Llama-3.1-WhiteRabbitNeo-2-70B *(depth fallback)* | Llama 3.1 | Q4_K_M | ~42 GB | RTX A6000 48 GB | `{gpu_model:"RTX_A6000", disk_gb:120, max_cost:0.60}` | ~0.39 |

Confirm the exact vast.ai GPU name string + live price at rental time — `gpu_create`
picks the cheapest matching offer under `max_cost`.

## Procedure

### 1. Spin up — **SPEND STARTS HERE (gated)**
`gpu_create({gpu_model:"RTX_4090", disk_gb:40, max_cost:0.45})` → returns instance ID +
SSH host/port. Note them; poll `gpu_status` until ready.

### 2. Install + serve (via `gpu_ssh_exec`)
```bash
curl -fsSL https://ollama.com/install.sh | sh
export OLLAMA_HOST=127.0.0.1:11434          # PRIVATE — never bind 0.0.0.0 on a public vast box
nohup ollama serve >/var/log/ollama.log 2>&1 &
sleep 5
ollama pull hf.co/bartowski/WhiteRabbitNeo_WhiteRabbitNeo-V3-7B-GGUF:Q4_K_M   # confirm quant tag on the HF repo
ollama list                                  # verify model present
```
7B GGUF pulls in ~1–2 min. For the 70B (~42 GB) use a vast.ai **persistent volume** so
each spin-up doesn't re-download tens of GB.

### 3. Connect the bridge — private tunnel, not public
Open an SSH tunnel from the bridge so `:11434` is never exposed on the public instance:
```bash
ssh -N -L 11434:127.0.0.1:11434 -p <ssh_port> root@<ssh_host> &
```
The model is then reachable at the OpenAI-compatible endpoint `http://127.0.0.1:11434/v1`
(model name = the ollama tag). This is the target for the future L3 wiring (directive D).

### 4. Benchmark — the 7B-vs-70B decision
Feed **structured inputs only** (`recon_hosts` rows + `pentest_findings`), never raw scan
dumps. For known `service`+`version` rows, ask the model to:
- name candidate public CVEs/PoCs **by ID** (CVE / ExploitDB / MSF module path),
- propose the next enumeration step.

Score: (a) are the CVE IDs real and applicable to that exact version? (b) hallucination
rate, (c) sane next-step. If V3-7B scores well enough for Layer C → **stop, never rent the
70B.** If recall is shallow → repeat on the 70B and compare.

### 5. Tear down — **STOP BILLING**
`gpu_destroy({instance_id:<id>})` at engagement end, every time. Confirm with `gpu_status`
(no running instances).

## Membrane discipline at L3

- **L3 input:** structured findings + retained raw evidence, pulled server-side. The raw
  stays server-side; it never flows to Claude (L4).
- **L3 output:** candidate PoCs by ID + next-step, queued server-side as
  command+rationale, sanitized before it reaches the PA or Claude — IDs and rationale, not
  exploit source. (RULE 3 / `feedback_security_role`: Cipher = teacher, never authors
  exploit code.)

## Cost reality

A benchmark/engagement session of ~1–3 h: 7B ≈ $0.30–0.90; 70B ≈ $0.40–1.20.
Per-engagement, torn down after. No owned hardware.

## NOT in this directive

- The actual rental (`gpu_create`) — gated on King Kazuma's approval.
- Bridge → L3 inference wiring — **directive D** (FEATURE, needs PIN approval).
