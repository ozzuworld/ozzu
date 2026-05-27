---
paths:
  - "scripts/cipher-cad.py"
  - "scripts/cipher-cad-inspect.py"
  - "scripts/cipher-cad-measure.py"
  - "private/**/cad/**"
  - "**/*.scad"
  - "**/*.step"
  - "**/*.stl"
---

# CAD Pipeline — parametric, not mesh-hacking (dir_1779917337177)

## The rule
When designing or modifying **any 3D part**, author **parametric `build123d` code**, then run it through
`scripts/cipher-cad.py` to get STEP + STL + a shaded multi-view render + a geometry report in one shot.

**Do NOT** hand-derive coordinates and boolean-cut a mesh/STEP. That brittle approach (eyeballing
positions, `BRepAlgoAPI_Cut` with magic numbers) is exactly what this replaces — it's slow, error-prone,
and not re-editable.

## Why this is the SOTA move
The whole text-to-CAD field (Text-to-CadQuery, CAD-Coder, Zoo, MakeIt3D-uses-Claude) converged on
**LLMs writing parametric CAD code that executes into geometry** — because code is editable, exact,
diffable, and geometrically verifiable. A parametric model means *every* edit is a parameter change,
re-run regenerates exactly, and the geometry report is a built-in self-check.

## How
1. Write a part script with a module-level **`result`** (build123d `Part`/`Solid`/`Compound`).
   Optional: `NAME` (str), `PARAMS` (dict — echoed into the report).
2. `python3 scripts/cipher-cad.py PART.py [--out DIR] [--no-render]`
3. Read the JSON report: `bbox_mm`, `volume_mm3`, `watertight`, `triangles`, `render`. Iterate by
   editing `PARAMS` and re-running. Volume + watertight are your sanity checks.

## Example (the live one)
`private/drone/cad/mtf_mount.py` — a fully parametric MTF-01 down-mount. Body size, walls, roof, and
bolt spacing are all `PARAMS`. "Resize for the de-eared body / move the holes / mirror to the other end"
= change a number, re-run. No re-measuring, no hand-coordinates.

## Principle
**Edits = parameter/code changes → re-run → exact regenerate.** If you catch yourself typing a literal
coordinate to place a cut, stop — parameterize it instead.

## Tools — the SOTA CAD pipeline (all three live)
- **`scripts/cipher-cad.py PART.py`** — author parametric build123d → STEP + STL + shaded render +
  geometry report, one shot. *(P1)*
- **`scripts/cipher-cad-inspect.py PART.step`** — read semantics off a STEP: bbox, every hole (Ø/axis/
  center), detected hole-patterns (rectangle/pair + spacing + centroid), face census. **Run this
  BEFORE designing against anyone's CAD** — it auto-finds bolt patterns instead of me eyeballing them.
  *(P2 — validated: auto-found the MTF 24.3×12 Ø2.5 mount + the two lenses ~10 mm apart.)*
- **`scripts/cipher-cad-measure.py PHOTO.jpg --marker-mm N`** (+ `--gen-marker M.png --mm N`) —
  measure a real part from a photo via a printed ArUco marker. Print marker → lay flat & coplanar →
  shoot top-down → get L×W in mm. ~1-2% on a square shot (validated 0.3% on a synthetic test); for
  tight tolerances still caliper. *(P3 — kills the "go caliper it" loop for rough/medium sizing.)*

## Roadmap
- ✅ **P1 — parametric authoring** (`cipher-cad.py`).
- ✅ **P2 — geometric feature recognition** (`cipher-cad-inspect.py`). Deep-net (BRepFormer /
  Hierarchical-CADNet) for organic/messy features = future GPU step.
- ✅ **P3 — reference-marker photo measurement** (`cipher-cad-measure.py`). Deep-net point-cloud
  scan→CAD (CAD-Recode) = future GPU step.

## Kernel note
`build123d` is installed (modern CadQuery successor, same OCP core). **CadQuery** — the kernel the
text-to-CAD *model* ecosystem targets — needs an isolated venv here (host python is
externally-managed); add it only if/when we wire in those models. The workflow is identical either way.

## Anti-patterns
- ❌ Hand-derived coordinates + `BRepAlgoAPI_Cut`/mesh booleans for *new* design work. (Reading/measuring
  an existing STEP with OCP is fine — that's analysis, not authoring.)
- ❌ Authoring new parts in OpenSCAD `.scad`. Use build123d. (OpenSCAD stays as the runner's *render*
  backend only.)
- ❌ Inferring a real part's dimensions from one perspective photo — no scale/depth. Scan, ruler-in-frame,
  or caliper.
