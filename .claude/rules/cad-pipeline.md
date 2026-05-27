---
paths:
  - "scripts/cipher-cad.py"
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

## Roadmap — full SOTA CAD for Cipher
- ✅ **P1 — parametric pipeline** (this file + `cipher-cad.py`).
- **P2 — B-rep feature recognition** (BRepFormer / Hierarchical-CADNet class) to read semantics
  ("this face group = a hole / pocket / tab") off imported STEPs instead of guessing.
- **P3 — scan / photo → CAD** (CAD-Recode point-cloud→code, or photogrammetry) to measure real parts
  without asking King Kazuma to caliper. A single casual photo can't give scale — need a scan or a
  ruler in frame.

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
