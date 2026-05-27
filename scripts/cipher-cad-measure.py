#!/usr/bin/env python3
"""Cipher CAD photo-measurer — SOTA CAD Phase 3 (dir_1779918184600).

Measure a real part's dimensions from a photo, using a printed ArUco marker as a coplanar
scale reference. Kills the "go caliper it" loop for rough/medium sizing.

  generate a marker:  scripts/cipher-cad-measure.py --gen-marker MARKER.png --mm 30
  measure a part:     scripts/cipher-cad-measure.py PHOTO.jpg --marker-mm 30 [--out ANNOT.png]

Workflow: print the marker at the stated size, lay it FLAT and coplanar with the part, shoot
straight down, run. Reports the part's L x W in mm + an annotated image. A square-on top-down
shot gives ~1-2%; for tight tolerances, still caliper. (The deep-net version — CAD-Recode from a
point-cloud scan — is the future GPU step; this reference-marker method needs no scanner.)
"""
import sys, argparse, json
import cv2
import numpy as np

ADICT = cv2.aruco.DICT_4X4_50


def _adict():
    return cv2.aruco.getPredefinedDictionary(ADICT)


def gen_marker(path, mm, px=700):
    m = cv2.aruco.generateImageMarker(_adict(), 0, px)
    b = px // 5
    canvas = np.full((px + 2 * b, px + 2 * b), 255, np.uint8)
    canvas[b:b + px, b:b + px] = m
    cv2.putText(canvas, "ArUco id0 - print so BLACK square = %dmm" % mm, (10, b - 14),
                cv2.FONT_HERSHEY_SIMPLEX, 0.65, 0, 2)
    cv2.imwrite(path, canvas)
    return {"marker": path, "real_mm": mm,
            "instructions": "print so the black square measures exactly %dmm across; "
                            "lay flat & coplanar with the part, shoot straight down" % mm}


def _detect(gray):
    try:
        det = cv2.aruco.ArucoDetector(_adict(), cv2.aruco.DetectorParameters())
        c, ids, _ = det.detectMarkers(gray)
    except AttributeError:
        c, ids, _ = cv2.aruco.detectMarkers(gray, _adict())
    return c, ids


def measure(photo, marker_mm, out=None):
    img = cv2.imread(photo)
    if img is None:
        sys.exit("ERROR: cannot read %s" % photo)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    corners, ids = _detect(gray)
    if ids is None or len(ids) == 0:
        sys.exit("ERROR: no ArUco marker detected — put the printed marker in frame, flat & lit")
    mc = corners[0].reshape(4, 2)
    side_px = float(np.mean([np.linalg.norm(mc[i] - mc[(i + 1) % 4]) for i in range(4)]))
    mm_per_px = marker_mm / side_px
    mx0, my0, mx1, my1 = mc[:, 0].min(), mc[:, 1].min(), mc[:, 0].max(), mc[:, 1].max()

    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    _, th = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    cnts, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best = None
    for c in cnts:
        x, y, w, h = cv2.boundingRect(c)
        cx, cy = x + w / 2.0, y + h / 2.0
        if mx0 <= cx <= mx1 and my0 <= cy <= my1:      # the marker itself — skip
            continue
        area = cv2.contourArea(c)
        if area < 0.01 * gray.size:                     # noise — skip
            continue
        if best is None or area > best[0]:
            best = (area, c)
    if best is None:
        sys.exit("ERROR: no part contour found (works best: solid part, contrasting background)")
    rect = cv2.minAreaRect(best[1])
    pw, ph = rect[1]
    L, Wd = sorted([pw * mm_per_px, ph * mm_per_px], reverse=True)
    rep = {"photo": photo, "marker_mm": marker_mm, "mm_per_px": round(mm_per_px, 5),
           "part_mm": {"length": round(L, 2), "width": round(Wd, 2)}}
    if out:
        vis = img.copy()
        box = cv2.boxPoints(rect).astype(int)
        cv2.drawContours(vis, [box], 0, (0, 0, 255), 3)
        cv2.aruco.drawDetectedMarkers(vis, corners, ids)
        cv2.putText(vis, "%.1f x %.1f mm" % (L, Wd), tuple(box[1]),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 255), 3)
        cv2.imwrite(out, vis)
        rep["annotated"] = out
    return rep


def main():
    ap = argparse.ArgumentParser(description="Cipher CAD photo-measurer (Phase 3)")
    ap.add_argument("photo", nargs="?", help="photo to measure (with the marker in frame)")
    ap.add_argument("--gen-marker", metavar="PATH", help="generate a printable marker instead")
    ap.add_argument("--mm", type=float, default=30, help="marker size for --gen-marker")
    ap.add_argument("--marker-mm", type=float, default=30, help="printed marker size (for measuring)")
    ap.add_argument("--out", default=None, help="write an annotated image")
    a = ap.parse_args()
    if a.gen_marker:
        print(json.dumps(gen_marker(a.gen_marker, a.mm), indent=2)); return
    if not a.photo:
        sys.exit("give a PHOTO to measure, or --gen-marker PATH")
    print(json.dumps(measure(a.photo, a.marker_mm, a.out), indent=2))


if __name__ == "__main__":
    main()
