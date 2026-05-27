#!/usr/bin/env python3
"""Cipher CAD feature inspector — SOTA CAD Phase 2 (dir_1779918184600).

Reads SEMANTICS off a STEP B-rep so I stop eyeballing geometry: bbox, solid/face census,
every hole/cylinder (Ø / axis / center), and detected hole PATTERNS (rectangle / pair / line
+ spacing + centroid). This is pragmatic *geometric* feature-recognition on the OCP kernel —
no GPU, no weights. (The deep-net version — BRepFormer / Hierarchical-CADNet — is a future GPU
step for messy/organic features; this nails the bolt-patterns/holes that 90% of mounts need.)

Usage:  scripts/cipher-cad-inspect.py PART.step
"""
import sys, json, argparse
from collections import defaultdict


def inspect(path):
    from OCP.STEPControl import STEPControl_Reader
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID
    from OCP.TopoDS import TopoDS
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import (GeomAbs_Plane, GeomAbs_Cylinder, GeomAbs_Cone,
                             GeomAbs_Sphere, GeomAbs_Torus)

    r = STEPControl_Reader(); r.ReadFile(path); r.TransferRoots(); shape = r.OneShape()
    box = Bnd_Box(); BRepBndLib.Add_s(shape, box, True)
    xm, ym, zm, xM, yM, zM = box.Get()

    se = TopExp_Explorer(shape, TopAbs_SOLID); nsolid = 0
    while se.More():
        nsolid += 1; se.Next()

    names = {GeomAbs_Plane: "plane", GeomAbs_Cylinder: "cylinder", GeomAbs_Cone: "cone",
             GeomAbs_Sphere: "sphere", GeomAbs_Torus: "torus"}
    typecount = defaultdict(int); cyls = []
    fe = TopExp_Explorer(shape, TopAbs_FACE); nface = 0
    while fe.More():
        f = TopoDS.Face_s(fe.Current()); fe.Next(); nface += 1
        try:
            ad = BRepAdaptor_Surface(f); t = ad.GetType()
        except Exception:
            typecount["other"] += 1; continue
        typecount[names.get(t, "other")] += 1
        if t == GeomAbs_Cylinder:
            c = ad.Cylinder(); d = c.Axis().Direction(); L = c.Axis().Location()
            cyls.append((round(L.X(), 2), round(L.Y(), 2), round(L.Z(), 2), round(2 * c.Radius(), 2),
                         (round(d.X(), 1), round(d.Y(), 1), round(d.Z(), 1))))

    seen = set(); holes = []
    for x, y, z, dia, ax in cyls:
        k = (x, y, round(dia, 1))
        if k in seen:
            continue
        seen.add(k); holes.append({"center": [x, y, z], "dia": dia, "axis": list(ax)})

    return {
        "file": path,
        "bbox_mm": [round(xM - xm, 3), round(yM - ym, 3), round(zM - zm, 3)],
        "bbox_range": {"x": [round(xm, 2), round(xM, 2)], "y": [round(ym, 2), round(yM, 2)],
                       "z": [round(zm, 2), round(zM, 2)]},
        "solids": nsolid, "faces": nface, "face_types": dict(typecount),
        "holes": sorted(holes, key=lambda h: h["dia"]),
        "patterns": detect_patterns(holes),
    }


def _cluster(vals, tol=0.7):
    """Collapse near-equal coordinates (real CAD has hundredths-of-mm jitter)."""
    vals = sorted(vals); cl = []; cur = [vals[0]]
    for v in vals[1:]:
        if v - cur[-1] <= tol:
            cur.append(v)
        else:
            cl.append(sum(cur) / len(cur)); cur = [v]
    cl.append(sum(cur) / len(cur))
    return cl


def detect_patterns(holes):
    """Group cylinders by (diameter, dominant axis); classify rectangle / pair / line with
    coordinate clustering so real-world jitter (2.48 vs 2.50) still reads as one pattern."""
    groups = defaultdict(list)
    for h in holes:
        ax = h["axis"]
        dom = ("Z" if abs(ax[2]) > 0.9 else "X" if abs(ax[0]) > 0.9 else
               "Y" if abs(ax[1]) > 0.9 else "tilt")
        groups[(round(h["dia"], 1), dom)].append(h["center"])
    pats = []
    for (dia, dom), cs in sorted(groups.items()):
        if dom == "Z":
            proj = [(c[0], c[1]) for c in cs]
        elif dom == "X":
            proj = [(c[1], c[2]) for c in cs]
        elif dom == "Y":
            proj = [(c[0], c[2]) for c in cs]
        else:
            continue
        n = len(proj)
        uc = _cluster([p[0] for p in proj]); vc = _cluster([p[1] for p in proj])
        if n == 4 and len(uc) == 2 and len(vc) == 2:
            pats.append({"type": "rectangle", "dia": dia, "axis": dom, "count": 4,
                         "spacing_mm": [round(uc[1] - uc[0], 2), round(vc[1] - vc[0], 2)],
                         "centroid": [round((uc[0] + uc[1]) / 2, 2), round((vc[0] + vc[1]) / 2, 2)]})
        elif n == 2:
            (a, b), (c, d) = proj[0], proj[1]
            pats.append({"type": "pair", "dia": dia, "axis": dom, "count": 2,
                         "spacing_mm": round(((c - a) ** 2 + (d - b) ** 2) ** 0.5, 2)})
        elif n >= 3:
            pats.append({"type": "group", "dia": dia, "axis": dom, "count": n,
                         "grid": [len(uc), len(vc)]})
    return pats


def main():
    ap = argparse.ArgumentParser(description="Cipher CAD feature inspector (Phase 2)")
    ap.add_argument("step", help="STEP file to inspect")
    a = ap.parse_args()
    print(json.dumps(inspect(a.step), indent=2))


if __name__ == "__main__":
    main()
