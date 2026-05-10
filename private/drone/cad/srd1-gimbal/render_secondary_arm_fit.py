"""
Load SRD-1 Gimbal Secondary Arm + SG90 Servo (both STEP). Render the assembly
and check if King Kazuma's clone servo (24×11.8×21.5 mm) fits the design.

Per drawing: design assumes 22.7×12.2×27 mm SG90.
King Kazuma clone: 24×11.8×21.5 mm.
Most concerning delta: clone body length (24) > design (22.7) by 1.3 mm.
"""
from build123d import import_step
import trimesh
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection
import os

PARTS_DIR = '/home/gcp/ozzu/private/drone/cad/srd1-gimbal'

def step_to_trimesh(step_path):
    """Load STEP via build123d, export to STL, load into trimesh."""
    obj = import_step(step_path)
    stl_tmp = '/tmp/_step_convert.stl'
    if hasattr(obj, 'export_stl'):
        obj.export_stl(stl_tmp)
    else:
        from build123d import export_stl
        export_stl(obj, stl_tmp)
    return trimesh.load(stl_tmp)

# Load all parts to get their geometry
parts = {
    'secondary_arm': 'Gimbal Secondary Arm.step',
    'sg90_servo':    'SG90 Servo.step',
    'main_arm':      'Gimbal Main Arm.step',
    'camera_mount':  'Camera Mount.step',
    'gimbal_mount':  'Gimbal Mount.step',
    'gimbal_adapter':'Gimbal Adapter.step',
    'rpi_camera':    'Raspberry HQ Camera.step',
}

meshes = {}
print("=== Loading STEP files ===")
for name, fname in parts.items():
    path = os.path.join(PARTS_DIR, fname)
    if not os.path.exists(path):
        print(f"  {name}: MISSING ({path})")
        continue
    try:
        m = step_to_trimesh(path)
        bb = m.bounds[1] - m.bounds[0]
        meshes[name] = m
        print(f"  {name}: bbox {bb[0]:.1f}×{bb[1]:.1f}×{bb[2]:.1f} mm, watertight={m.is_watertight}")
    except Exception as e:
        print(f"  {name}: FAILED to load: {e}")

if 'secondary_arm' not in meshes or 'sg90_servo' not in meshes:
    print("Missing critical parts, aborting render")
    raise SystemExit(1)

# Render each part individually (multi-view) for visual inspection
def render_multiview(mesh_dict, out_path, title=''):
    n = len(mesh_dict)
    fig = plt.figure(figsize=(16, 4 * n))
    views = [(90, -90, 'TOP'), (0, -90, 'FRONT'), (0, 0, 'SIDE'), (20, 30, 'ISO')]
    for row, (name, m) in enumerate(mesh_dict.items()):
        bb = m.bounds; sz = bb[1]-bb[0]
        for col, (elev, azim, vname) in enumerate(views):
            ax = fig.add_subplot(n, 4, row*4 + col + 1, projection='3d')
            tri = m.vertices[m.faces]
            pc = Poly3DCollection(tri, alpha=0.7, edgecolor='gray', linewidth=0.1)
            pc.set_facecolor('lightblue')
            ax.add_collection3d(pc)
            ax.set_xlim(bb[0][0]-1, bb[1][0]+1); ax.set_ylim(bb[0][1]-1, bb[1][1]+1); ax.set_zlim(bb[0][2]-1, bb[1][2]+1)
            ax.view_init(elev=elev, azim=azim)
            ax.set_title(f'{name} — {vname}\n{sz[0]:.1f}×{sz[1]:.1f}×{sz[2]:.1f}', fontsize=8)
            ax.set_box_aspect([sz[0], sz[1], sz[2]])
    plt.suptitle(title, fontsize=12)
    plt.tight_layout()
    plt.savefig(out_path, dpi=80)
    plt.close()
    print(f"  Saved: {out_path}")

print("\n=== Rendering all parts individually ===")
render_multiview(meshes, '/tmp/cipher_share/srd1_all_parts.png',
                 'SRD-1 SG90 Gimbal — all parts (parametric STEP source)')
