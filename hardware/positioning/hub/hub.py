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
import os
import signal
import socket
import struct
import sys
import time
from urllib.request import Request, urlopen
from urllib.error import URLError

from protocol import (parse_packet, CsiReport, BleReport, IrkReport,
                      MAGIC_IRK, IRK_HDR_SIZE, IRK_ENTRY_SIZE,
                      IRK_ACTION_REPORT, IRK_ACTION_SYNC)
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
        self.running = False
        self._last_push = 0.0
        self._last_location = None
        self._node_addrs = {}   # node_id → (ip, port) from last packet
        self._irk_store = []    # list of {irk, addr, addr_type, label, node_id}
        self._irk_file = os.path.join(os.path.dirname(__file__), "irk_store.json")
        self._load_irks()
        self.solver = PositionSolver(
            room_config=config["rooms"],
            target_devices=config.get("target_devices", []),
            irk_store=self._irk_store,
        )
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

    def _load_irks(self):
        """Load stored IRKs from disk."""
        try:
            if os.path.exists(self._irk_file):
                with open(self._irk_file) as f:
                    self._irk_store = json.load(f)
                log.info("Loaded %d IRKs from %s", len(self._irk_store), self._irk_file)
                # Add IRK identity addresses as target devices
                for irk_entry in self._irk_store:
                    addr = irk_entry["addr"]
                    if addr not in self.solver.target_devices:
                        self.solver.target_devices.add(addr.upper())
                        log.info("Auto-tracking IRK device: %s (%s)", addr, irk_entry.get("label", ""))
        except Exception as e:
            log.warning("Failed to load IRKs: %s", e)

    def _save_irks(self):
        """Persist IRKs to disk."""
        try:
            with open(self._irk_file, "w") as f:
                json.dump(self._irk_store, f, indent=2)
            log.info("Saved %d IRKs to %s", len(self._irk_store), self._irk_file)
        except Exception as e:
            log.warning("Failed to save IRKs: %s", e)

    def _distribute_irk(self, irk_entry: dict, exclude_node: int = None):
        """Send an IRK to all known nodes (except the one that sent it)."""
        # Build IRK sync packet
        irk_bytes = bytes.fromhex(irk_entry["irk_hex"])
        # Reverse address to BLE byte order (little-endian) for ESP32
        addr_bytes = bytes(reversed([int(x, 16) for x in irk_entry["addr"].split(":")]))
        label_bytes = irk_entry.get("label", "phone").encode("utf-8")[:16].ljust(16, b"\x00")

        header = struct.pack("<IBBBB",
                             MAGIC_IRK,
                             0,  # node_id=0 (from hub)
                             IRK_ACTION_SYNC,
                             1,  # 1 IRK
                             0)  # reserved
        entry = irk_bytes + addr_bytes + struct.pack("BB", irk_entry.get("addr_type", 0), 0) + label_bytes
        packet = header + entry

        # Send to all known node addresses on command port (5502)
        cmd_port = 5502
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        for node_id, (ip, _) in self._node_addrs.items():
            if node_id == exclude_node:
                continue
            try:
                sock.sendto(packet, (ip, cmd_port))
                log.info("Synced IRK '%s' to node %d (%s)", irk_entry.get("label", ""), node_id, ip)
            except OSError as e:
                log.warning("Failed to sync IRK to node %d: %s", node_id, e)
        sock.close()

    def _handle_irk(self, report: IrkReport, addr: tuple):
        """Handle an IRK report from a node."""
        for entry in report.entries:
            irk_hex = entry.irk.hex()

            # Check if we already have this IRK
            existing = next((e for e in self._irk_store if e["irk_hex"] == irk_hex), None)
            if existing:
                log.info("IRK already known: %s (%s)", entry.addr, entry.label)
                continue

            irk_data = {
                "irk_hex": irk_hex,
                "addr": entry.addr,
                "addr_type": entry.addr_type,
                "label": entry.label,
                "source_node": report.node_id,
                "added_at": time.time(),
            }
            self._irk_store.append(irk_data)
            log.info("NEW IRK enrolled: %s → %s (from node %d)",
                     entry.label, entry.addr, report.node_id)

            # Auto-add as target device for tracking
            self.solver.target_devices.add(entry.addr.upper())

            # Save to disk
            self._save_irks()

            # Distribute to all other nodes
            self._distribute_irk(irk_data, exclude_node=report.node_id)

    def trigger_pair_mode(self, node_id: int = None, timeout: int = 60):
        """Send PAIR command to a specific node or broadcast to all."""
        cmd = struct.pack("<IH", 0x50414952, timeout)  # "PAIR" + timeout
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

        if node_id and node_id in self._node_addrs:
            ip, _ = self._node_addrs[node_id]
            sock.sendto(cmd, (ip, 5502))
            log.info("Sent PAIR command to node %d (%s), timeout=%ds", node_id, ip, timeout)
        else:
            # Broadcast
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            sock.sendto(cmd, ("10.0.50.255", 5502))
            log.info("Broadcast PAIR command to all nodes, timeout=%ds", timeout)

        sock.close()

    def _handle_packet(self, data: bytes, addr: tuple):
        """Parse and process a UDP packet."""
        report = parse_packet(data)
        if report is None:
            return

        # Track node addresses for IRK distribution
        if hasattr(report, "node_id"):
            is_new_node = report.node_id not in self._node_addrs
            self._node_addrs[report.node_id] = addr
            # When we discover a new node, push all stored IRKs to it
            if is_new_node and self._irk_store:
                log.info("New node %d at %s — distributing %d stored IRKs",
                         report.node_id, addr[0], len(self._irk_store))
                for irk_entry in self._irk_store:
                    self._distribute_irk(irk_entry)

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

        elif isinstance(report, IrkReport):
            self._stats.setdefault("irk_packets", 0)
            self._stats["irk_packets"] += 1
            self._handle_irk(report, addr)

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
                    "irk_count": len(self._irk_store),
                    "tracked_devices": [e.get("label", e["addr"]) for e in self._irk_store],
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
