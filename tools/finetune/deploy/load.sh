#!/usr/bin/env bash
# load.sh — Step 9.5 of OFFENSE-FINETUNE-DESIGN.md (dir_1780595412819)
#
# Reads train.py's manifest.json, materializes a concrete Modelfile from
# deploy/Modelfile.template (substituting the adapter path), and registers
# the resulting model in Ollama as `ozzu-soc-v1`.
#
# Usage on the bridge or wherever the adapter directory landed:
#   ./tools/finetune/deploy/load.sh \
#       --manifest /home/gcp/ozzu/private/finetune/qwen3-32b-ozzu-soc-v1/manifest.json \
#       --tag ozzu-soc-v1
#
# Requires:
#   - ollama running locally (or OLLAMA_HOST pointed at the right server)
#   - base model `qwen3:32b` already pulled (ollama pull qwen3:32b)

set -euo pipefail

MANIFEST=""
TAG="ozzu-soc-v1"
TEMPLATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/Modelfile.template"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --tag)      TAG="$2";      shift 2 ;;
    --template) TEMPLATE="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: load.sh --manifest <path/to/manifest.json> [--tag NAME] [--template PATH]"
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$MANIFEST" ]]; then
  echo "[load] FATAL: --manifest is required (output of train.py)" >&2
  exit 2
fi
if [[ ! -f "$MANIFEST" ]]; then
  echo "[load] FATAL: manifest not found: $MANIFEST" >&2
  exit 2
fi
if [[ ! -f "$TEMPLATE" ]]; then
  echo "[load] FATAL: Modelfile template not found: $TEMPLATE" >&2
  exit 2
fi

# Extract adapter_dir from manifest. Use python so we don't take a jq dep.
ADAPTER_PATH=$(python3 -c "import json,sys; print(json.load(open('$MANIFEST'))['adapter_dir'])")
if [[ -z "$ADAPTER_PATH" ]]; then
  echo "[load] FATAL: manifest has no 'adapter_dir' key" >&2
  exit 2
fi
if [[ ! -d "$ADAPTER_PATH" ]]; then
  echo "[load] FATAL: adapter directory not found: $ADAPTER_PATH" >&2
  echo "[load] (Did you scp it back from the DO droplet? See OFFENSE-FINETUNE-DESIGN.md §5.)" >&2
  exit 2
fi

# Sanity — does the adapter look like a PEFT save?
for f in adapter_config.json adapter_model.safetensors; do
  if [[ ! -f "$ADAPTER_PATH/$f" ]]; then
    echo "[load] WARN: $ADAPTER_PATH/$f missing — Ollama may refuse the adapter" >&2
  fi
done

# Materialize Modelfile in a temp file
TMPDIR=$(mktemp -d)
MODELFILE="$TMPDIR/Modelfile"
sed "s|{{ADAPTER_PATH}}|$ADAPTER_PATH|g" "$TEMPLATE" > "$MODELFILE"

echo "[load] generated Modelfile:"
sed 's/^/  | /' "$MODELFILE"

echo
echo "[load] calling: ollama create $TAG -f $MODELFILE"
ollama create "$TAG" -f "$MODELFILE"
rm -rf "$TMPDIR"

echo
echo "[load] DONE. Verify with:"
echo "  ollama list | grep $TAG"
echo "  ollama run $TAG 'Reply with the single word READY.'"
echo
echo "When eval confirms it beats base qwen3:32b, swap the bridge default:"
echo "  edit backend/.env  → OFFENSE_MODEL_NAME=$TAG"
echo "  cd backend && docker compose up -d bridge  (recreate to pick up env)"
