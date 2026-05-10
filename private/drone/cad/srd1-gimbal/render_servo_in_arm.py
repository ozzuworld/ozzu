"""
Render Secondary Arm with SG90 servo positioned at the cavity location.
Visual fit-check before printing — does King Kazuma's 24×11.8×21.5 clone
fit where the design's 22.7×12.2×27 servo is supposed to go?
"""
from build123d import import_step, export_stl
import trimesh
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection

PARTS = '/home/gcp/ozzu/private/drone/cad/srd1-gimbal'

def to_mesh(name):
    obj = import_step(f'{PARTS}/{name}.step')
    export_stl(obj, f'/tmp/_{name}.stl')
    return trimesh.load(f'/tmp/_{name}.stl')

sec_arm = to_mesh('Gimbal Secondary Arm')
servo_design = to_mesh('SG90 Servo')

# Build King Kazuma's clone servo (24×11.8×21.5 with ears, gear, etc.)
from build123d import BuildPart, Box, Cylinder, Locations, Align, Mode
CLONE_LEN, CLONE_WID, CLONE_HGT = 24.0, 11.8, 21.5
CLONE_EAR_TOTAL, CLONE_EAR_THICK = 32.5, 2.5
CLONE_GEAR_DIA, CLONE_GEAR_HGT = 5.0, 4.0
CLONE_SCREW_CTC, CLONE_SCREW_DIA = 28.2, 2.0
CLONE_GEAR_OFFSET = 5.0

with BuildPart() as clone:
    Box(CLONE_LEN, CLONE_WID, CLONE_HGT, align=(Align.CENTER, Align.CENTER, Align.MIN))
    ear_z = CLONE_HGT - 5.0
    with Locations((0, 0, ear_z)):
        Box(CLONE_EAR_TOTAL, CLONE_WID, CLONE_EAR_THICK, align=(Align.CENTER, Align.CENTER, Align.CENTER))
    gear_x = (CLONE_LEN/2) - CLONE_GEAR_OFFSET
    with Locations((gear_x, 0, CLONE_HGT)):
        Cylinder(CLONE_GEAR_DIA/2, CLONE_GEAR_HGT, align=(Align.CENTER, Align.CENTER, Align.MIN))

export_stl(clone.part, '/tmp/_clone.stl')
clone_mesh = trimesh.load('/tmp/_clone.stl')

# Position both servos at the secondary arm's cavity (approx center)
# Cavity center per slice analysis: X~273.5, Y~218, Z~92 in the arm's coordinate system
# But the servo coords are also their own. Need to translate so they end up there.

# Simpler: place each servo BESIDE the secondary arm at same scale for visual comparison
arm_bb = sec_arm.bounds
# Place design servo to the LEFT of the arm
servo_design_translated = servo_design.copy()
sd_bb = servo_design_translated.bounds
servo_design_translated.apply_translation([
    arm_bb[0][0] - (sd_bb[1][0] - sd_bb[0][0]) - 10,  # 10mm gap to the left
    (arm_bb[0][1] + arm_bb[1][1])/2 - (sd_bb[0][1] + sd_bb[1][1])/2,
    (arm_bb[0][2] + arm_bb[1][2])/2 - (sd_bb[0][2] + sd_bb[1][2])/2,
])

# Place clone servo to the RIGHT of the arm
clone_translated = clone_mesh.copy()
cl_bb = clone_translated.bounds
clone_translated.apply_translation([
    arm_bb[1][0] + 10,  # 10mm gap to the right
    (arm_bb[0][1] + arm_bb[1][1])/2 - (cl_bb[0][1] + cl_bb[1][1])/2,
    (arm_bb[0][2] + arm_bb[1][2])/2 - (cl_bb[0][2] + cl_bb[1][2])/2,
])

# Render: comparison view
fig = plt.figure(figsize=(20, 12))
views = [(90,-90,'TOP'), (0,-90,'FRONT'), (0,0,'SIDE'), (20,30,'ISO')]

all_b = np.vstack([sec_arm.bounds, servo_design_translated.bounds, clone_translated.bounds])
bn = all_b[[0,2,4]].min(axis=0); bx = all_b[[1,3,5]].max(axis=0); sz = bx-bn

for i,(elev,azim,vname) in enumerate(views):
    ax = fig.add_subplot(2,2,i+1,projection='3d')
    # Secondary arm — light blue
    pc = Poly3DCollection(sec_arm.vertices[sec_arm.faces], alpha=0.5, edgecolor='blue', linewidth=0.1)
    pc.set_facecolor('lightblue'); ax.add_collection3d(pc)
    # Design servo — green (32.2×12.2×30)
    pc = Poly3DCollection(servo_design_translated.vertices[servo_design_translated.faces], alpha=0.7, edgecolor='darkgreen', linewidth=0.1)
    pc.set_facecolor('lightgreen'); ax.add_collection3d(pc)
    # Clone servo — orange (24×11.8×21.5 + ears)
    pc = Poly3DCollection(clone_translated.vertices[clone_translated.faces], alpha=0.7, edgecolor='darkorange', linewidth=0.1)
    pc.set_facecolor('orange'); ax.add_collection3d(pc)
    ax.set_xlim(bn[0]-2, bx[0]+2); ax.set_ylim(bn[1]-2, bx[1]+2); ax.set_zlim(bn[2]-2, bx[2]+2)
    ax.view_init(elev=elev, azim=azim)
    ax.set_title(vname, fontsize=10)
    ax.set_box_aspect([sz[0], sz[1], sz[2]])

fig.suptitle('SCALE COMPARISON: Secondary Arm (blue) | DESIGN servo green (32.2×12.2×30) | YOUR CLONE servo orange (24×11.8×21.5)\nBoth shown beside the arm at same scale for visual comparison', fontsize=10)
plt.tight_layout()
out = '/tmp/cipher_share/servo_vs_arm_comparison.png'
plt.savefig(out, dpi=85)
plt.close()
print(f"Saved: {out}")

# ALSO render the servos placed INSIDE the arm at the cavity (approximate)
# Cavity at Z=86-98 (in arm coords) seems to be where servos sit
# Cavity ear-to-ear of 33.9, body width of 17.5 — accommodates the design servo
# Place clone servo at the cavity

# Center of cavity in arm coords (approximate)
cavity_x = (arm_bb[0][0] + arm_bb[1][0]) / 2
cavity_y = (arm_bb[0][1] + arm_bb[1][1]) / 2
cavity_z = arm_bb[0][2] + 35  # roughly Z=85 in arm coords

clone_in_arm = clone_mesh.copy()
cl_bb2 = clone_in_arm.bounds
# Center the clone at the cavity center
clone_in_arm.apply_translation([
    cavity_x - (cl_bb2[0][0]+cl_bb2[1][0])/2,
    cavity_y - (cl_bb2[0][1]+cl_bb2[1][1])/2,
    cavity_z - (cl_bb2[0][2]+cl_bb2[1][2])/2,
])

# Compute collision
import manifold3d
def to_man(tm):
    v = np.asarray(tm.vertices, dtype=np.float32)
    f = np.asarray(tm.faces, dtype=np.uint32)
    return manifold3d.Manifold(manifold3d.Mesh(vert_properties=v, tri_verts=f))

am = to_man(sec_arm)
cm = to_man(clone_in_arm)
print(f"\nArm vol: {am.volume():.0f}, Clone vol: {cm.volume():.0f}")
inter = manifold3d.Manifold.batch_boolean([am, cm], op=manifold3d.OpType.Intersect)
print(f"Collision (clone in arm cavity at approx center): vol={inter.volume():.0f} mm^3")
if inter.volume() > 50:
    print(f"  ⚠ Significant collision - clone may not fit at this position")
    print(f"  Need to find correct cavity position more precisely")
EOF