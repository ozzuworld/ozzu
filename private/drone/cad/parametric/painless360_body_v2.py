"""
Painless360 pan/tilt body — v2 parametric.

Corrected understanding (from painless360-gimbal/images/Pan_and_Tilt.jpg):
- Body is a U-SADDLE that holds TWO SG90 servos at right angles.
- PAN servo (bottom): hangs down BELOW the printed body. Its top fits
  in the central pocket on the bottom plate. Its gear shaft pokes UP
  through the bottom plate's ø5mm hole.
- TILT servo (top): lays HORIZONTALLY in the saddle between the two
  back pillars. Its ears mount via screws (28.2mm c-c) through the
  pillar tops. Gear shaft exits the side of one pillar through a
  cylindrical clearance.

Both servos are King Kazuma's actual SG90 clone (sg90-measurements.md).
"""
from build123d import *

# === SERVO MEASUREMENTS (King Kazuma's actual SG90 — sg90-measurements.md) ===
SERVO_BODY_LEN     = 24.0    # body length without ears (his clone is 1.5mm > spec)
SERVO_BODY_WID     = 11.8    # body width
SERVO_BODY_HGT     = 21.5    # body height (no horn)
SERVO_EAR_TO_EAR   = 32.5    # ear-to-ear span
SERVO_EAR_THICK    = 2.5     # ear flange thickness
SERVO_EAR_LEN      = 4.25    # how far ear extends from body sides
SERVO_SCREW_CTC    = 28.2    # screw hole c-to-c
SERVO_SCREW_DIA    = 2.0     # screw hole ø
SERVO_GEAR_DIA     = 5.0     # gear column ø
SERVO_GEAR_OFFSET  = 5.0     # gear center → nearest body end
SERVO_GEAR_HGT     = 4.0     # gear column above case top

# === FIT CLEARANCES ===
CLR_PAN_BODY  = 0.5    # pan servo top fits in bottom-plate pocket; per side
CLR_TILT_BODY = 0.4    # tilt servo body in saddle; per side
CLR_GEAR      = 0.3    # around gear shafts

# === FRAME PARAMETERS ===
WALL = 2.0
BOTTOM_PLATE_THK = 3.0     # depth of pan-servo recess
PILLAR_HGT = 13.0          # how tall the back pillars are above bottom plate
PILLAR_THK = 4.0           # pillar thickness (X dimension at top)
PILLAR_DEPTH = 5.0         # pillar depth into the body (Y dim)
FRONT_BRIDGE_HGT = 11.0
FRONT_BRIDGE_THK = 2.0
EAR_SHELF_THK = SERVO_EAR_THICK + 0.3  # shelf where tilt-servo ears rest

# === DERIVED ===
# Pan servo top recess (only top ~5mm of pan servo body goes in)
PAN_RECESS_LEN = SERVO_BODY_LEN + 2 * CLR_PAN_BODY      # 25.0
PAN_RECESS_WID = SERVO_BODY_WID + 2 * CLR_PAN_BODY      # 12.8
PAN_GEAR_HOLE_DIA = SERVO_GEAR_DIA + 2 * CLR_GEAR       # 5.6

# Tilt servo saddle (between pillars, lays horizontally)
TILT_SADDLE_LEN = SERVO_BODY_LEN + 2 * CLR_TILT_BODY    # 24.8
TILT_SADDLE_WID = SERVO_BODY_WID + 2 * CLR_TILT_BODY    # 12.6
TILT_GEAR_HOLE_DIA = SERVO_GEAR_DIA + 2 * CLR_GEAR      # 5.6

# Pillar X positions: tilt servo ears mount with screws 28.2mm c-c
# So pillars centered at ±SERVO_SCREW_CTC/2
PILLAR_CTR_X = SERVO_SCREW_CTC / 2  # ±14.1

# Frame footprint: from outside of one pillar to outside of the other
FRAME_LEN = SERVO_EAR_TO_EAR + 2 * WALL          # ~36.5
FRAME_WID = TILT_SADDLE_WID + 2 * WALL           # ~16.6 (just enough for saddle + walls)

print(f"=== Derived ===")
print(f"  PAN recess (bottom plate pocket) : {PAN_RECESS_LEN:.2f} × {PAN_RECESS_WID:.2f} × {BOTTOM_PLATE_THK:.2f}")
print(f"  PAN gear hole                    : ø{PAN_GEAR_HOLE_DIA:.2f}")
print(f"  TILT saddle (between pillars)    : {TILT_SADDLE_LEN:.2f} × {TILT_SADDLE_WID:.2f}")
print(f"  TILT gear hole (pillar side)     : ø{TILT_GEAR_HOLE_DIA:.2f}")
print(f"  PILLAR centers                   : X = ±{PILLAR_CTR_X:.2f}")
print(f"  Frame footprint                  : {FRAME_LEN:.2f} × {FRAME_WID:.2f} × {BOTTOM_PLATE_THK + PILLAR_HGT:.2f}")

# === BUILD ===
with BuildPart() as body:
    # 1. Bottom plate
    Box(FRAME_LEN, FRAME_WID, BOTTOM_PLATE_THK, align=(Align.CENTER, Align.CENTER, Align.MIN))

    # 2. Two back pillars — wider at base for ear shelf, with screw holes through tops
    pillar_y_ctr = (FRAME_WID / 2) - (PILLAR_DEPTH / 2)
    for sign in (-1, +1):
        with Locations(((sign * PILLAR_CTR_X), pillar_y_ctr, BOTTOM_PLATE_THK)):
            Box(PILLAR_THK, PILLAR_DEPTH, PILLAR_HGT,
                align=(Align.CENTER, Align.CENTER, Align.MIN))

    # 3. Front bridge for rigidity
    bridge_y_ctr = -(FRAME_WID / 2) + (FRONT_BRIDGE_THK / 2)
    with Locations((0, bridge_y_ctr, BOTTOM_PLATE_THK)):
        Box(FRAME_LEN, FRONT_BRIDGE_THK, FRONT_BRIDGE_HGT,
            align=(Align.CENTER, Align.CENTER, Align.MIN))

    # 4. SUBTRACT: pan-servo body pocket (only top ~3mm of pan servo nests here)
    # Goes through full bottom plate from above
    with Locations((0, 0, -0.5)):
        Box(PAN_RECESS_LEN, PAN_RECESS_WID, BOTTOM_PLATE_THK + 1,
            mode=Mode.SUBTRACT,
            align=(Align.CENTER, Align.CENTER, Align.MIN))

    # 5. SUBTRACT: pan-servo gear shaft hole through bottom plate
    # Gear is offset SERVO_GEAR_OFFSET from one end of the pan-servo body
    pan_gear_x = (SERVO_BODY_LEN / 2) - SERVO_GEAR_OFFSET
    with Locations((pan_gear_x, 0, -1)):
        Cylinder(PAN_GEAR_HOLE_DIA / 2, BOTTOM_PLATE_THK + 2,
                 mode=Mode.SUBTRACT,
                 align=(Align.CENTER, Align.CENTER, Align.MIN))

    # 6. SUBTRACT: screw holes through tops of pillars (vertical, for tilt-servo ears)
    for sign in (-1, +1):
        with Locations(((sign * PILLAR_CTR_X), pillar_y_ctr, BOTTOM_PLATE_THK + PILLAR_HGT - SERVO_EAR_THICK)):
            Cylinder(SERVO_SCREW_DIA / 2, SERVO_EAR_THICK + 1,
                     mode=Mode.SUBTRACT,
                     align=(Align.CENTER, Align.CENTER, Align.MIN))

    # 7. SUBTRACT: tilt servo gear shaft clearance through ONE pillar (the +X one)
    # Gear sticks out HORIZONTALLY along +X. Hole through outer pillar at correct height.
    tilt_gear_z = BOTTOM_PLATE_THK + PILLAR_HGT - SERVO_EAR_THICK - SERVO_GEAR_HGT
    with Locations((PILLAR_CTR_X, pillar_y_ctr, tilt_gear_z)):
        Cylinder(TILT_GEAR_HOLE_DIA / 2, PILLAR_THK + 2,
                 mode=Mode.SUBTRACT,
                 rotation=(0, 90, 0),  # rotate so axis is along X
                 align=(Align.CENTER, Align.CENTER, Align.CENTER))

    # 8. SUBTRACT: tilt servo body clearance — saddle space between pillars
    # The tilt servo lays horizontally, gear shaft along X, so:
    # - X spans between the two pillars (inside-to-inside)
    # - Y is body width
    # - Z is body height
    saddle_z = BOTTOM_PLATE_THK + PILLAR_HGT - SERVO_BODY_HGT
    inside_pillar_x_span = SERVO_SCREW_CTC - PILLAR_THK  # gap between inner pillar faces
    # Just clear out the saddle space so the tilt body has room
    with Locations((0, pillar_y_ctr, BOTTOM_PLATE_THK + PILLAR_HGT - SERVO_EAR_THICK)):
        Box(inside_pillar_x_span + 0.5, SERVO_BODY_WID + 0.5, SERVO_BODY_HGT,
            mode=Mode.SUBTRACT,
            align=(Align.CENTER, Align.CENTER, Align.MAX))

# Export
out_stl = '/home/gcp/ozzu/private/drone/cad/parametric/painless360_body_v2.stl'
export_stl(body.part, out_stl)
bb = body.part.bounding_box()
print(f"\n=== Built ===")
print(f"  Volume: {body.part.volume:.1f} mm^3")
print(f"  Bounding box: X[{bb.min.X:.2f}..{bb.max.X:.2f}] Y[{bb.min.Y:.2f}..{bb.max.Y:.2f}] Z[{bb.min.Z:.2f}..{bb.max.Z:.2f}]")
print(f"  Size: {bb.max.X-bb.min.X:.2f} × {bb.max.Y-bb.min.Y:.2f} × {bb.max.Z-bb.min.Z:.2f}")
print(f"  STL: {out_stl}")
