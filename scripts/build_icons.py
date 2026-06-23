#!/usr/bin/env python3
"""Generate all SmartSub brand raster assets from the master icon.

Inputs : assets/icon-master-1024.png (1024x1024 RGBA, transparent rounded corners)
Outputs:
  - resources/icon.png            (1024 RGBA, electron-builder source + dev icon)
  - docs/static/img/icon.png      (1024 RGBA, docs site)
  - resources/icon.ico            (multi-size Windows icon)
  - renderer/public/images/brand/logo-mark.png (512, in-app sidebar)
  - app/images/brand/logo-mark.png              (512, built/served copy)
  - assets/iconset/*.png          (macOS .iconset members for iconutil)
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = os.path.join(ROOT, "assets", "icon-master-1024.png")

master = Image.open(MASTER).convert("RGBA")
assert master.size == (1024, 1024), master.size


def save_png(path, size):
    p = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    img = master if size == 1024 else master.resize((size, size), Image.LANCZOS)
    img.save(p)
    print(f"png  {path} ({size})")


# 1024 sources
save_png("resources/icon.png", 1024)
save_png("docs/static/img/icon.png", 1024)

# in-app marks
save_png("renderer/public/images/brand/logo-mark.png", 512)
save_png("app/images/brand/logo-mark.png", 512)

# Windows multi-size .ico
ico_sizes = [16, 24, 32, 48, 64, 128, 256]
ico_path = os.path.join(ROOT, "resources", "icon.ico")
master.save(ico_path, format="ICO", sizes=[(s, s) for s in ico_sizes])
print(f"ico  resources/icon.ico {ico_sizes}")

# macOS .iconset members (consumed by iconutil; dir must end in .iconset)
iconset = os.path.join(ROOT, "assets", "icon.iconset")
os.makedirs(iconset, exist_ok=True)
members = {
    "icon_16x16.png": 16,
    "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32,
    "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128,
    "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256,
    "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512,
    "icon_512x512@2x.png": 1024,
}
for name, size in members.items():
    img = master if size == 1024 else master.resize((size, size), Image.LANCZOS)
    img.save(os.path.join(iconset, name))
print(f"iconset {len(members)} members -> assets/icon.iconset/")
