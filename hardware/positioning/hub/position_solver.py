"""position_solver.py — EKF-enhanced Bayesian room fusion + BLE tracking.
Fuses CSI presence from all nodes using:
  1. Per-sensor Kalman filters (smooth noisy CSI motion levels)
  2. Bayesian room likelihood computation
  3. Belief-state EKF (smooth room probability transitions)
  4. Innovation gating (reject outlier measurements)
"""

import time
import math
from collections import deque
from dataclasses import dataclass, field
from typing import Dict, List, Optional
from protocol import CsiReport, BleReport, BleDevice, PRESENCE_NAMES


# ── 1D Kalman Filter for sensor smoothing ──

class KalmanFilter1D:
    """Simple 1D Kalman filter for smoothing a single sensor value."""

    def __init__(self, process_noise: float = 1.0, measurement_noise: float = 5.0,
                 initial_estimate: float = 0.0, initial_covariance: float = 100.0):
        self.x = initial_estimate       # state estimate
        self.P = initial_covariance     # estimate covariance
        self.Q = process_noise          # process noise
        self.R = measurement_noise      # measurement noise

    def update(self, measurement: float) -> float:
        # Predict
        x_pred = self.x
        P_pred = self.P + self.Q

        # Update
        K = P_pred / (P_pred + self.R)  # Kalman gain
        self.x = x_pred + K * (measurement - x_pred)
        self.P = (1 - K) * P_pred

        return self.x

    @property
    def innovation_variance(self) -> float:
        """S = P + R — used for innovation gating."""
        return self.P + self.R


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

    # EKF state — per-sensor Kalman filters
    motion_kf: KalmanFilter1D = field(default_factory=lambda: KalmanFilter1D(
        process_noise=2.0, measurement_noise=8.0
    ))
    confidence_kf: KalmanFilter1D = field(default_factory=lambda: KalmanFilter1D(
        process_noise=1.0, measurement_noise=5.0, initial_estimate=50.0
    ))

    # Smoothed values (output of Kalman filters)
    smooth_motion: float = 0.0
    smooth_confidence: float = 50.0

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
    # Per-node RSSI Kalman filters
    rssi_kf: Dict[int, KalmanFilter1D] = field(default_factory=dict)

    def get_smoothed_rssi(self, node_id: int, raw_rssi: int) -> float:
        """Get Kalman-smoothed RSSI for a specific node."""
        if node_id not in self.rssi_kf:
            self.rssi_kf[node_id] = KalmanFilter1D(
                process_noise=1.0, measurement_noise=4.0,
                initial_estimate=raw_rssi, initial_covariance=20.0
            )
        return self.rssi_kf[node_id].update(float(raw_rssi))

    @property
    def best_node(self) -> Optional[int]:
        if not self.node_rssi:
            return None
        now = time.time()
        active = {nid: (rssi, ts) for nid, (rssi, ts) in self.node_rssi.items()
                  if now - ts < 10.0}
        if not active:
            return None
        # Use smoothed RSSI if available, otherwise raw
        def get_rssi(nid):
            if nid in self.rssi_kf:
                return self.rssi_kf[nid].x
            return active[nid][0]
        return max(active, key=get_rssi)


@dataclass
class LocationEstimate:
    """Fused position estimate."""
    room: str
    presence: str
    confidence: float
    method: str
    ble_device: Optional[str] = None
    timestamp: float = 0.0
    all_rooms: dict = field(default_factory=dict)

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
DEFAULT_SELF_TRANSITION = 0.92
DEFAULT_NEIGHBOR_TRANSITION = 0.025

# ── EKF belief parameters ──
EKF_PROCESS_NOISE = 0.008       # How fast beliefs can change per step
EKF_MIN_MEASUREMENT_NOISE = 0.03  # Minimum observation noise
EKF_INNOVATION_GATE = 4.0       # Reject updates > 4σ from prediction
EKF_OBSERVATION_TEMP = 0.4      # Sharpen observation distribution (lower = peakier)


class BeliefEKF:
    """EKF operating on the room belief vector.

    State: x = [belief_room1, belief_room2, ..., belief_roomN]
    Process: x_k = transition_matrix @ x_{k-1} + noise
    Measurement: z_k = likelihood-weighted observation

    The key improvement over raw Bayesian: adaptive Kalman gain
    automatically balances observation trust vs prediction trust.
    When sensors are noisy (high R), gain is low → trust prediction.
    When sensors agree (low R), gain is high → trust observation.
    """

    def __init__(self, n_rooms: int):
        self.n = n_rooms
        # State: belief per room
        self.x = [1.0 / n_rooms] * n_rooms
        # Covariance: start high for fast initial convergence
        self.P = [0.5] * n_rooms
        # Process noise (annealed: starts high, decays to steady state)
        self.Q = EKF_PROCESS_NOISE
        self._update_count = 0
        self._anneal_steps = 30  # fast convergence for first 30 updates

    def predict(self, transition_beliefs: list):
        """Prediction step using transition model output."""
        self._update_count += 1
        # Annealed process noise: 10x during warmup, decay to steady state
        if self._update_count < self._anneal_steps:
            q = EKF_PROCESS_NOISE * 10.0 * (1.0 - self._update_count / self._anneal_steps) + EKF_PROCESS_NOISE
        else:
            q = EKF_PROCESS_NOISE
        for i in range(self.n):
            self.x[i] = transition_beliefs[i]
            self.P[i] = self.P[i] + q

    def update(self, observation: list, measurement_noise: list) -> list:
        """Update step with observation likelihoods.

        observation: normalized likelihood per room (what sensors say)
        measurement_noise: per-room R values (higher = less trust)
        Returns: updated beliefs
        """
        updated = list(self.x)

        for i in range(self.n):
            # Innovation: difference between observation and prediction
            innovation = observation[i] - self.x[i]

            # Innovation variance
            S = self.P[i] + measurement_noise[i]

            # Innovation gating — reject wild outliers
            if S > 0 and (innovation * innovation) / S > EKF_INNOVATION_GATE * EKF_INNOVATION_GATE:
                # Outlier — don't update this room's belief
                continue

            # Kalman gain
            K = self.P[i] / S if S > 0 else 0.0

            # State update
            updated[i] = self.x[i] + K * innovation

            # Covariance update
            self.P[i] = (1.0 - K) * self.P[i]

        # Normalize to valid probability distribution
        total = sum(max(0, v) for v in updated)
        if total > 0:
            self.x = [max(0, v) / total for v in updated]

        return list(self.x)

    def get_confidence(self) -> float:
        """Confidence from covariance — low P = high confidence."""
        avg_P = sum(self.P) / self.n
        # Map uncertainty to confidence: P=0 → 99%, P=0.5 → 50%, P=1.0 → 10%
        return max(10, min(99, 99 * math.exp(-3.0 * avg_P)))


class PositionSolver:
    """EKF-enhanced Bayesian multi-room fusion with BLE tracking."""

    def __init__(self, room_config: Dict[int, str], target_devices: list = None):
        self.room_config = room_config
        self.target_devices = set(d.upper() for d in (target_devices or []))

        self.rooms: Dict[int, RoomState] = {}
        self.room_index: Dict[int, int] = {}  # node_id → index in EKF state
        for i, (nid, name) in enumerate(room_config.items()):
            self.rooms[nid] = RoomState(node_id=nid, room_name=name)
            self.room_index[nid] = i

        self.devices: Dict[str, TrackedDevice] = {}
        self.location: Optional[LocationEstimate] = None

        # Initialize beliefs
        n_rooms = len(room_config)
        if n_rooms > 0:
            uniform = 1.0 / n_rooms
            for room in self.rooms.values():
                room.belief = uniform

        # EKF for belief state
        self.ekf = BeliefEKF(n_rooms) if n_rooms > 0 else None

        # Activity timeline
        self.timeline: deque = deque(maxlen=100)
        self._last_room = None
        self._last_presence = None

    def update_csi(self, report: CsiReport):
        room = self.rooms.get(report.node_id)
        if not room:
            return

        # Raw sensor update
        room.presence = report.presence
        room.confidence = report.confidence
        room.motion_level = report.motion_level
        room.rssi = report.rssi
        room.seq = report.seq
        room.last_update = time.time()
        room.presence_history.append((report.presence, report.confidence, time.time()))

        # Kalman-filter the sensor readings
        room.smooth_motion = room.motion_kf.update(float(report.motion_level))
        room.smooth_confidence = room.confidence_kf.update(float(report.confidence))

        self._ekf_update()

    def update_ble(self, report: BleReport):
        now = time.time()
        for dev in report.devices:
            addr = dev.addr.upper()
            if addr not in self.devices:
                self.devices[addr] = TrackedDevice(
                    addr=addr,
                    is_target=(addr in self.target_devices),
                )
            tracked = self.devices[addr]
            # Kalman-smooth BLE RSSI
            smoothed_rssi = tracked.get_smoothed_rssi(report.node_id, dev.rssi)
            tracked.node_rssi[report.node_id] = (smoothed_rssi, now)

        self._ekf_update()

    def _ekf_update(self):
        """EKF-enhanced Bayesian update."""
        now = time.time()
        n_rooms = len(self.rooms)
        if n_rooms == 0 or self.ekf is None:
            return

        nids = list(self.rooms.keys())

        # ── Step 1: Transition prediction ──
        transition_beliefs = []
        for nid in nids:
            room = self.rooms[nid]
            self_prob = DEFAULT_SELF_TRANSITION * room.belief
            other_prob = sum(
                DEFAULT_NEIGHBOR_TRANSITION * self.rooms[other_nid].belief
                for other_nid in nids if other_nid != nid
            )
            transition_beliefs.append(self_prob + other_prob)

        self.ekf.predict(transition_beliefs)

        # ── Step 2: CSI observation (using smoothed values) ──
        active_rooms = {nid: r for nid, r in self.rooms.items() if not r.stale}
        likelihoods = {}
        measurement_noise = {}

        if len(active_rooms) >= 2:
            # Use Kalman-smoothed motion levels for comparison
            smooth_motions = {nid: r.smooth_motion for nid, r in active_rooms.items()}
            max_motion = max(smooth_motions.values())
            min_motion = min(smooth_motions.values())
            motion_range = max_motion - min_motion

            for nid in nids:
                room = self.rooms[nid]
                if room.stale:
                    likelihoods[nid] = 0.02  # push stale rooms toward 0
                    measurement_noise[nid] = 0.3  # moderate noise — decay slowly
                    continue

                conf = room.smooth_confidence / 100.0
                # Measurement noise inversely proportional to confidence
                measurement_noise[nid] = max(EKF_MIN_MEASUREMENT_NOISE, 0.5 * (1.0 - conf))

                if room.presence == 0:  # EMPTY
                    likelihoods[nid] = 0.1 * (1.0 - conf) + 0.05
                elif motion_range > 3:
                    rel_motion = (room.smooth_motion - min_motion) / motion_range
                    likelihoods[nid] = 0.2 + 0.7 * rel_motion * conf
                else:
                    likelihoods[nid] = 1.0  # uninformative
                    measurement_noise[nid] = 1.0  # high noise
        else:
            for nid in nids:
                room = self.rooms[nid]
                if room.stale:
                    likelihoods[nid] = 0.02
                    measurement_noise[nid] = 0.3
                    continue
                conf = room.smooth_confidence / 100.0
                measurement_noise[nid] = max(EKF_MIN_MEASUREMENT_NOISE, 0.5 * (1.0 - conf))
                if room.presence == 2:
                    likelihoods[nid] = 0.5 + 0.5 * conf
                elif room.presence == 1:
                    likelihoods[nid] = 0.3 + 0.4 * conf
                else:
                    likelihoods[nid] = 0.1 * (1.0 - conf) + 0.05

        # ── Step 3: BLE observation ──
        ble_room_nid = None
        ble_confidence = 0.0
        ble_addr = None

        for addr, dev in self.devices.items():
            if not dev.is_target:
                continue
            best_node = dev.best_node
            if best_node is not None and best_node in self.room_config:
                ble_room_nid = best_node
                # Use smoothed RSSI
                rssi = dev.rssi_kf[best_node].x if best_node in dev.rssi_kf else dev.node_rssi[best_node][0]
                ble_confidence = max(0, min(95, 95 + (rssi + 30) * 1.3)) / 100.0
                ble_addr = addr
                break

        if ble_room_nid is not None:
            for nid in likelihoods:
                if nid == ble_room_nid:
                    likelihoods[nid] *= (0.5 + 0.5 * ble_confidence)
                    measurement_noise[nid] *= 0.5  # BLE reduces uncertainty
                else:
                    likelihoods[nid] *= (0.3 * (1.0 - ble_confidence) + 0.1)

        # ── Step 4: Check if informative ──
        active_likelihoods = [likelihoods.get(nid, 1.0) for nid in active_rooms]
        csi_informative = not all(l == 1.0 for l in active_likelihoods) if active_likelihoods else False

        if not csi_informative and ble_room_nid is None:
            # No useful CSI — apply prediction only (transition model decays naturally)
            posteriors = {}
            for i, nid in enumerate(nids):
                posteriors[nid] = self.ekf.x[i]
                self.rooms[nid].belief = self.ekf.x[i]
        else:
            # Softmax-sharpen likelihoods to create peaked observation vector
            # Temperature < 1 makes the distribution peakier (more decisive)
            lk_values = [likelihoods.get(nid, 1.0 / n_rooms) for nid in nids]
            # Apply softmax with temperature: exp(log(lk) / T) = lk^(1/T)
            sharpened = [max(v, 1e-8) ** (1.0 / EKF_OBSERVATION_TEMP) for v in lk_values]
            sh_total = sum(sharpened)
            if sh_total > 0:
                observation = [v / sh_total for v in sharpened]
            else:
                observation = [1.0 / n_rooms] * n_rooms

            noise = [measurement_noise.get(nid, 0.5) for nid in nids]

            # EKF update
            beliefs = self.ekf.update(observation, noise)

            posteriors = {}
            for i, nid in enumerate(nids):
                posteriors[nid] = beliefs[i]
                self.rooms[nid].belief = beliefs[i]

        # ── Step 5: Extract location estimate ──
        best_nid = max(posteriors, key=lambda nid: posteriors[nid])
        best_room = self.rooms[best_nid]
        best_belief = posteriors[best_nid]

        if best_room.stale:
            presence = "unknown"
        else:
            presence = PRESENCE_NAMES.get(best_room.presence, "unknown")

        # Confidence: blend EKF confidence with belief strength
        ekf_conf = self.ekf.get_confidence()
        belief_conf = best_belief * 100.0
        confidence = 0.4 * ekf_conf + 0.4 * belief_conf + 0.2 * best_room.smooth_confidence

        method = "ekf"
        if ble_room_nid is not None:
            method = "ekf+ble"

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

        # Track transitions
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
                "smooth_motion": round(r.smooth_motion, 1),
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
