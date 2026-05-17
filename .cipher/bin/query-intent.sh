#!/usr/bin/env bash
# Cipher Layer 2 — query the intent index.
# Usage: .cipher/bin/query-intent.sh "<search terms>"
# Returns matching files with their intent strings (case-insensitive substring match across path + intent).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INDEX="${REPO_ROOT}/.cipher/layer2/intent-index.json"

if [[ ! -f "${INDEX}" ]]; then
  echo "ERROR: intent index missing — run scripts/cipher-analyze.sh layer2" >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <search terms>" >&2
  exit 1
fi

QUERY="$*"
python3 - "${INDEX}" "${QUERY}" <<'PY'
import json, sys, re
index_path, query = sys.argv[1], sys.argv[2]
with open(index_path) as f:
    idx = json.load(f)
terms = [t.lower() for t in re.split(r"\s+", query) if t]
matches = []
for path, entry in idx.items():
    text = (path + " " + entry.get("intent", "")).lower()
    score = sum(1 for t in terms if t in text)
    if score > 0:
        matches.append((score, path, entry.get("intent", "")))
matches.sort(key=lambda m: -m[0])
if not matches:
    print(f"No matches for: {query}")
    sys.exit(0)
print(f"# {len(matches)} matches for: {query}\n")
for score, path, intent in matches[:25]:
    print(f"[{score}] {path}")
    print(f"  {intent}\n")
PY
