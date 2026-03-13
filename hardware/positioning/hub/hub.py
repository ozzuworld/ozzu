#!/usr/bin/env python3
"""hub.py — Ozzu Positioning Hub
Runs on Rock Pi 4B. Receives UDP from ESP32 nodes, runs position solver,
pushes updates to Bridge server.

Usage:
    python3 hub.py --config hub.yaml
    python3 hub.py --hub-port 5500 --bridge-url http://10.8.0.1:3333
"""

import argparse
import asyncio
import json
import logging
import signal
import socket
import sys
import time
from urllib.request import Request, urlopen
from urllib.error import URLError

from protocol import parse_packet, CsiReport, BleReport
from position_solver import PositionSolver

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("hub")

# ── Default config ──

DEFAULT_CONFIG = {
    "hub_port": 5500,
    "bridge_url": "http://10.8.0.1:3333",
    "bridge_push_interval": 1.0,  # seconds between bridge updates
    "rooms": {
        1: "kitchen",
        2: "bedroom",
        3: "living",
    },
    "target_devices": [],  # BLE MACs of phones to track
}


class PositioningHub:
    def __init__(self, config: dict):
        self.config = config
        self.solver = PositionSolver(
            room_config=config["rooms"],
            target_devices=config.get("target_devices", []),
        )
        self.running = False
        self._last_push = 0.0
        self._last_location = None
        self._stats = {
            "csi_packets": 0,
            "ble_packets": 0,
            "bridge_pushes": 0,
            "errors": 0,
            "started_at": time.time(),
        }

    def start(self):
        """Start the hub (blocking)."""
        self.running = True
        log.info("Starting positioning hub on port %d", self.config["hub_port"])
        log.info("Rooms: %s", self.config["rooms"])
        log.info("Bridge: %s", self.config["bridge_url"])
        log.info("Target devices: %s", self.config.get("target_devices", []))

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        # Handle shutdown
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, self._shutdown)

        try:
            loop.run_until_complete(self._run())
        except KeyboardInterrupt:
            pass
        finally:
            loop.close()
            log.info("Hub stopped. Stats: %s", json.dumps(self._stats))

    def _shutdown(self):
        log.info("Shutting down...")
        self.running = False

    async def _run(self):
        # Create UDP socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("0.0.0.0", self.config["hub_port"]))
        sock.setblocking(False)

        loop = asyncio.get_event_loop()

        # Start bridge push task
        push_task = asyncio.create_task(self._bridge_push_loop())

        log.info("Listening for ESP32 packets on UDP :%d", self.config["hub_port"])

        while self.running:
            try:
                data, addr = await asyncio.wait_for(
                    loop.run_in_executor(None, lambda: sock.recvfrom(2048)),
                    timeout=1.0,
                )
            except asyncio.TimeoutError:
                continue
            except OSError:
                if not self.running:
                    break
                continue

            self._handle_packet(data, addr)

        push_task.cancel()
        sock.close()

    def _handle_packet(self, data: bytes, addr: tuple):
        """Parse and process a UDP packet."""
        report = parse_packet(data)
        if report is None:
            return

        if isinstance(report, CsiReport):
            self._stats["csi_packets"] += 1
            room_name = self.config["rooms"].get(report.node_id, f"node_{report.node_id}")
            log.debug(
                "CSI node=%d room=%s presence=%s confidence=%d motion=%d",
                report.node_id, room_name, report.presence_name,
                report.confidence, report.motion_level,
            )
            self.solver.update_csi(report)

        elif isinstance(report, BleReport):
            self._stats["ble_packets"] += 1
            log.debug(
                "BLE node=%d devices=%d scan=%dms",
                report.node_id, len(report.devices), report.scan_duration_ms,
            )
            self.solver.update_ble(report)

    async def _bridge_push_loop(self):
        """Periodically push location updates to Bridge."""
        interval = self.config.get("bridge_push_interval", 1.0)

        while self.running:
            await asyncio.sleep(interval)

            location = self.solver.get_location()
            if location is None:
                continue

            # Only push if location changed
            if location == self._last_location:
                continue
            self._last_location = location

            # Push to bridge
            try:
                payload = json.dumps({
                    "type": "positionUpdate",
                    "location": location,
                    "rooms": self.solver.get_room_states(),
                    "stats": self._stats,
                }).encode()

                req = Request(
                    f"{self.config['bridge_url']}/positioning/update",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                urlopen(req, timeout=5)
                self._stats["bridge_pushes"] += 1
                log.info("Location: %s (%s, %.0f%% conf, method=%s)",
                         location["room"], location["presence"],
                         location["confidence"], location["method"])
            except (URLError, OSError) as e:
                self._stats["errors"] += 1
                log.warning("Bridge push failed: %s", e)

    def get_status(self) -> dict:
        return {
            "location": self.solver.get_location(),
            "rooms": self.solver.get_room_states(),
            "stats": self._stats,
        }


def load_config(path: str = None) -> dict:
    """Load config from YAML file, or use defaults."""
    config = dict(DEFAULT_CONFIG)

    if path:
        try:
            import yaml
            with open(path) as f:
                user_config = yaml.safe_load(f)
            if user_config:
                config.update(user_config)
                # Convert room keys to int
                if "rooms" in user_config:
                    config["rooms"] = {int(k): v for k, v in user_config["rooms"].items()}
        except ImportError:
            log.warning("PyYAML not installed — using defaults")
        except FileNotFoundError:
            log.warning("Config file %s not found — using defaults", path)

    return config


def main():
    parser = argparse.ArgumentParser(description="Ozzu Positioning Hub")
    parser.add_argument("--config", type=str, help="Path to hub.yaml config file")
    parser.add_argument("--hub-port", type=int, help="UDP listen port (default: 5500)")
    parser.add_argument("--bridge-url", type=str, help="Bridge server URL")
    args = parser.parse_args()

    config = load_config(args.config)

    if args.hub_port:
        config["hub_port"] = args.hub_port
    if args.bridge_url:
        config["bridge_url"] = args.bridge_url

    hub = PositioningHub(config)
    hub.start()


if __name__ == "__main__":
    main()
