"""Score rendered outputs against the reference bitmaps.

Compares the things that actually distinguish a convincing wash from a flat
fill, rather than per-pixel difference (which is meaningless here: the noise
is supposed to differ):

  coverage     - does the silhouette land in the same place
  tone         - mean and spread of pigment density inside the shape
  colour       - mean ink colour and its saturation spread
  spectrum     - how texture energy is distributed across spatial scales
  edge profile - density as a function of distance from the boundary
  edge sharp   - width of the transition from paper to full tone

Usage:  python tools/compare.py [--out out] [--sheet] [--filter substring]
"""

from __future__ import annotations

import argparse
import glob
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

W = np.array([0.2126, 0.7152, 0.0722])
BLUR_SCALES = [1, 2, 3, 4, 6, 8, 12, 20]


def load(path):
    return np.asarray(Image.open(path).convert("RGB")).astype(np.float64) / 255.0


def analyse(im):
    lum = im @ W
    corners = np.concatenate(
        [
            im[0:6, 0:6].reshape(-1, 3),
            im[0:6, -6:].reshape(-1, 3),
            im[-6:, 0:6].reshape(-1, 3),
            im[-6:, -6:].reshape(-1, 3),
        ]
    )
    paper = corners.mean(0)
    plum = paper @ W
    mask = lum < plum - 0.06
    mask = ndimage.binary_fill_holes(ndimage.binary_closing(mask, np.ones((3, 3))))
    # Keep only the largest blob: halfcircle2 carries a stray dark mark above
    # the shape that would otherwise skew every statistic below.
    lab, cnt = ndimage.label(mask)
    if cnt > 1:
        sizes = ndimage.sum(mask, lab, range(1, cnt + 1))
        mask = lab == (int(np.argmax(sizes)) + 1)
    if mask.sum() < 50:
        return None
    dist = ndimage.distance_transform_edt(mask)
    # Absolute optical density: how far below the paper each pixel sits. Not
    # normalised by the darkest pixel, which a single outlier would distort.
    dens = plum - lum

    wm = mask.astype(float)

    def blurm(a, s):
        return ndimage.gaussian_filter(a * wm, s) / np.maximum(
            ndimage.gaussian_filter(wm, s), 1e-4
        )

    detail = [float((dens - blurm(dens, s))[mask].std()) for s in BLUR_SCALES]

    prof = []
    for d in range(0, 12):
        sel = mask & (dist >= d) & (dist < d + 1)
        prof.append(float(dens[sel].mean()) if sel.sum() > 20 else float("nan"))

    ink = im[mask & (dist > 2)]
    mx, mn = ink.max(1), ink.min(1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)

    # Edge sharpness: how many pixels the density takes to climb from 20% to
    # 80% of its local interior value, measured along the boundary normal.
    edge = edge_width(dens, mask)

    return dict(
        paper=paper,
        coverage=float(mask.mean()),
        area=int(mask.sum()),
        mask=mask,
        dens=dens,
        dens_mean=float(dens[mask].mean()),
        dens_std=float(dens[mask].std()),
        detail=detail,
        prof=prof,
        ink_mean=ink.mean(0),
        sat_mean=float(sat.mean()),
        sat_std=float(sat.std()),
        edge_width=edge,
        deep=float(dens[mask & (dist > 8)].mean()) if (mask & (dist > 8)).sum() > 50 else float("nan"),
        rim=float(dens[mask & (dist >= 1) & (dist < 3)].mean()),
    )


def edge_width(dens, mask):
    """Mean 20-80% rise distance across the silhouette boundary."""
    out = ndimage.distance_transform_edt(~mask)
    inn = ndimage.distance_transform_edt(mask)
    signed = inn - out
    interior = dens[mask & (inn > 4)]
    if interior.size < 20:
        return float("nan")
    hi = np.percentile(interior, 40)
    lo20, hi80 = 0.2 * hi, 0.8 * hi
    band = (signed > -4) & (signed < 4)
    if band.sum() < 20:
        return float("nan")
    d = signed[band]
    v = dens[band]
    order = np.argsort(d)
    d, v = d[order], v[order]
    # Average the profile into 0.25px bins, then find where it crosses.
    bins = np.arange(-4, 4.01, 0.25)
    idx = np.digitize(d, bins) - 1
    prof = np.array([v[idx == k].mean() if (idx == k).sum() else np.nan for k in range(len(bins) - 1)])
    good = ~np.isnan(prof)
    if good.sum() < 4:
        return float("nan")
    centers = (bins[:-1] + 0.125)[good]
    prof = prof[good]
    try:
        x20 = np.interp(lo20, prof, centers)
        x80 = np.interp(hi80, prof, centers)
        return float(abs(x80 - x20))
    except Exception:
        return float("nan")


def fmt(v, n=3):
    if isinstance(v, float) and (np.isnan(v)):
        return "  nan"
    return f"{v:.{n}f}"


def hexc(c):
    return "#" + "".join("%02x" % int(round(max(0, min(1, x)) * 255)) for x in c)


def score(ref, got):
    """A single 0-100 similarity number. Higher is closer."""
    terms = []
    terms.append(("coverage", abs(ref["coverage"] - got["coverage"]) / max(1e-6, ref["coverage"]), 1.4))
    terms.append(("tone", abs(ref["dens_mean"] - got["dens_mean"]) / max(1e-6, ref["dens_mean"]), 1.6))
    terms.append(("spread", abs(ref["dens_std"] - got["dens_std"]) / max(1e-6, ref["dens_std"]), 1.2))
    dref = np.array(ref["detail"])
    dgot = np.array(got["detail"])
    terms.append(("texture", float(np.mean(np.abs(dref - dgot) / np.maximum(dref, 1e-4))), 1.8))
    dc = np.abs(np.array(ref["ink_mean"]) - np.array(got["ink_mean"])).mean()
    terms.append(("colour", dc / 0.15, 1.5))
    ew_ref, ew_got = ref["edge_width"], got["edge_width"]
    if not (np.isnan(ew_ref) or np.isnan(ew_got)):
        terms.append(("edge", abs(ew_ref - ew_got) / max(0.5, ew_ref), 1.0))
    rim_ref = ref["rim"] / max(1e-6, ref["deep"])
    rim_got = got["rim"] / max(1e-6, got["deep"])
    terms.append(("rim", abs(rim_ref - rim_got) / max(0.05, abs(rim_ref)), 0.8))
    wsum = sum(w for _, _, w in terms)
    err = sum(min(e, 2.0) * w for _, e, w in terms) / wsum
    return max(0.0, 100.0 * (1.0 - err / 1.2)), {k: round(e, 3) for k, e, _ in terms}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="out")
    ap.add_argument("--filter", default="")
    ap.add_argument("--top", type=int, default=0)
    args = ap.parse_args()

    refs = {}
    for name in ("halfcircle1", "halfcircle2", "roundedsquare"):
        refs[name] = analyse(load(f"references/{name}.png"))

    print("=== references ===")
    for name, r in refs.items():
        print(
            f"{name:14s} cov {fmt(r['coverage'])} tone {fmt(r['dens_mean'])} sd {fmt(r['dens_std'])} "
            f"ink {hexc(r['ink_mean'])} sat {fmt(r['sat_mean'])} edge {fmt(r['edge_width'],2)} "
            f"rim/deep {fmt(r['rim']/max(1e-6,r['deep']),3)}"
        )
        print("               detail " + " ".join(f"{d:.4f}" for d in r["detail"]))

    files = sorted(glob.glob(os.path.join(args.out, "*.png")))
    if args.filter:
        files = [f for f in files if args.filter in os.path.basename(f)]
    rows = []
    print("\n=== renders ===")
    for f in files:
        base = os.path.basename(f)[:-4]
        case = base.split("__")[0]
        if case not in refs:
            continue
        g = analyse(load(f))
        if g is None:
            print(f"{base:44s} EMPTY")
            continue
        s, parts = score(refs[case], g)
        rows.append((s, base, g, parts))

    rows.sort(key=lambda r: -r[0])
    if args.top:
        rows = rows[: args.top]
    for s, base, g, parts in rows:
        print(
            f"{s:5.1f} {base:44s} cov {fmt(g['coverage'])} tone {fmt(g['dens_mean'])} sd {fmt(g['dens_std'])} "
            f"ink {hexc(g['ink_mean'])} sat {fmt(g['sat_mean'])} edge {fmt(g['edge_width'],2)} "
            f"rim/deep {fmt(g['rim']/max(1e-6,g['deep']),3)}"
        )
        print("      detail " + " ".join(f"{d:.4f}" for d in g["detail"]) + "   " + str(parts))

    if rows:
        print(f"\nmean score {np.mean([r[0] for r in rows]):.1f}")


if __name__ == "__main__":
    sys.exit(main())
