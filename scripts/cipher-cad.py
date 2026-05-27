#!/usr/bin/env python3
"""Cipher parametric CAD runner — Phase 1 of the SOTA CAD pipeline (dir_1779917337177).

The upgrade: stop hand-coding mesh-boolean ops with hand-derived coordinates. Instead author
a *parametric* part (build123d), run it through here, and get back STEP + STL + a shaded
multi-view render + a geometry report — in one shot. Edits become parameter/code changes;
re-running regenerates exactly. (Ecosystem note: the text-to-CAD model world targets CadQuery;
build123d is its modern successor and works the same here. Swap kernels later via a venv.)

The part script must define a module-level `result` (a build123d Part/Solid/Compound, or a
cadquery Workplane). Optional module-level: NAME (str), PARAMS (dict — echoed into the report).

Usage:
  scripts/cipher-cad.py PART.py [--out DIR] [--no-render]
"""
import sys, os, json, argparse, importlib.util, subprocess, shutil, tempfile


def load_part(path):
    spec = importlib.util.spec_from_file_location("cad_part", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    res = getattr(mod, "result", None)
    if res is None:
        sys.exit("ERROR: part script must define a module-level `result`")
    name = getattr(mod, "NAME", os.path.splitext(os.path.basename(path))[0])
    params = getattr(mod, "PARAMS", {})
    return res, name, params


def export(result, step_path, stl_path):
    """Export STEP + STL. Tries build123d first, then cadquery."""
    try:
        from build123d import export_step, export_stl
        export_step(result, step_path)
        try:
            export_stl(result, stl_path, tolerance=0.04, angular_tolerance=0.1)
        except TypeError:
            export_stl(result, stl_path)
        return "build123d"
    except Exception as e_b:
        try:
            import cadquery as cq
            cq.exporters.export(result, step_path)
            cq.exporters.export(result, stl_path)
            return "cadquery"
        except Exception as e_c:
            sys.exit(f"ERROR exporting (build123d={e_b!r} | cadquery={e_c!r})")


def geom_report(stl_path):
    import trimesh
    m = trimesh.load(stl_path)
    return {
        "bbox_mm": [round(float(v), 3) for v in m.extents],
        "volume_mm3": round(float(m.volume), 2),
        "watertight": bool(m.is_watertight),
        "triangles": int(len(m.faces)),
    }


def render(stl_path, out_png):
    """Clean shaded multi-view via OpenSCAD (import the STL). Returns the montage path or None."""
    if not shutil.which("openscad"):
        return None
    scad = tempfile.NamedTemporaryFile("w", suffix=".scad", delete=False)
    scad.write('import("%s");\n' % os.path.abspath(stl_path))
    scad.close()
    pre = ["xvfb-run", "-a"] if shutil.which("xvfb-run") else []
    views = {"iso": "0,0,0,55,0,25,0", "top": "0,0,0,12,0,18,0", "front": "0,0,0,90,0,0,0"}
    imgs = []
    for n, cam in views.items():
        p = out_png.replace(".png", "_%s.png" % n)
        subprocess.run(pre + ["openscad", "--preview", "--autocenter", "--viewall",
                              "--colorscheme=Tomorrow", "--imgsize=760,640",
                              "--camera=" + cam, "-o", p, scad.name],
                       capture_output=True, timeout=150)
        if os.path.exists(p):
            imgs.append((n, p))
    os.unlink(scad.name)
    if shutil.which("montage") and imgs:
        args = []
        for n, p in imgs:
            args += ["-label", n.upper(), p]
        subprocess.run(["montage"] + args + ["-tile", "%dx1" % len(imgs), "-geometry", "+6+6",
                       "-background", "white", "-pointsize", "16", out_png],
                       capture_output=True, timeout=60)
    return out_png if os.path.exists(out_png) else (imgs[0][1] if imgs else None)


def main():
    ap = argparse.ArgumentParser(description="Cipher parametric CAD runner")
    ap.add_argument("script", help="parametric part script defining `result`")
    ap.add_argument("--out", default=None, help="output dir (default: script's dir)")
    ap.add_argument("--no-render", action="store_true")
    a = ap.parse_args()

    result, name, params = load_part(a.script)
    out = a.out or os.path.dirname(os.path.abspath(a.script))
    os.makedirs(out, exist_ok=True)
    step = os.path.join(out, name + ".step")
    stl = os.path.join(out, name + ".stl")

    kernel = export(result, step, stl)
    rep = {"name": name, "kernel": kernel, "params": params, "step": step, "stl": stl}
    rep.update(geom_report(stl))
    if not a.no_render:
        rep["render"] = render(stl, os.path.join(out, name + "_views.png"))
    print(json.dumps(rep, indent=2))


if __name__ == "__main__":
    main()
