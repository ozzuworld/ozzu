#!/usr/bin/env python3
"""Send control actions to Dusk Vader via Dreame cloud.

Subcommands:
  start  — begin a cleaning task (siid=2, aiid=1)
  pause  — pause current cleaning (siid=2, aiid=2)
  dock   — return to charging dock (siid=3, aiid=1)

Auth + creds: shared with vacuum-status-poll.py via /root/.ozzu-secrets.
Logs to /home/gcp/ozzu/logs/vacuum.log (same file as the poller).

Exit codes: 0 = cloud accepted (code 0), 1 = auth failed, 2 = cloud rejected, 3 = bad usage.
"""
import os
import sys
import json
import shlex
import logging
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR / "lib"))

from dreame import DreameVacuumDreameHomeCloudProtocol

LOG_PATH = Path("/home/gcp/ozzu/logs/vacuum.log")
LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    filename=str(LOG_PATH),
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("vacuum-ctl")

ACTIONS = {
    "start": (2, 1),   # DreameVacuumAction.START
    "pause": (2, 2),   # DreameVacuumAction.PAUSE
    "dock":  (3, 1),   # DreameVacuumAction.CHARGE
}


def load_secrets(path="/root/.ozzu-secrets"):
    out = {}
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        try:
            parts = shlex.split(v)
            out[k.strip()] = parts[0] if parts else ""
        except ValueError:
            out[k.strip()] = v
    return out


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ACTIONS:
        print(f"usage: {sys.argv[0]} {{{'|'.join(ACTIONS)}}}", file=sys.stderr)
        sys.exit(3)

    action = sys.argv[1]
    siid, aiid = ACTIONS[action]

    secrets = load_secrets()
    proto = DreameVacuumDreameHomeCloudProtocol(
        username=secrets["DREAME_USERNAME"],
        password=secrets["DREAME_PASSWORD"],
        account_type=secrets["DREAME_ACCOUNT_TYPE"],
        country=secrets["DREAME_COUNTRY"],
        auth_key=secrets["DREAME_AUTH_KEY"],
        did=secrets["DREAME_DID"],
    )
    if not proto.login():
        log.error("vacuum %s: cloud login failed", action)
        print("login failed", file=sys.stderr)
        sys.exit(1)

    proto.get_device_info()  # populates _uid

    result = proto.send("action", {
        "did": secrets["DREAME_DID"],
        "siid": siid, "aiid": aiid, "in": [],
    })

    if result is None:
        log.error("vacuum %s: send returned None (cloud error)", action)
        print("cloud rejected", file=sys.stderr)
        sys.exit(2)

    code = result.get("code") if isinstance(result, dict) else None
    if code == 0:
        log.info("vacuum %s: accepted (siid=%s aiid=%s)", action, siid, aiid)
        print(f"ok: {action} accepted")
        sys.exit(0)
    else:
        log.error("vacuum %s: cloud returned non-zero code: %s", action, json.dumps(result, default=str)[:300])
        print(f"cloud returned code={code}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
