"""position_solver.py — Fuses CSI presence + BLE RSSI into location estimate.
Simple Kalman-like filter: CSI gives room presence (high confidence),
BLE RSSI gives zone-level within rooms (lower confidence).
"""

import time
from dataclasses import dataclass, field
from typing import Dict, Optional
from protocol import CsiReport, BleReport, BleDevice, PRESENCE_NAMES


@dataclass
class RoomState:
    """State of a single room from its ESP32 node."""
    node_id: int
    room_name: str
    presence: int = 0          # 0=empty, 1=static, 2=moving
    confidence: float = 0.0
    motion_level: int = 0
    rssi: int = 0
    last_update: float = 0.0
    seq: int = 0

    @property
    def stale(self) -> bool:
        return time.time() - self.last_update > 30.0  # 30s = stale


@dataclass
class TrackedDevice:
    """A BLE device being tracked across nodes."""
    addr: str
    name: Optional[str] = None
    is_target: bool = False    # True if this is King Kazuma's phone
    # Per-node RSSI: {node_id: (rssi, timestamp)}
    node_rssi: Dict[int, tuple] = field(default_factory=dict)

    @property
    def best_node(self) -> Optional[int]:
        """Node with strongest RSSI = closest to device."""
        if not self.node_rssi:
            return None
        now = time.time()
        # Filter stale entries (>10s)
        active = {nid: (rssi, ts) for nid, (rssi, ts) in self.node_rssi.items()
                  if now - ts < 10.0}
        if not active:
            return None
        return max(active, key=lambda nid: active[nid][0])


@dataclass
class LocationEstimate:
    """Fused position estimate for a person/device."""
    room: str
    presence: str              # "empty", "static", "moving"
    confidence: float          # 0-100
    method: str                # "csi", "ble", "fused"
    ble_device: Optional[str] = None
    timestamp: float = 0.0

    def to_dict(self):
        return {
            "room": self.room,
            "presence": self.presence,
            "confidence": round(self.confidence, 1),
            "method": self.method,
            "ble_device": self.ble_device,
            "timestamp": self.timestamp,
        }


class PositionSolver:
    """Fuses CSI + BLE data into location estimates."""

    def __init__(self, room_config: Dict[int, str], target_devices: list = None):
        """
        Args:
            room_config: {node_id: room_name} mapping
            target_devices: list of BLE MAC addresses to track (King Kazuma's phone)
        """
        self.room_config = room_config  # {1: "kitchen", 2: "bedroom", 3: "living"}
        self.target_devices = set(d.upper() for d in (target_devices or []))

        # Per-room state from CSI
        self.rooms: Dict[int, RoomState] = {}
        for nid, name in room_config.items():
            self.rooms[nid] = RoomState(node_id=nid, room_name=name)

        # Tracked BLE devices
        self.devices: Dict[str, TrackedDevice] = {}

        # Current position estimate
        self.location: Optional[LocationEstimate] = None

    def update_csi(self, report: CsiReport):
        """Process CSI presence report from a node."""
        room = self.rooms.get(report.node_id)
        if not room:
            return

        room.presence = report.presence
        room.confidence = report.confidence
        room.motion_level = report.motion_level
        room.rssi = report.rssi
        room.seq = report.seq
        room.last_update = time.time()

        self._solve()

    def update_ble(self, report: BleReport):
        """Process BLE sighting report from a node."""
        now = time.time()
        for dev in report.devices:
            addr = dev.addr.upper()
            if addr not in self.devices:
                self.devices[addr] = TrackedDevice(
                    addr=addr,
                    is_target=(addr in self.target_devices),
                )
            self.devices[addr].node_rssi[report.node_id] = (dev.rssi, now)

        self._solve()

    def _solve(self):
        """Fuse CSI + BLE into location estimate."""
        now = time.time()

        # ── CSI: which room has presence? ──
        csi_room = None
        csi_confidence = 0.0
        csi_presence = "empty"

        active_rooms = []
        for nid, room in self.rooms.items():
            if room.stale:
                continue
            if room.presence > 0:  # static or moving
                active_rooms.append(room)

        if len(active_rooms) == 1:
            # Clear winner
            r = active_rooms[0]
            csi_room = r.room_name
            csi_confidence = r.confidence
            csi_presence = PRESENCE_NAMES.get(r.presence, "unknown")
        elif len(active_rooms) > 1:
            # Multiple rooms show presence — pick highest confidence
            best = max(active_rooms, key=lambda r: (r.presence, r.confidence))
            csi_room = best.room_name
            csi_confidence = best.confidence * 0.7  # reduced confidence due to ambiguity
            csi_presence = PRESENCE_NAMES.get(best.presence, "unknown")

        # ── BLE: where is the target device? ──
        ble_room = None
        ble_confidence = 0.0
        ble_addr = None

        for addr, dev in self.devices.items():
            if not dev.is_target:
                continue
            best_node = dev.best_node
            if best_node is not None and best_node in self.room_config:
                ble_room = self.room_config[best_node]
                rssi = dev.node_rssi[best_node][0]
                # RSSI-based confidence: -30 = very close (95%), -80 = far (30%)
                ble_confidence = max(0, min(95, 95 + (rssi + 30) * 1.3))
                ble_addr = addr
                break  # only track first target device

        # ── Fusion ──
        if csi_room and ble_room:
            if csi_room == ble_room:
                # Both agree — high confidence
                self.location = LocationEstimate(
                    room=csi_room,
                    presence=csi_presence,
                    confidence=min(99, csi_confidence * 0.6 + ble_confidence * 0.4),
                    method="fused",
                    ble_device=ble_addr,
                    timestamp=now,
                )
            else:
                # Disagree — trust CSI for presence, BLE for device location
                # CSI wins because it's device-free (detects actual person)
                self.location = LocationEstimate(
                    room=csi_room,
                    presence=csi_presence,
                    confidence=csi_confidence * 0.5,  # reduced — conflicting signals
                    method="csi",
                    ble_device=ble_addr,
                    timestamp=now,
                )
        elif csi_room:
            self.location = LocationEstimate(
                room=csi_room,
                presence=csi_presence,
                confidence=csi_confidence,
                method="csi",
                timestamp=now,
            )
        elif ble_room:
            self.location = LocationEstimate(
                room=ble_room,
                presence="unknown",
                confidence=ble_confidence,
                method="ble",
                ble_device=ble_addr,
                timestamp=now,
            )
        else:
            # No data — keep last known or set to unknown
            if self.location and now - self.location.timestamp > 60:
                self.location = None

    def get_location(self) -> Optional[dict]:
        """Get current location estimate as dict."""
        if self.location:
            return self.location.to_dict()
        return None

    def get_room_states(self) -> list:
        """Get all room states for debugging/display."""
        return [
            {
                "node_id": r.node_id,
                "room": r.room_name,
                "presence": PRESENCE_NAMES.get(r.presence, "unknown"),
                "confidence": r.confidence,
                "motion_level": r.motion_level,
                "rssi": r.rssi,
                "stale": r.stale,
                "last_update": r.last_update,
            }
            for r in self.rooms.values()
        ]
