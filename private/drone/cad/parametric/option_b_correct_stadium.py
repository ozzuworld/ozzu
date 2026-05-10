"""
Option B v2: Take the original Painless360 STL, REPLACE the inner stadium pocket
with a correctly-sized one for King Kazuma's clone SG90.

Why prior 4 versions failed:
  Prior boolean subtracts cut slabs OUTSIDE the original stadium pocket.
  The 14.78 × 11.01 stadium itself was bit-identical across all versions.
  Servo never fit because the actual constraint was unchanged.

This script uses manifold3d directly (more lenient than trimesh.boolean about
"watertightness" — the original Painless360 STL has open edges trimesh flags
but manifold3d still operates on it cleanly).
"""
import trimesh
import numpy as np
import manifold3d
from build123d import *

# --- King Kazuma's clone SG90 ---
SERVO_BODY_LEN = 24.0
SERVO_BODY_WID = 11.8
CLR_PER_SIDE   = 0.4

TARGET_POCKET_LEN = SERVO_BODY_LEN + 2 * CLR_PER_SIDE  # 24.8
TARGET_POCKET_WID = SERVO_BODY_WID + 2 * CLR_PER_SIDE  # 12.6

print(f"=== Target pocket dimensions ===")
print(f"  {TARGET_POCKET_LEN} × {TARGET_POCKET_WID} mm  (was 14.78 × 11.01 in original)")

# === STEP 1: Find the inner stadium in WORLD coords ===
orig_path = '/home/gcp/ozzu/private/drone/cad/print-package/1_painless360_body.stl'
m = trimesh.load(orig_path)
print(f"\nOriginal bbox: X[{m.bounds[0][0]:.2f}..{m.bounds[1][0]:.2f}] Y[{m.bounds[0][1]:.2f}..{m.bounds[1][1]:.2f}] Z[{m.bounds[0][2]:.2f}..{m.bounds[1][2]:.2f}]")

section = m.section(plane_origin=[0, 0, 0.5], plane_normal=[0, 0, 1])
section2d, transform = section.to_2D()

# Find the stadium polygon — size ~14.78 × 11.01
stadium_2d_center = None
for poly in section2d.polygons_closed:
    b = poly.bounds  # 2D bounds
    sx, sy = b[2]-b[0], b[3]-b[1]
    if 14.0 < sx < 16.0 and 10.5 < sy < 11.5:
        stadium_2d_center = ((b[0]+b[2])/2, (b[1]+b[3])/2)
        break

if stadium_2d_center is None:
    raise RuntimeError("Could not find inner stadium polygon at Z=0.5")

# The transform takes 2D coords -> 3D world coords by APPLYING (not inverting).
# Verified by checking: 2D origin maps to (T[0,3], T[1,3], T[2,3]) which lands inside the body.
p2d = np.array([stadium_2d_center[0], stadium_2d_center[1], 0, 1])
p_world = transform @ p2d
WORLD_CX, WORLD_CY = float(p_world[0]), float(p_world[1])
print(f"\nFound inner stadium at WORLD coords ({WORLD_CX:.2f}, {WORLD_CY:.2f}, ~0.5)")
print(f"  Validation: should be inside bbox (X 2.46..37.16, Y -3.47..25.03) — {2.46 <= WORLD_CX <= 37.16 and -3.47 <= WORLD_CY <= 25.03}")

# === STEP 2: Build the cutter (new larger stadium) using build123d ===
CUT_Z_BOTTOM = -2.5  # below the original Z=-2 (overcut)
CUT_Z_TOP = 4.5      # above any pocket extent (the pocket is gone by Z=4)
CUT_HEIGHT = CUT_Z_TOP - CUT_Z_BOTTOM

with BuildPart() as cutter_b3d:
    with BuildSketch():
        SlotOverall(TARGET_POCKET_LEN, TARGET_POCKET_WID)
    extrude(amount=CUT_HEIGHT)

# Translate cutter to world position. After extrude(amount=H), the part spans
# Z=0..H, NOT centered on origin. Translate by (cx, cy, CUT_Z_BOTTOM) so the
# cutter spans CUT_Z_BOTTOM .. CUT_Z_BOTTOM+H.
cutter_solid = cutter_b3d.part.translate(Vector(WORLD_CX, WORLD_CY, CUT_Z_BOTTOM))

# Export and reload as trimesh, then to manifold
cutter_stl = '/tmp/option_b_cutter.stl'
export_stl(cutter_solid, cutter_stl)
cutter_mesh = trimesh.load(cutter_stl)
print(f"\nCutter bbox: X[{cutter_mesh.bounds[0][0]:.2f}..{cutter_mesh.bounds[1][0]:.2f}] Y[{cutter_mesh.bounds[0][1]:.2f}..{cutter_mesh.bounds[1][1]:.2f}] Z[{cutter_mesh.bounds[0][2]:.2f}..{cutter_mesh.bounds[1][2]:.2f}]")

# === STEP 3: Boolean subtract using manifold3d directly ===
def trimesh_to_manifold(tm):
    verts = np.asarray(tm.vertices, dtype=np.float32)
    faces = np.asarray(tm.faces, dtype=np.uint32)
    mesh32 = manifold3d.Mesh(vert_properties=verts, tri_verts=faces)
    return manifold3d.Manifold(mesh32)

def manifold_to_trimesh(man):
    out_mesh = man.to_mesh()
    return trimesh.Trimesh(vertices=out_mesh.vert_properties[:, :3], faces=out_mesh.tri_verts)

orig_man = trimesh_to_manifold(m)
cutter_man = trimesh_to_manifold(cutter_mesh)

print(f"\nOriginal as manifold: status={orig_man.status()}, vol={orig_man.volume():.0f}")
print(f"Cutter as manifold:   status={cutter_man.status()}, vol={cutter_man.volume():.0f}")

result_man = orig_man - cutter_man
print(f"After subtract:       status={result_man.status()}, vol={result_man.volume():.0f}")

result_tm = manifold_to_trimesh(result_man)
print(f"\nResult mesh: {len(result_tm.faces)} triangles, watertight={result_tm.is_watertight}")
print(f"Result bbox: X[{result_tm.bounds[0][0]:.2f}..{result_tm.bounds[1][0]:.2f}] Y[{result_tm.bounds[0][1]:.2f}..{result_tm.bounds[1][1]:.2f}] Z[{result_tm.bounds[0][2]:.2f}..{result_tm.bounds[1][2]:.2f}]")

# === STEP 4: VERIFY post-edit. The new pocket MUST be present, old MUST be gone ===
print(f"\n=== POST-EDIT VERIFICATION ===")
section_after = result_tm.section(plane_origin=[0, 0, 0.5], plane_normal=[0, 0, 1])
section2d_after, _ = section_after.to_2D()

found_target = False
old_present = False
print(f"Polygons at Z=0.5 in result:")
for poly in section2d_after.polygons_closed:
    b = poly.bounds
    sx, sy = b[2]-b[0], b[3]-b[1]
    flag = ""
    if abs(sx - TARGET_POCKET_LEN) < 0.5 and abs(sy - TARGET_POCKET_WID) < 0.5:
        flag = "  <-- NEW TARGET pocket"
        found_target = True
    if 14.0 < sx < 16.0 and 10.5 < sy < 11.5:
        flag = "  <-- OLD stadium STILL PRESENT (BAD)"
        old_present = True
    print(f"  {sx:6.2f} × {sy:6.2f}  area={poly.area:7.2f}{flag}")

print(f"\n  Target pocket {TARGET_POCKET_LEN}×{TARGET_POCKET_WID} found: {found_target}")
print(f"  Old 14.78×11.01 stadium still present: {old_present}")
if found_target and not old_present:
    print(f"  ✓✓✓ SUCCESS — pocket replaced correctly. Geometry matches design intent.")
else:
    print(f"  ✗✗✗ FAILED — boolean did not produce expected geometry. DO NOT PRINT.")

# === STEP 5: Export ===
out_stl = '/home/gcp/ozzu/private/drone/cad/parametric/painless360_body_OPT_B.stl'
result_tm.export(out_stl)
print(f"\nExported: {out_stl}")
print(f"  triangles: {len(result_tm.faces)}, volume (orig - cutter): expect {5018 - cutter_man.volume():.0f}")
