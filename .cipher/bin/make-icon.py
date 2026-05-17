#!/usr/bin/env python3
# Build production icon from /tmp/ozzu-logo.png — strip the outer ring,
# white penguin on Ozzu-base #0a0a0a, 1024×1024 RGB, ~80% fill.

from PIL import Image
import numpy as np
from scipy import ndimage

SRC = "/tmp/ozzu-logo.png"
OUT_ICON = "/tmp/ozzu-icon-1024.png"
OUT_ADAPTIVE = "/tmp/ozzu-adaptive-1024.png"
OUT_SPLASH = "/tmp/ozzu-splash-1024.png"

BG = (10, 10, 10)
FG = (255, 255, 255)

# 1. Load + binarize
img = Image.open(SRC).convert("L")
arr = np.array(img)
black = arr < 128
print(f"loaded {img.size}, black pixels: {black.sum()}")

# 2. Connected components on the FULL black mask. The penguin is one component;
# the outer ring is a separate component (a closed loop, no contact with the
# penguin inside). Drop any component that touches the image edge — that's
# either the outer ring or background noise.
labeled, n = ndimage.label(black)
print(f"{n} black components")

H, W = black.shape
edge_labels = set()
for r in [0, H - 1]:
    edge_labels.update(np.unique(labeled[r, :]))
for c in [0, W - 1]:
    edge_labels.update(np.unique(labeled[:, c]))
edge_labels.discard(0)  # background label is 0
print(f"edge-touching components (likely outer ring): {sorted(edge_labels)}")

# Build a clean mask = all components NOT touching the edge
penguin_mask = np.zeros_like(black, dtype=bool)
for i in range(1, n + 1):
    if i in edge_labels:
        continue
    penguin_mask |= (labeled == i)
print(f"penguin pixels (excluding edge-touching components): {penguin_mask.sum()}")

# 3. Crop to bounding box + 8% padding
ys, xs = np.where(penguin_mask)
y0, y1 = ys.min(), ys.max() + 1
x0, x1 = xs.min(), xs.max() + 1
pad_y = int((y1 - y0) * 0.08)
pad_x = int((x1 - x0) * 0.08)
y0 = max(0, y0 - pad_y); y1 = min(H, y1 + pad_y)
x0 = max(0, x0 - pad_x); x1 = min(W, x1 + pad_x)
cropped = penguin_mask[y0:y1, x0:x1]
print(f"cropped to {cropped.shape}")

# 4. iOS variant — RGB, radial gradient bg #0a0a0a center → #1a1a1a edge, penguin fills ~78%
SIDE = 1024

def radial_gradient_bg(size, inner=(10, 10, 10), outer=(22, 22, 22)):
    """Smooth radial gradient with dithering to hide 8-bit banding."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    cx = cy = (size - 1) / 2.0
    max_r = np.sqrt(cx * cx + cy * cy)
    r = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    t = np.clip(r / max_r, 0.0, 1.0)
    t = t ** 1.6  # softer ease so the inner area is mostly flat
    # Continuous-domain gradient in float
    canvas_f = np.zeros((size, size, 3), dtype=np.float32)
    for ch in range(3):
        canvas_f[:, :, ch] = inner[ch] * (1 - t) + outer[ch] * t
    # Dither — add ±0.5 noise before quantizing to uint8. Breaks up the visible bands.
    rng = np.random.default_rng(42)
    noise = rng.uniform(-0.5, 0.5, canvas_f.shape).astype(np.float32)
    return np.clip(canvas_f + noise, 0, 255).astype(np.uint8)

def compose(fill_ratio, with_bg=True):
    ratio = fill_ratio * SIDE / max(cropped.shape)
    new_h = int(cropped.shape[0] * ratio)
    new_w = int(cropped.shape[1] * ratio)
    penguin = Image.fromarray((cropped * 255).astype(np.uint8), mode="L").resize((new_w, new_h), Image.LANCZOS)
    mask = np.array(penguin) > 127
    y_off = (SIDE - new_h) // 2
    x_off = (SIDE - new_w) // 2
    if with_bg:
        canvas = radial_gradient_bg(SIDE)
        canvas[y_off:y_off + new_h, x_off:x_off + new_w][mask] = FG
        return Image.fromarray(canvas, mode="RGB")
    else:
        canvas = np.zeros((SIDE, SIDE, 4), dtype=np.uint8)
        canvas[y_off:y_off + new_h, x_off:x_off + new_w][mask] = [*FG, 255]
        return Image.fromarray(canvas, mode="RGBA")

compose(0.78, with_bg=True).save(OUT_ICON, "PNG", optimize=True)
print(f"iOS icon saved: {OUT_ICON}")

# 5. Splash — RGB with bg (same look as iOS icon, slightly smaller fill is fine for splash)
compose(0.55, with_bg=True).save(OUT_SPLASH, "PNG", optimize=True)
print(f"Splash icon saved: {OUT_SPLASH}")

# 6. Android adaptive foreground — RGBA transparent bg, penguin in centered ~55% (safe zone)
compose(0.55, with_bg=False).save(OUT_ADAPTIVE, "PNG", optimize=True)
print(f"Android adaptive foreground saved: {OUT_ADAPTIVE}")
