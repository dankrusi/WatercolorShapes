"""Build side-by-side contact sheets of reference vs renders.

  python tools/sheet.py --case halfcircle1 --zoom 3
  python tools/sheet.py --all
"""

from __future__ import annotations

import argparse
import glob
import os

from PIL import Image, ImageDraw

SCRATCH = os.environ.get(
    "WC_SHEET_DIR",
    r"C:/Users/dankrusi/AppData/Local/Temp/claude/D--Code-Misc-WatercolorShapes/"
    r"f6a6801c-eb52-4ced-8617-ab20b54a07c8/scratchpad/analysis",
)

CASES = ["halfcircle1", "halfcircle2", "roundedsquare"]


def build(case, zoom, out_dir, pattern):
    ref = Image.open(f"references/{case}.png").convert("RGB")
    files = sorted(glob.glob(os.path.join(out_dir, f"{case}__{pattern}.png")))
    tiles = [("reference", ref)]
    for f in files:
        label = os.path.basename(f)[:-4].split("__", 1)[1]
        tiles.append((label, Image.open(f).convert("RGB")))
    w, h = ref.size
    tw, th = w * zoom, h * zoom
    cols = min(4, len(tiles))
    rows = (len(tiles) + cols - 1) // cols
    pad, lab = 10, 16
    sheet = Image.new("RGB", (cols * (tw + pad) + pad, rows * (th + pad + lab) + pad), (250, 250, 250))
    d = ImageDraw.Draw(sheet)
    for i, (label, im) in enumerate(tiles):
        cx = pad + (i % cols) * (tw + pad)
        cy = pad + (i // cols) * (th + pad + lab)
        sheet.paste(im.resize((tw, th), Image.LANCZOS), (cx, cy))
        d.text((cx + 2, cy + th + 2), label, fill=(30, 30, 30))
    os.makedirs(SCRATCH, exist_ok=True)
    path = os.path.join(SCRATCH, f"sheet_{case}.png")
    sheet.save(path)
    print(path, sheet.size)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", default=None)
    ap.add_argument("--zoom", type=int, default=3)
    ap.add_argument("--out", default="out")
    ap.add_argument("--pattern", default="*")
    args = ap.parse_args()
    for c in [args.case] if args.case else CASES:
        build(c, args.zoom, args.out, args.pattern)


if __name__ == "__main__":
    main()
