"""position_solver.py — Bayesian room fusion + BLE tracking.
Fuses CSI presence from all nodes using transition probabilities,
temporal decay, and multi-hypothesis tracking.
"""

import time
import math
from collections import deque
from dataclasses import dataclass, field
from typing import Dict, List, Optional
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

    # Bayesian belief: probability someone is in this room
    belief: float = 0.0

    # History for trend detection
    presence_history: deque = field(default_factory=lambda: deque(maxlen=20))

    @property
    def stale(self) -> bool:
        return time.time() - self.last_update > 30.0

    @property
    def trend(self) -> str:
        """Detect if presence is stable, increasing, or decreasing."""
        if len(self.presence_history) < 5:
            return "unknown"
        recent = list(self.presence_history)[-5:]
        older = list(self.presence_history)[:5] if len(self.presence_history) >= 10 else recent
        r_avg = sum(r[0] for r in recent) / len(recent)
        o_avg = sum(r[0] for r in older) / len(older)
        if r_avg > o_avg + 0.3:
            return "increasing"
        elif r_avg < o_avg - 0.3:
            return "decreasing"
        return "stable"


@dataclass
class TrackedDevice:
    """A BLE device being tracked across nodes."""
    addr: str
    name: Optional[str] = None
    is_target: bool = False
    node_rssi: Dict[int, tuple] = field(default_factory=dict)

    @property
    def best_node(self) -> Optional[int]:
        if not self.node_rssi:
            return None
        now = time.time()
        active = {nid: (rssi, ts) for nid, (rssi, ts) in self.node_rssi.items()
                  if now - ts < 10.0}
        if not active:
            return None
        return max(active, key=lambda nid: active[nid][0])


@dataclass
class LocationEstimate:
    """Fused position estimate."""
    room: str
    presence: str
    confidence: float
    method: str
    ble_device: Optional[str] = None
    timestamp: float = 0.0
    all_rooms: dict = field(default_factory=dict)  # room → belief

    def to_dict(self):
        return {
            "room": self.room,
            "presence": self.presence,
            "confidence": round(self.confidence, 1),
            "method": self.method,
            "ble_device": self.ble_device,
            "timestamp": self.timestamp,
            "beliefs": {k: round(v, 2) for k, v in self.all_rooms.items()},
        }


# ── Transition model ──
# Probability of moving from room A to room B in one update cycle.
# Self-transition is high (people usually stay), adjacent rooms get some probability.
# This prevents "teleporting" between rooms on noisy readings.

DEFAULT_SELF_TRANSITION = 0.85      # 85% chance of staying in same room
DEFAULT_NEIGHBOR_TRANSITION = 0.05  # 5% chance per adjacent room


class PositionSolver:
    """Bayesian multi-room fusion with BLE tracking."""

    def __init__(self, room_config: Dict[int, str], target_devices: list = None):
        self.room_config = room_config
        self.target_devices = set(d.upper() for d in (target_devices or []))

        self.rooms: Dict[int, RoomState] = {}
        for nid, name in room_config.items():
            self.rooms[nid] = RoomState(node_id=nid, room_name=name)

        self.devices: Dict[str, TrackedDevice] = {}
        self.location: Optional[LocationEstimate] = None

        # Initialize uniform prior — equal probability for all rooms
        n_rooms = len(room_config)
        if n_rooms > 0:
            uniform = 1.0 / n_rooms
            for room in self.rooms.values():
                room.belief = uniform

        # Activity timeline (last 100 transitions)
        self.timeline: deque = deque(maxlen=100)
        self._last_room = None
        self._last_presence = None

    def update_csi(self, report: CsiReport):
        room = self.rooms.get(report.node_id)
        if not room:
            return

        room.presence = report.presence
        room.confidence = report.confidence
        room.motion_level = report.motion_level
        room.rssi = report.rssi
        room.seq = report.seq
        room.last_update = time.time()
        room.presence_history.append((report.presence, report.confidence, time.time()))

        self._bayesian_update()

    def update_ble(self, report: BleReport):
        now = time.time()
        for dev in report.devices:
            addr = dev.addr.upper()
            if addr not in self.devices:
                self.devices[addr] = TrackedDevice(
                    addr=addr,
                    is_target=(addr in self.target_devices),
                )
            self.devices[addr].node_rssi[report.node_id] = (dev.rssi, now)

        self._bayesian_update()

    def _bayesian_update(self):
        """Full Bayesian update: prior × likelihood × transition."""
        now = time.time()
        n_rooms = len(self.rooms)
        if n_rooms == 0:
            return

        # ── Step 1: Transition prior (prediction step) ──
        # Apply transition model to current beliefs
        new_beliefs = {}
        for nid, room in self.rooms.items():
            # Predicted belief = self_transition × own_belief + neighbor_transition × others
            self_prob = DEFAULT_SELF_TRANSITION * room.belief
            other_prob = 0.0
            for other_nid, other_room in self.rooms.items():
                if other_nid != nid:
                    other_prob += DEFAULT_NEIGHBOR_TRANSITION * other_room.belief
            new_beliefs[nid] = self_prob + other_prob

        # ── Step 2: CSI observation likelihood ──
        # Use RELATIVE motion levels across nodes instead of absolute thresholds.
        # When all nodes report "MOVING", the one with highest motion_level
        # is most likely where the person actually is.
        likelihoods = {}
        
        active_rooms = {nid: r for nid, r in self.rooms.items() if not r.stale}
        
        if len(active_rooms) >= 2:
            motion_levels = {nid: r.motion_level for nid, r in active_rooms.items()}
            max_motion = max(motion_levels.values())
            min_motion = min(motion_levels.values())
            motion_range = max_motion - min_motion
            
            for nid, room in self.rooms.items():
                if room.stale:
                    likelihoods[nid] = 1.0 / n_rooms
                    continue
                
                conf = room.confidence / 100.0
                
                if room.presence == 0:  # EMPTY
                    likelihoods[nid] = 0.1 * (1.0 - conf) + 0.05
                elif motion_range > 3:
                    # Meaningful variation — use relative ranking
                    rel_motion = (room.motion_level - min_motion) / motion_range
                    likelihoods[nid] = 0.2 + 0.7 * rel_motion * conf
                else:
                    # All nodes identical — UNINFORMATIVE (let transition prior hold position)
                    likelihoods[nid] = 1.0
        else:
            for nid, room in self.rooms.items():
                if room.stale:
                    likelihoods[nid] = 1.0 / n_rooms
                    continue
                conf = room.confidence / 100.0
                if room.presence == 2:
                    likelihoods[nid] = 0.5 + 0.5 * conf
                elif room.presence == 1:
                    likelihoods[nid] = 0.3 + 0.4 * conf
                else:
                    likelihoods[nid] = 0.1 * (1.0 - conf) + 0.05

        # ── Step 3: BLE observation (if available) ──
        ble_room_nid = None
        ble_confidence = 0.0
        ble_addr = None

        for addr, dev in self.devices.items():
            if not dev.is_target:
                continue
            best_node = dev.best_node
            if best_node is not None and best_node in self.room_config:
                ble_room_nid = best_node
                rssi = dev.node_rssi[best_node][0]
                ble_confidence = max(0, min(95, 95 + (rssi + 30) * 1.3)) / 100.0
                ble_addr = addr
                break

        if ble_room_nid is not None:
            for nid in likelihoods:
                if nid == ble_room_nid:
                    likelihoods[nid] *= (0.5 + 0.5 * ble_confidence)
                else:
                    likelihoods[nid] *= (0.3 * (1.0 - ble_confidence) + 0.1)

        # ── Step 3.5: Check if CSI is informative ──
        # If all active room likelihoods are 1.0 (can't differentiate) and no BLE,
        # skip update entirely — hold current beliefs to prevent drift to uniform.
        active_likelihoods = [likelihoods[nid] for nid in active_rooms]
        csi_informative = not all(l == 1.0 for l in active_likelihoods) if active_likelihoods else False
        
        if not csi_informative and ble_room_nid is None:
            # No useful data — hold current beliefs, still update location estimate
            posteriors = {nid: room.belief for nid, room in self.rooms.items()}
        else:
            # ── Step 4: Posterior = prior × likelihood, then normalize ──
            posteriors = {}
            for nid in self.rooms:
                posteriors[nid] = new_beliefs.get(nid, 0.0) * likelihoods.get(nid, 1.0)

            total = sum(posteriors.values())
            if total > 0:
                for nid in posteriors:
                    posteriors[nid] /= total
                    self.rooms[nid].belief = posteriors[nid]

        # ── Step 5: Extract location estimate ──
        best_nid = max(posteriors, key=lambda nid: posteriors[nid])
        best_room = self.rooms[best_nid]
        best_belief = posteriors[best_nid]

        # Determine presence from the winning room
        if best_room.stale:
            presence = "unknown"
        else:
            presence = PRESENCE_NAMES.get(best_room.presence, "unknown")

        # Confidence: belief strength × CSI confidence
        confidence = best_belief * 100.0
        if not best_room.stale:
            # Blend with CSI confidence
            confidence = 0.6 * confidence + 0.4 * best_room.confidence

        # Determine method
        method = "bayesian"
        if ble_room_nid is not None:
            method = "bayesian+ble"

        # All room beliefs for debugging
        all_beliefs = {self.rooms[nid].room_name: posteriors[nid] for nid in posteriors}

        self.location = LocationEstimate(
            room=best_room.room_name,
            presence=presence,
            confidence=min(99, confidence),
            method=method,
            ble_device=ble_addr,
            timestamp=now,
            all_rooms=all_beliefs,
        )

        # Track transitions for timeline
        current_room = best_room.room_name
        if current_room != self._last_room or presence != self._last_presence:
            self.timeline.append({
                "time": now,
                "room": current_room,
                "presence": presence,
                "confidence": round(confidence, 1),
                "from_room": self._last_room,
                "method": method,
            })
            self._last_room = current_room
            self._last_presence = presence

    def get_location(self) -> Optional[dict]:
        if self.location:
            return self.location.to_dict()
        return None

    def get_room_states(self) -> list:
        return [
            {
                "node_id": r.node_id,
                "room": r.room_name,
                "presence": PRESENCE_NAMES.get(r.presence, "unknown"),
                "confidence": r.confidence,
                "motion_level": r.motion_level,
                "rssi": r.rssi,
                "belief": round(r.belief, 3),
                "trend": r.trend,
                "stale": r.stale,
                "last_update": r.last_update,
            }
            for r in self.rooms.values()
        ]

    def get_timeline(self, limit: int = 20) -> list:
        """Get recent activity transitions."""
        return list(self.timeline)[-limit:]
