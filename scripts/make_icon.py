#!/usr/bin/env python3
"""Build a clean full-bleed SmartSub app icon from the hand-prepared source
`docs/UI/logo-alpha.png` WITHOUT distorting the artwork.

The source fakes transparency with a baked checkerboard dither in the outer glow
(plus a watermark in the margin). Key insight: the squircle itself (black face +
gray bevel) is NEUTRAL (R≈G≈B), while the glow dither is either blue (saturated)
or bright white. So the squircle is exactly the "neutral AND not-bright" region.
We span-fill that to a solid silhouette and use it as the alpha — preserving the
squircle's real corners/bevel (no synthetic rounded rect) and dropping the
dithered glow + watermark entirely.
"""
import sys
import numpy as np
from PIL import Image, ImageFilter

SRC = sys.argv[1] if len(sys.argv) > 1 else "docs/UI/logo-alpha.png"
OUT = sys.argv[2] if len(sys.argv) > 2 else "assets/icon-master-1024.png"
SIZE = 1024
BRIGHT_MAX = 185   # squircle (incl. bevel) is darker than this; excludes faint shadow
SAT_MAX = 55       # squircle is neutral; blue glow is saturated -> excluded
ANCHOR_PAD = 100   # px around the dark body to bound the search region
MARGIN = 0.02      # transparent margin around the squircle in the final tile

im = Image.open(SRC).convert("RGB")
arr = np.asarray(im).astype(np.uint8)
W0, H0 = im.size
rgb = arr.astype(np.int16)
R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
mx = np.maximum(np.maximum(R, G), B)
mn = np.minimum(np.minimum(R, G), B)
lum = np.asarray(im.convert("L")).astype(np.int16)
print(f"source: {im.size}")

# Anchor region on the dark squircle face (robust; excludes glow + watermark).
body = lum < 80
ys, xs = np.where(body)
by0, by1, bx0, bx1 = ys.min(), ys.max(), xs.min(), xs.max()
rx0, ry0 = max(bx0 - ANCHOR_PAD, 0), max(by0 - ANCHOR_PAD, 0)
rx1, ry1 = min(bx1 + ANCHOR_PAD, W0), min(by1 + ANCHOR_PAD, H0)
print(f"dark-body bbox: x[{bx0},{bx1}] y[{by0},{by1}]  region pad={ANCHOR_PAD}")

# Squircle = neutral AND not-bright, inside the region (mark = saturated -> hole).
sat = (mx - mn)[ry0:ry1, rx0:rx1]
sub_lum = lum[ry0:ry1, rx0:rx1]
solid = (sub_lum < BRIGHT_MAX) & (sat < SAT_MAX)

# Convex horizontal span-fill -> solid squircle silhouette (fills mark + holes).
H, W = solid.shape
cols = np.arange(W)
rows_have = solid.any(1)
left = np.where(solid, cols[None, :], W).min(1)
right = np.where(solid, cols[None, :], -1).max(1)
sil = (cols[None, :] >= left[:, None]) & (cols[None, :] <= right[:, None]) & rows_have[:, None]

# Clamp to the dark-body bbox + a fixed bevel margin so the silhouette is a
# symmetric squircle (drops any faint neutral shadow/glow beyond the bevel).
BEVEL_PAD = 70
clamp = np.zeros_like(sil)
cy0 = max(by0 - BEVEL_PAD - ry0, 0)
cy1 = by1 + BEVEL_PAD - ry0
cx0 = max(bx0 - BEVEL_PAD - rx0, 0)
cx1 = bx1 + BEVEL_PAD - rx0
clamp[cy0:cy1, cx0:cx1] = True
sil &= clamp

# Light boundary smoothing (kills single-pixel ridges from the dither interface).
sil_img = Image.fromarray((sil * 255).astype("uint8")).filter(ImageFilter.MedianFilter(7))
sil = np.asarray(sil_img) > 127

sy, sx = np.where(sil)
sy0, sy1, sx0, sx1 = sy.min(), sy.max(), sx.min(), sx.max()
cx, cy = (sx0 + sx1) // 2 + rx0, (sy0 + sy1) // 2 + ry0
side = int(max(sx1 - sx0, sy1 - sy0) * (1 + 2 * MARGIN))
half = side // 2
print(f"silhouette {sx1 - sx0}x{sy1 - sy0} center=({cx},{cy}) tile={side}")

alpha_full = np.zeros((H0, W0), dtype=np.uint8)
alpha_full[ry0:ry1, rx0:rx1] = sil.astype(np.uint8) * 255
rgba = np.dstack([arr, alpha_full])

canvas = np.zeros((side, side, 4), dtype=np.uint8)
gx0, gy0 = cx - half, cy - half
ix0, iy0 = max(gx0, 0), max(gy0, 0)
ix1, iy1 = min(gx0 + side, W0), min(gy0 + side, H0)
canvas[iy0 - gy0:iy1 - gy0, ix0 - gx0:ix1 - gx0] = rgba[iy0:iy1, ix0:ix1]

out = Image.fromarray(canvas, "RGBA").resize((SIZE, SIZE), Image.LANCZOS)
a = out.getchannel("A").filter(ImageFilter.GaussianBlur(0.6))
out.putalpha(a)
out.save(OUT)
print(f"saved: {OUT} ({out.size})")
