# offense-gpu-image — pre-baked vast.ai image for serving + training the offense model

## 1. Purpose

Kill the ~1-hour dependency setup that every fresh vast.ai GPU rental was burning before the
offense model could serve or train. A pre-built Docker image freezes the entire flaky stack
(vLLM + torch + CUDA + the QLoRA training deps) so a new rental is **serving in ~model-pull
time (~6–10 min) instead of ~1 h**. dir_1781203380739.

The hour came from real, repeated failures (all documented in `tools/sft-train/gpu-setup.sh`):
pip building vLLM from scratch, the **PyJWT** conflict aborting the whole install, **pypi
read-timeouts**, the **hf_transfer** silent-no-op download trap, and the `pip install torch`
**cu130-too-new** driver mismatch. Baking the image makes all of those un-happen.

## 2. Architecture

```
FROM vllm/vllm-openai:<tag>     # official image: known-good torch + CUDA + vLLM (the flaky part, pre-solved)
  + pip: peft bitsandbytes accelerate datasets trl safetensors huggingface_hub hf_transfer  (training stack)
  + serve.sh                    # pull base if missing -> auto-discover /adapters -> vllm serve --enable-lora
```

- **One image, both jobs.** Serve (eval/inference) AND train (SFT/GRPO) from the same image —
  training deps sit on top of vLLM's own torch, so there's no second torch and no driver mismatch.
- **Base model is NOT baked in.** The bf16 base is ~57 GB; baking it would make a ~70 GB image
  that's just as slow to pull at rental as downloading the model. So `serve.sh` pulls it at
  runtime via hf_transfer (now *reliable*, because hf_transfer is guaranteed present + enabled).
- **Adapters are mounted/rsync'd**, not baked — they change every training round.

## 3. Build

Run **once**, on a box with Docker + disk + fast net (ideally the first GPU you rent):

```bash
docker login ghcr.io                       # or docker login (Docker Hub)
IMAGE=ghcr.io/<user>/ozzu-offense-gpu:v1 ./build-and-push.sh
```

Do NOT build on the bridge VM unless disk is healthy — it's often near-full; the vLLM base
layer alone is ~10 GB.

## 4. Configuration

`serve.sh` reads env (all have sane defaults baked into the Dockerfile):

| env | default | meaning |
|---|---|---|
| `BASE_MODEL` | `Qwen/Qwen3-Coder-30B-A3B-Instruct` | HF repo for the bf16 base |
| `BASE_DIR` | `/root/coder-bf16` | where the base is pulled/cached |
| `ADAPTER_DIR` | `/adapters` | each subdir with `adapter_config.json` → served as `qwen3-coder-30b-<dirname>` |
| `PORT` | `8000` | OpenAI-API port |
| `MAX_MODEL_LEN` | `16384` | serve length — must be 16384, NOT the 4096 train len, or long eval histories overflow into empty `api_error` |
| `MAX_LORA_RANK` | `32` | matches the trained adapters |

## 5. Deployment

```bash
# rent a 141GB card (H200, or H100/A100 80GB+ — the MoE won't fit smaller), select this image
rsync -a private/sft-adapters/boot7-2026-06-16/ private/grpo-adapters/round3-pilot-2026-06-12/ root@<box>:/root/adapters/<name>/
docker run -d --gpus all -p 8000:8000 -v /root/adapters:/adapters --name vllm ghcr.io/<user>/ozzu-offense-gpu:v1
# first boot pulls the base (~6 min); subsequent restarts on the same box are instant
curl -s localhost:8000/v1/models    # confirm base + each qwen3-coder-30b-<adapter> is served
```

Then tunnel the bridge → `<box>:8000` and run `tools/oracle/eval-offense.js` as before.

## 6. Budget

- Image build/push: one-time, ~10 min on a GPU box, free (or pennies of egress).
- Per rental: the only setup cost is the ~57 GB base pull, ~6–10 min on a fast box. The
  ~1 h dependency setup is gone. GPU itself ~$2.59/hr (H200), runs are <1 h.
- Optional further win: cache the base on a vast **persistent volume** to skip even the pull —
  costs storage rent; only worth it if you rent very frequently.

## 7. Operation

- **Serve only (eval):** the default `CMD` (`serve.sh`) does it — pull base, discover adapters, serve.
- **Train (SFT/GRPO):** `docker run … <image> bash`, then run `tools/sft-train/sft_direct.py` /
  `tools/grpo/train_grpo.py` inside — torch/peft/bitsandbytes/trl are already there.
- Adapter naming: a dir `/adapters/grpo3/` is served as `qwen3-coder-30b-grpo3`.

## 8. Troubleshooting

- **`bitsandbytes` import error / CUDA mismatch:** the one real risk of layering bnb on the vLLM
  image's torch. Fix: pin a bnb build matching that torch's CUDA, or train in a separate image.
  Validate at first build with `docker run --rm --gpus all <image> python3 -c "import bitsandbytes"`.
- **Base pull stalls:** confirm `HF_HUB_ENABLE_HF_TRANSFER=1` (baked) and the box has disk for ~60 GB.
- **vLLM OOM at load:** the MoE bf16 is ~60 GB on-GPU — needs 141 GB (H200) or tight 80 GB. Not a 4090.
- **`vllm serve` flag rejected:** the base tag's vLLM differs from v0.23.0 — bump/pin `VLLM_TAG`.

## 9. Limits

- NVIDIA only (CUDA). The DigitalOcean MI300X training path uses `rocm/vllm` — a separate image.
- Does not bake the base model or adapters (by design — see Architecture).
- bitsandbytes-on-vLLM-torch compatibility is validated at build time, not guaranteed across
  arbitrary `VLLM_TAG` bumps.
