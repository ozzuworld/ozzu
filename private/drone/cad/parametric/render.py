"""Render multi-view PNG of an STL for visual verification before printing."""
import sys
import trimesh
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection

def render_views(stl_path: str, out_path: str, title: str = ''):
    m = trimesh.load(stl_path)
    bb = m.bounds
    sz = bb[1] - bb[0]

    fig = plt.figure(figsize=(20, 5))

    # 4 views: TOP (looking down -Z), FRONT (looking +Y), SIDE (looking -X), ISO
    angles = [
        (90, -90, 'TOP (looking down)'),
        (0, -90, 'FRONT (looking from -Y)'),
        (0, 0, 'SIDE (looking from +X)'),
        (25, 30, 'ISOMETRIC'),
    ]

    triangles = m.vertices[m.faces]

    for i, (elev, azim, view_label) in enumerate(angles):
        ax = fig.add_subplot(1, 4, i+1, projection='3d')
        pc = Poly3DCollection(triangles, alpha=0.7, edgecolor='gray', linewidth=0.2)
        pc.set_facecolor('cyan')
        ax.add_collection3d(pc)
        ax.set_xlim(bb[0][0]-1, bb[1][0]+1)
        ax.set_ylim(bb[0][1]-1, bb[1][1]+1)
        ax.set_zlim(bb[0][2]-1, bb[1][2]+1)
        ax.view_init(elev=elev, azim=azim)
        ax.set_title(view_label, fontsize=10)
        ax.set_xlabel('X (mm)')
        ax.set_ylabel('Y (mm)')
        ax.set_zlabel('Z (mm)')
        # Force equal aspect by using box_aspect
        ax.set_box_aspect([sz[0], sz[1], sz[2]])

    fig.suptitle(f'{title}\nbbox: {sz[0]:.1f} × {sz[1]:.1f} × {sz[2]:.1f} mm   |   vol: {m.volume:.0f} mm³   |   watertight: {m.is_watertight}', fontsize=11)
    plt.tight_layout()
    plt.savefig(out_path, dpi=85)
    plt.close()
    print(f"Rendered {out_path}")
    return out_path

if __name__ == '__main__':
    stl = sys.argv[1] if len(sys.argv) > 1 else '/home/gcp/ozzu/private/drone/cad/parametric/painless360_body.stl'
    out = sys.argv[2] if len(sys.argv) > 2 else '/home/gcp/ozzu/private/drone/cad/parametric/render.png'
    title = sys.argv[3] if len(sys.argv) > 3 else stl.split('/')[-1]
    render_views(stl, out, title)
