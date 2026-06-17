#!/usr/bin/env bash
# Build + push the Ozzu offense-model GPU image ONCE; reuse on every future rental.
# dir_1781203380739.
#
# Run this on a box with Docker + disk + a fast network. Best choice: the FIRST GPU box
# you rent (ephemeral disk, fast pull of the ~10GB vLLM base). After it's pushed, no box
# ever rebuilds it — vast.ai just pulls the tagged image at rental.
#
# Usage:
#   IMAGE=ghcr.io/<user>/ozzu-offense-gpu:v1 ./build-and-push.sh
#   # (must `docker login ghcr.io` / `docker login` first)
#
# Override the vLLM base tag if you bump versions:
#   VLLM_TAG=v0.23.0 IMAGE=... ./build-and-push.sh
set -euo pipefail
cd "$(dirname "$0")"

: "${IMAGE:?set IMAGE=<registry>/<repo>:<tag>  e.g. ghcr.io/USER/ozzu-offense-gpu:v1}"
: "${VLLM_TAG:=v0.23.0}"

echo "=== building $IMAGE (vLLM base $VLLM_TAG) ==="
docker build --build-arg "VLLM_TAG=${VLLM_TAG}" -t "$IMAGE" .

echo "=== pushing $IMAGE ==="
docker push "$IMAGE"

echo "=== DONE ==="
echo "Rent with this image, then:"
echo "  docker run -d --gpus all -p 8000:8000 -v /root/adapters:/adapters --name vllm $IMAGE"
echo "Adapters: rsync your private/sft-adapters/<x> + grpo-adapters/<x> dirs into /root/adapters/ first."
