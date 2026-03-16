"""floor_plan.py — Floor plan geometry from LiDAR scan.
Provides wall segments, room polygons, ESP32 node positions,
and signal attenuation modeling for coordinate-based positioning.
"""

import math
from typing import List, Tuple, Optional

# ── ESP32 node positions (from LiDAR scan, in meters) ──
# Coordinate system: X = east, Z = south (matching GLB)
NODE_POSITIONS = {
    1: (2.50, -4.00),    # Living room
    2: (1.00, 4.50),     # Master bedroom
    3: (-1.80, 4.50),    # Office / Piano room
}

# ── Wall segments extracted from LiDAR GLB ──
# Each wall is (type, fixed_coord, start, end)
# "ns" = runs north-south: fixed X, varies Z
# "ew" = runs east-west: fixed Z, varies X
WALL_SEGMENTS = [
    # Outer walls
    ("ns", -4.388, -5.513, 5.436),   # West exterior
    ("ns", 3.628, -5.076, -0.672),    # East wall (living)
    ("ns", 4.336, -0.691, 0.965),     # East wall (bathroom)
    ("ns", 3.849, 0.918, 4.663),      # East wall (master)
    ("ew", -5.446, -0.948, 3.245),    # South exterior (living)
    ("ew", -5.513, -4.388, -2.707),   # South exterior (pantry)
    ("ew", 5.436, -4.388, -2.023),    # North exterior (empty/kitchen)
    ("ew", 5.401, -0.570, 0.798),     # North exterior (office/master)
    ("ew", 5.401, 0.798, 2.156),      # North exterior (master)
    ("ew", 4.663, 2.156, 3.849),      # North-east exterior

    # Interior walls
    ("ew", -3.822, -4.288, -0.948),   # Pantry-living divider
    ("ns", -0.948, -5.446, -3.822),   # Pantry-living divider (vertical)
    ("ew", -0.642, -2.625, -0.085),   # Living-hallway divider
    ("ew", -0.597, 0.013, 3.628),     # Hallway-bathroom-master south wall
    ("ns", 0.748, -0.497, 5.301),     # Office-master divider
    ("ns", -2.123, 0.682, 5.336),     # Empty-office divider
    ("ns", -2.625, -0.642, 1.213),    # Kitchen-hallway divider
    ("ew", 1.213, -4.288, -2.625),    # Kitchen-empty divider
    ("ew", 0.682, -2.625, -0.209),    # Kitchen-hallway top
    ("ns", 1.969, -0.497, 0.732),     # Bathroom west wall
    ("ew", 0.732, 1.969, 3.582),      # Bathroom north wall
]

# ── Room definitions with bounding boxes ──
ROOMS = {
    "living":  {"bounds": ((-2.68, -5.40), (3.57, -0.55)), "center": (0.45, -2.97)},
    "master":  {"bounds": ((0.80, -0.55), (3.80, 5.35)),   "center": (2.30, 2.40)},
    "office":  {"bounds": ((-2.07, -0.55), (0.80, 5.35)),  "center": (-0.64, 2.40)},
    "empty":   {"bounds": ((-4.34, 0.64), (-2.08, 5.39)),  "center": (-3.21, 3.01)},
    "kitchen": {"bounds": ((-4.34, -3.77), (-2.68, 1.16)), "center": (-3.51, -1.30)},
    "pantry":  {"bounds": ((-4.34, -5.47), (-0.90, -3.78)),"center": (-2.62, -4.62)},
    "hallway": {"bounds": ((-2.68, -0.69), (0.07, 0.63)),  "center": (-1.32, -0.03)},
    "bathroom":{"bounds": ((1.91, -0.80), (4.38, 1.03)),   "center": (3.15, 0.12)},
}

# ── Furniture positions for context ──
FURNITURE = {
    "living": [
        {"type": "couch", "center": (1.93, -4.60), "radius": 1.0},
        {"type": "table", "center": (1.15, -3.33), "radius": 0.5},
    ],
    "master": [
        {"type": "bed", "center": (2.79, 2.80), "radius": 0.9},
    ],
    "office": [
        {"type": "desk", "center": (-1.62, 1.44), "radius": 0.6},
        {"type": "piano", "center": (-0.07, 2.60), "radius": 0.5},
    ],
}

# ── Signal attenuation constants ──
WALL_ATTENUATION_DB = 3.5     # dB loss per wall crossing (interior walls)
PATH_LOSS_EXPONENT = 3.0      # indoor path loss exponent (3.0 = typical indoor w/ walls)
RSSI_AT_1M = -65              # calibrated from live readings: -80dBm at ~2m = RSSI_1m ≈ -65
# With -65 and n=3.0: -75 → 2.2m, -80 → 3.2m, -85 → 4.6m, -95 → 10m


def _segments_intersect(p1: Tuple, p2: Tuple, p3: Tuple, p4: Tuple) -> bool:
    """Check if line segment p1-p2 intersects p3-p4."""
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    d1 = cross(p3, p4, p1)
    d2 = cross(p3, p4, p2)
    d3 = cross(p1, p2, p3)
    d4 = cross(p1, p2, p4)

    if ((d1 > 0 and d2 < 0) or (d1 < 0 and d2 > 0)) and \
       ((d3 > 0 and d4 < 0) or (d3 < 0 and d4 > 0)):
        return True

    # Collinear cases (on segment)
    if d1 == 0 and _on_segment(p3, p4, p1): return True
    if d2 == 0 and _on_segment(p3, p4, p2): return True
    if d3 == 0 and _on_segment(p1, p2, p3): return True
    if d4 == 0 and _on_segment(p1, p2, p4): return True

    return False


def _on_segment(p, q, r):
    """Check if r is on segment p-q."""
    return (min(p[0], q[0]) <= r[0] <= max(p[0], q[0]) and
            min(p[1], q[1]) <= r[1] <= max(p[1], q[1]))


def count_walls_between(p1: Tuple[float, float], p2: Tuple[float, float]) -> int:
    """Count how many wall segments the line from p1 to p2 crosses."""
    count = 0
    for wall in WALL_SEGMENTS:
        wtype, fixed, start, end = wall
        if wtype == "ns":
            # Vertical wall at x=fixed, from z=start to z=end
            w_start = (fixed, start)
            w_end = (fixed, end)
        else:
            # Horizontal wall at z=fixed, from x=start to x=end
            w_start = (start, fixed)
            w_end = (end, fixed)

        if _segments_intersect(p1, p2, w_start, w_end):
            count += 1
    return count


def rssi_to_distance(rssi: float, wall_count: int = 0) -> float:
    """Convert RSSI to estimated distance in meters, accounting for wall attenuation.

    Uses log-distance path loss model:
      RSSI = RSSI_1m - 10 * n * log10(d) - wall_count * wall_attenuation

    Solving for d:
      d = 10 ^ ((RSSI_1m - RSSI - wall_count * wall_att) / (10 * n))
    """
    corrected_rssi = rssi + wall_count * WALL_ATTENUATION_DB
    if corrected_rssi >= RSSI_AT_1M:
        return 0.3  # very close, floor at 30cm

    exponent = (RSSI_AT_1M - corrected_rssi) / (10.0 * PATH_LOSS_EXPONENT)
    distance = 10.0 ** exponent

    # Clamp to reasonable indoor range
    return min(distance, 20.0)


def trilaterate(measurements: List[Tuple[Tuple[float, float], float]]) -> Optional[Tuple[float, float]]:
    """Weighted least-squares trilateration from (position, distance) pairs.

    measurements: list of ((x, z), distance) for each node
    Returns: estimated (x, z) position or None if insufficient data.
    """
    if len(measurements) < 2:
        if len(measurements) == 1:
            return measurements[0][0]  # only one node, use its position
        return None

    if len(measurements) == 2:
        # Two nodes: weighted average along the line between them
        (p1, d1), (p2, d2) = measurements
        total = d1 + d2
        if total < 0.01:
            return ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
        # Weight inversely by distance (closer node gets more weight)
        w1 = 1.0 / max(d1, 0.1)
        w2 = 1.0 / max(d2, 0.1)
        wt = w1 + w2
        x = (p1[0] * w1 + p2[0] * w2) / wt
        z = (p1[1] * w1 + p2[1] * w2) / wt
        return (x, z)

    # 3+ nodes: linearized least squares
    # Reference: convert circle equations to linear system
    # (x-x1)² + (z-z1)² = d1²  →  expand and subtract pairs
    ref = measurements[0]
    A = []
    b = []
    for i in range(1, len(measurements)):
        xi, zi = measurements[i][0]
        di = measurements[i][1]
        x1, z1 = ref[0]
        d1 = ref[1]

        # 2*(xi-x1)*x + 2*(zi-z1)*z = d1²-di² + xi²-x1² + zi²-z1²
        A.append([2 * (xi - x1), 2 * (zi - z1)])
        b.append(d1**2 - di**2 + xi**2 - x1**2 + zi**2 - z1**2)

    # Solve Ax = b using normal equations: x = (A'A)^-1 A'b
    # For 2x2 this is straightforward
    n = len(A)
    # A'A
    ata = [[0, 0], [0, 0]]
    atb = [0, 0]
    for i in range(n):
        # Weight by inverse distance (closer measurements more reliable)
        w = 1.0 / max(measurements[i + 1][1], 0.3)
        ata[0][0] += A[i][0] * A[i][0] * w
        ata[0][1] += A[i][0] * A[i][1] * w
        ata[1][0] += A[i][1] * A[i][0] * w
        ata[1][1] += A[i][1] * A[i][1] * w
        atb[0] += A[i][0] * b[i] * w
        atb[1] += A[i][1] * b[i] * w

    det = ata[0][0] * ata[1][1] - ata[0][1] * ata[1][0]
    if abs(det) < 1e-10:
        # Degenerate — fall back to weighted average
        total_w = 0
        x, z = 0.0, 0.0
        for pos, d in measurements:
            w = 1.0 / max(d, 0.1)
            x += pos[0] * w
            z += pos[1] * w
            total_w += w
        return (x / total_w, z / total_w)

    x = (ata[1][1] * atb[0] - ata[0][1] * atb[1]) / det
    z = (ata[0][0] * atb[1] - ata[1][0] * atb[0]) / det

    return (x, z)


def point_in_room(x: float, z: float) -> str:
    """Determine which room a point (x, z) is in."""
    for room_id, info in ROOMS.items():
        (x1, z1), (x2, z2) = info["bounds"]
        if x1 <= x <= x2 and z1 <= z <= z2:
            return room_id
    # Not in any room — find closest
    best_room = "living"
    best_dist = float("inf")
    for room_id, info in ROOMS.items():
        cx, cz = info["center"]
        d = math.sqrt((x - cx) ** 2 + (z - cz) ** 2)
        if d < best_dist:
            best_dist = d
            best_room = room_id
    return best_room


def nearest_furniture(x: float, z: float, room_id: str) -> Optional[str]:
    """Find nearest furniture item within radius, or None."""
    items = FURNITURE.get(room_id, [])
    for item in items:
        cx, cz = item["center"]
        dist = math.sqrt((x - cx) ** 2 + (z - cz) ** 2)
        if dist <= item["radius"]:
            return item["type"]
    return None
