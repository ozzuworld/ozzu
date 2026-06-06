#!/usr/bin/env bash
# dump-engagement.sh — extract full engagement state from postgres to JSON for v1.4 training corpus.
#
# Captures: scope, ROE, all queue items (command + output), the orchestrator
# task DAG, offense telemetry (which model made which decision and outcome),
# and findings. One JSON file per engagement.
#
# Usage:
#   tools/finetune/dump-engagement.sh <engagement_id>
#   tools/finetune/dump-engagement.sh --all               # dump every engagement
#
# Output:
#   private/finetune/corpus-v1.4/<engagement_id>.json

set -euo pipefail

CORPUS_DIR="/home/gcp/ozzu/private/finetune/corpus-v1.4"
PG_CONTAINER="ozzu-postgres"

usage() {
  echo "Usage: $0 <engagement_id>  |  $0 --all" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
mkdir -p "$CORPUS_DIR"

dump_one() {
  local eng_id="$1"
  local out="$CORPUS_DIR/${eng_id}.json"

  docker exec -i "$PG_CONTAINER" psql -U ozzu -d ozzu -t -A -v "eng_id=$eng_id" <<'SQL' > "$out.tmp"
SELECT jsonb_pretty(jsonb_build_object(
  'engagement_id', e.id,
  'dumped_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'metadata', jsonb_build_object(
    'client_name',        e.client_name,
    'engagement_type',    e.engagement_type,
    'scope',              e.scope,
    'roe',                e.roe,
    'status',             e.status,
    'executor_host',      e.executor_host,
    'executor_adb_target', e.executor_adb_target,
    'executor_tools',     e.executor_tools,
    'engagement_phase',   e.engagement_phase,
    'agent_status',       e.agent_status,
    'agent_run_state',    e.agent_run_state,
    'start_date',         e.start_date,
    'end_date',           e.end_date,
    'lead_engineer',      e.lead_engineer
  ),
  'queue_items', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id',           q.id,
      'seq',          q.seq,
      'title',        q.title,
      'description',  q.description,
      'command',      q.command,
      'status',       q.status,
      'output',       q.output,
      'session_id',   q.session_id,
      'created_at',   q.created_at,
      'started_at',   q.started_at,
      'completed_at', q.completed_at
    ) ORDER BY q.seq)
    FROM soc_queue_items q WHERE q.engagement_id = e.id
  ), '[]'::jsonb),
  'tasks', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id',              t.id,
      'parent_ids',      t.parent_ids,
      'directive',       t.directive,
      'phase',           t.phase,
      'prerequisites',   t.prerequisites,
      'status',          t.status,
      'queue_item_id',   t.queue_item_id,
      'outcome_summary', t.outcome_summary,
      'iteration',       t.iteration,
      'created_at',      t.created_at,
      'completed_at',    t.completed_at
    ) ORDER BY t.id)
    FROM engagement_tasks t WHERE t.engagement_id = e.id
  ), '[]'::jsonb),
  'telemetry', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id',              ot.id,
      'queue_item_id',   ot.queue_item_id,
      'model_used',      ot.model_used,
      'intent_category', ot.intent_category,
      'n_hosts',         ot.n_hosts,
      'n_findings',      ot.n_findings,
      'step_queued',     ot.step_queued,
      'in_scope',        ot.in_scope,
      'n_references',    ot.n_references,
      'latency_ms',      ot.latency_ms,
      'outcome',         ot.outcome,
      'outcome_notes',   ot.outcome_notes,
      'error_message',   ot.error_message,
      'created_at',      ot.created_at
    ) ORDER BY ot.created_at)
    FROM offense_telemetry ot WHERE ot.engagement_id = e.id
  ), '[]'::jsonb),
  'findings', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id',             f.id,
      'severity',       f.severity,
      'title',          f.title,
      'description',    f.description,
      'cvss_score',     f.cvss_score,
      'affected_asset', f.affected_asset,
      'mitre_attack',   f.mitre_attack,
      'reproduction',   f.reproduction,
      'remediation',    f.remediation,
      'refs',           f.refs,
      'status',         f.status,
      'discovered_at',  f.discovered_at,
      'discovered_by',  f.discovered_by
    ) ORDER BY f.discovered_at)
    FROM pentest_findings f WHERE f.engagement_id = e.id
  ), '[]'::jsonb),
  'behavior_notes', COALESCE((
    -- dir_1780763699521 — v1.4 corpus quality labels (see model_behavior_notes
    -- table, dir_1780763057382). Trainer indexes these by (iter, queue_item_id)
    -- to drop or down-weight per-iteration training records by polarity/tag.
    SELECT jsonb_agg(jsonb_build_object(
      'id',             n.id,
      'queue_item_id',  n.queue_item_id,
      'iter',           n.iter,
      'model_used',     n.model_used,
      'tag',            n.tag,
      'polarity',       n.polarity,
      'observation',    n.observation,
      'suggested_fix',  n.suggested_fix,
      'created_at',     n.created_at,
      'created_by',     n.created_by
    ) ORDER BY n.created_at)
    FROM model_behavior_notes n WHERE n.engagement_id = e.id
  ), '[]'::jsonb)
))
FROM pentest_engagements e
WHERE e.id = :'eng_id';
SQL

  if [[ ! -s "$out.tmp" ]]; then
    rm -f "$out.tmp"
    echo "ERROR: engagement '$eng_id' not found" >&2
    return 1
  fi

  mv "$out.tmp" "$out"

  local qi findings telem notes
  qi=$(jq '.queue_items | length' "$out")
  findings=$(jq '.findings | length' "$out")
  telem=$(jq '.telemetry | length' "$out")
  notes=$(jq '.behavior_notes | length' "$out")
  echo "wrote $out  (queue=$qi, findings=$findings, telemetry=$telem, notes=$notes)"
}

if [[ "$1" == "--all" ]]; then
  ids=$(docker exec -i "$PG_CONTAINER" psql -U ozzu -d ozzu -t -A -c \
    "SELECT id FROM pentest_engagements ORDER BY created_at")
  while IFS= read -r eng_id; do
    [[ -n "$eng_id" ]] && dump_one "$eng_id"
  done <<< "$ids"
else
  dump_one "$1"
fi
