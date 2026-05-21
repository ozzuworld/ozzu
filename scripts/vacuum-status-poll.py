#!/usr/bin/env python3
"""Pull cleaning-history events for the Dreame vacuum from Dreame's cloud and upsert
into postgres `vacuum_runs`. Designed to run from cron every 10 min.

Dreame's HTTP get_properties endpoint refuses (code 10001 — needs MQTT push), but the
event-history endpoint returns completed cleanings. That's exactly what we want for the
audit log; we don't need live state.

Secrets come from /root/.ozzu-secrets (sourced as shell). Postgres creds come from the
running ozzu-postgres container via docker exec — same path the bridge uses.

Exit codes: 0 = success, 1 = cloud auth failed, 2 = DB write failed, 3 = config missing.
"""
import os
import sys
import json
import time
import shlex
import logging
import subprocess
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
LIB_DIR = SCRIPTS_DIR / "lib"
sys.path.insert(0, str(LIB_DIR))

from dreame import DreameVacuumDreameHomeCloudProtocol
from dreame.types import (
    DreameVacuumProperty,
    DreameVacuumPropertyMapping,
    PIID,
)

LOG_PATH = Path("/home/gcp/ozzu/logs/vacuum.log")
LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    filename=str(LOG_PATH),
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("vacuum-poll")


def load_secrets(path="/root/.ozzu-secrets"):
    """Parse a shell-style KEY=VALUE secrets file. Single-quoted values are unwrapped."""
    out = {}
    for raw in Path(path).read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        try:
            parts = shlex.split(v)
            out[k.strip()] = parts[0] if parts else ""
        except ValueError:
            out[k.strip()] = v
    return out


def parse_history_record(history_data, prop_mapping):
    """Translate a Dreame history record (list of {piid, value} dicts) into our row shape."""
    piid_status = PIID(DreameVacuumProperty.STATUS, prop_mapping)
    piid_cleaning_time = PIID(DreameVacuumProperty.CLEANING_TIME, prop_mapping)
    piid_cleaned_area = PIID(DreameVacuumProperty.CLEANED_AREA, prop_mapping)
    piid_started = PIID(DreameVacuumProperty.CLEANING_START_TIME, prop_mapping)
    piid_log_status = PIID(DreameVacuumProperty.CLEAN_LOG_STATUS, prop_mapping)
    piid_log_file = PIID(DreameVacuumProperty.CLEAN_LOG_FILE_NAME, prop_mapping)
    piid_props = PIID(DreameVacuumProperty.CLEANING_PROPERTIES, prop_mapping)

    out = {
        "status_code": None,
        "cleaning_minutes": 0,
        "cleaned_area_m2": 0,
        "started_at_unix": None,
        "completed": None,
        "cleanup_method": None,
        "task_interrupt": None,
        "map_object_name": None,
        "raw_piids": {},
    }
    for item in history_data:
        pid = item.get("piid")
        val = item.get("value", item.get("val"))
        out["raw_piids"][str(pid)] = val
        if pid == piid_status:
            out["status_code"] = val
        elif pid == piid_cleaning_time:
            out["cleaning_minutes"] = val or 0
        elif pid == piid_cleaned_area:
            out["cleaned_area_m2"] = val or 0
        elif pid == piid_started:
            out["started_at_unix"] = val
        elif pid == piid_log_status:
            out["completed"] = bool(val == 1)
        elif pid == piid_log_file and isinstance(val, str) and val:
            out["map_object_name"] = val.split(",", 1)[0]
        elif pid == piid_props and isinstance(val, str) and val:
            try:
                props = json.loads(val)
                if "cmc" in props:
                    out["cleanup_method"] = props.get("cmc")
                if "abnormal_end" in props:
                    try:
                        reason = json.loads(props["abnormal_end"])
                        if isinstance(reason, list) and reason:
                            out["task_interrupt"] = reason[0]
                    except (ValueError, TypeError):
                        pass
            except ValueError:
                pass
    return out


def upsert_runs(records, device_did):
    """Insert vacuum_runs rows; skip dupes via cloud_event_id."""
    if not records:
        return 0, 0

    # Build a SQL batch — postgres ON CONFLICT for the upsert.
    sql_lines = ["BEGIN;"]
    for r in records:
        raw_history = r.get("history") or r.get("value")
        if isinstance(raw_history, str):
            try:
                history_data = json.loads(raw_history)
            except ValueError:
                log.warning("Skipping cloud event %s — history not parseable JSON", r.get("id"))
                continue
        else:
            history_data = raw_history or []
        row = parse_history_record(history_data, DreameVacuumPropertyMapping)
        if row["started_at_unix"] is None:
            # Without a start time we can't reasonably store the row — Dreame's history
            # always emits piid 6, so absence means an unfamiliar firmware shape; log and skip.
            log.warning("Skipping cloud event %s — no CLEANING_START_TIME", r.get("id"))
            continue
        attrs = {
            "createTime": r.get("createTime"),
            "region": r.get("region"),
            "piids": row["raw_piids"],
        }
        sql_lines.append(
            "INSERT INTO vacuum_runs ("
            "cloud_event_id, device_did, started_at, cleaning_minutes, cleaned_area_m2, "
            "status_code, completed, cleanup_method, task_interrupt, map_object_name, raw_attrs"
            ") VALUES ("
            f"$${r['id']}$$, $${device_did}$$, to_timestamp({row['started_at_unix']}), "
            f"{int(row['cleaning_minutes'])}, {int(row['cleaned_area_m2'])}, "
            f"{'NULL' if row['status_code'] is None else int(row['status_code'])}, "
            f"{'NULL' if row['completed'] is None else str(row['completed']).upper()}, "
            f"{'NULL' if row['cleanup_method'] is None else int(row['cleanup_method'])}, "
            f"{'NULL' if row['task_interrupt'] is None else int(row['task_interrupt'])}, "
            f"$dq${row['map_object_name'] or ''}$dq$, "
            f"$dq${json.dumps(attrs)}$dq$"
            ") ON CONFLICT (cloud_event_id) DO NOTHING;"
        )
    sql_lines.append("COMMIT;")
    sql = "\n".join(sql_lines)

    proc = subprocess.run(
        [
            "docker", "exec", "-i", "ozzu-postgres",
            "bash", "-c", "psql -U $POSTGRES_USER -d $POSTGRES_DB -v ON_ERROR_STOP=1",
        ],
        input=sql, text=True, capture_output=True, timeout=30,
    )
    if proc.returncode != 0:
        log.error("postgres write failed: %s", proc.stderr.strip())
        raise SystemExit(2)

    # INSERT outputs one line per row; ON CONFLICT DO NOTHING also outputs INSERT 0 0
    inserted = sum(1 for line in proc.stdout.splitlines() if line.startswith("INSERT 0 1"))
    skipped_dup = sum(1 for line in proc.stdout.splitlines() if line.startswith("INSERT 0 0"))
    return inserted, skipped_dup


def main():
    secrets = load_secrets()
    required = (
        "DREAME_USERNAME", "DREAME_PASSWORD", "DREAME_ACCOUNT_TYPE",
        "DREAME_COUNTRY", "DREAME_AUTH_KEY", "DREAME_DID",
    )
    missing = [k for k in required if not secrets.get(k)]
    if missing:
        log.error("Missing secrets: %s", missing)
        sys.exit(3)

    proto = DreameVacuumDreameHomeCloudProtocol(
        username=secrets["DREAME_USERNAME"],
        password=secrets["DREAME_PASSWORD"],
        account_type=secrets["DREAME_ACCOUNT_TYPE"],
        country=secrets["DREAME_COUNTRY"],
        auth_key=secrets["DREAME_AUTH_KEY"],
        did=secrets["DREAME_DID"],
    )
    if not proto.login():
        log.error("Dreame cloud login failed (auth_key likely expired — re-pair via Dreame app)")
        sys.exit(1)

    # Populate _uid; get_device_event needs it.
    proto.get_device_info()

    status_diid = f"{DreameVacuumPropertyMapping[DreameVacuumProperty.STATUS]['siid']}.{DreameVacuumPropertyMapping[DreameVacuumProperty.STATUS]['piid']}"
    lookback_start = int(time.time()) - 30 * 86400  # last 30 days
    events = proto.get_device_event(status_diid, limit=50, time_start=lookback_start)
    if events is None:
        log.error("get_device_event returned None — possibly a transient cloud error")
        sys.exit(1)

    inserted, dup = upsert_runs(events, secrets["DREAME_DID"])
    log.info("Polled %d events: %d new, %d already-known", len(events), inserted, dup)


if __name__ == "__main__":
    main()
