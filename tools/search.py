"""Coordinate-descent fit of render parameters to a reference bitmap.

Renders candidate parameter sets through `tools/render-batch.ts`, scores each
against the reference with the same metrics `tools/compare.py` uses, and keeps
whatever improves the score. Averaged over several seeds, so it fits the
*distribution* the parameters produce rather than one lucky noise field - a
single-seed fit reliably overfits to whichever blotch happened to land well.

  python tools/search.py --case halfcircle1 --flavor wash --rounds 3
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from compare import analyse, load, score  # noqa: E402

# Parameter, and the candidate multipliers/offsets tried around the current value.
AXES = [
    ("intensity", "mul", [0.9, 0.95, 1.05, 1.1]),
    ("scattering", "mul", [0.7, 0.85, 1.2, 1.5]),
    ("pigmentDepth", "mul", [0.85, 0.95, 1.1, 1.25]),
    ("shading", "mul", [0.6, 0.8, 1.25, 1.6]),
    ("formDepth", "mul", [0.7, 0.85, 1.2, 1.5]),
    ("lightAngle", "add", [-40, -20, 20, 40]),
    ("lightElevation", "add", [-12, -6, 6, 12]),
    ("ambientOcclusion", "mul", [0.5, 0.75, 1.3, 1.8]),
    ("mottling", "mul", [0.6, 0.8, 1.25, 1.6]),
    ("mottleScale", "mul", [0.7, 0.85, 1.2, 1.45]),
    ("granulation", "mul", [0.6, 0.8, 1.25, 1.6]),
    ("blooms", "mul", [0.5, 0.8, 1.3, 1.8]),
    ("bloomScale", "mul", [0.7, 0.85, 1.2, 1.45]),
    ("bloomEdge", "add", [-0.2, -0.1, 0.1, 0.2]),
    ("edgeDarkening", "mul", [0.6, 0.8, 1.25, 1.6]),
    ("edgeDarkeningWidth", "mul", [0.7, 0.85, 1.2, 1.5]),
    ("edgeGravity", "add", [-0.25, -0.12, 0.12, 0.25]),
    ("edgeWobble", "mul", [0.6, 0.8, 1.3, 1.7]),
    ("edgeCrystal", "mul", [0.5, 0.8, 1.3, 1.8]),
    ("edgeSoftness", "mul", [0.75, 0.9, 1.1, 1.3]),
    ("paperTexture", "mul", [0.6, 0.8, 1.25, 1.6]),
    ("paperScale", "mul", [0.7, 0.85, 1.2, 1.45]),
]

LIMITS = {
    "intensity": (0.2, 2.5),
    "scattering": (0.05, 2.0),
    "pigmentDepth": (1.0, 4.0),
    "shading": (0.0, 2.0),
    "formDepth": (0.05, 1.2),
    "lightAngle": (0, 360),
    "lightElevation": (8, 88),
    "ambientOcclusion": (0.0, 1.5),
    "mottling": (0.0, 2.0),
    "mottleScale": (0.04, 1.0),
    "granulation": (0.0, 2.0),
    "blooms": (0.0, 2.0),
    "bloomScale": (0.04, 0.9),
    "bloomEdge": (0.0, 1.0),
    "edgeDarkening": (0.0, 2.0),
    "edgeDarkeningWidth": (0.003, 0.18),
    "edgeGravity": (0.0, 1.0),
    "edgeWobble": (0.0, 0.05),
    "edgeCrystal": (0.0, 0.025),
    "edgeSoftness": (0.35, 3.0),
    "paperTexture": (0.0, 1.5),
    "paperScale": (0.6, 10.0),
}


def clamp(key, v):
    lo, hi = LIMITS[key]
    return max(lo, min(hi, v))


def run_batch(jobs, out_dir):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(jobs, f)
        path = f.name
    try:
        r = subprocess.run(
            ["node", "--import", "tsx", "tools/render-batch.ts", path, out_dir],
            capture_output=True,
            text=True,
        )
        if r.returncode != 0:
            print(r.stdout, r.stderr)
            raise SystemExit("render-batch failed")
    finally:
        os.unlink(path)


def evaluate_many(case, flavor, variants, seeds, out_dir, ref, supersample):
    """Score several parameter sets in one node process.

    Process start and module load cost more than the renders themselves at
    these sizes, so every candidate along an axis goes in a single batch.
    """
    jobs = []
    for tag, params in variants:
        for s in seeds:
            jobs.append(
                {
                    "name": f"{tag}_s{s}",
                    "case": case,
                    "flavor": flavor,
                    "seed": s,
                    "supersample": supersample,
                    "params": params,
                }
            )
    run_batch(jobs, out_dir)
    out = []
    for tag, _ in variants:
        scores = []
        for s in seeds:
            g = analyse(load(os.path.join(out_dir, f"{case}__{tag}_s{s}.png")))
            scores.append(0.0 if g is None else score(ref, g)[0])
        out.append(float(np.mean(scores)))
    return out


def evaluate(case, flavor, params, seeds, out_dir, ref, tag, supersample):
    return evaluate_many(case, flavor, [(tag, params)], seeds, out_dir, ref, supersample)[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", required=True)
    ap.add_argument("--flavor", required=True)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--seeds", default="3,11,29")
    ap.add_argument("--supersample", type=int, default=2)
    ap.add_argument("--start", default="{}", help="JSON of starting overrides")
    args = ap.parse_args()

    seeds = [int(s) for s in args.seeds.split(",")]
    ref = analyse(load(f"references/{args.case}.png"))
    out_dir = os.path.join(tempfile.gettempdir(), f"wc_search_{args.case}_{args.flavor}")
    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(out_dir, exist_ok=True)

    # Start from the flavor preset, as the library resolves it.
    base = json.loads(args.start)
    defaults = json.loads(
        subprocess.run(
            ["node", "--import", "tsx", "-e",
             "import {resolveParams} from './packages/watercolor/src/index.ts';"
             f"console.log(JSON.stringify(resolveParams('{args.flavor}')))"],
            capture_output=True, text=True, check=True,
        ).stdout.strip().splitlines()[-1]
    )
    cur = dict(defaults)
    cur.update(base)

    best = evaluate(args.case, args.flavor, cur, seeds, out_dir, ref, "base", args.supersample)
    print(f"start {best:.2f}")

    n = 0
    for rnd in range(args.rounds):
        improved = False
        for key, kind, deltas in AXES:
            if key not in cur:
                continue
            cands = []
            for d in deltas:
                v = clamp(key, cur[key] * d if kind == "mul" else cur[key] + d)
                if abs(v - cur[key]) > 1e-9:
                    cands.append(v)
            if not cands:
                continue
            variants = []
            for v in cands:
                trial = dict(cur)
                trial[key] = v
                n += 1
                variants.append((f"t{n}", trial))
            got = evaluate_many(
                args.case, args.flavor, variants, seeds, out_dir, ref, args.supersample
            )
            results = sorted(zip(got, cands), reverse=True)
            if results[0][0] > best + 0.05:
                best = results[0][0]
                cur[key] = results[0][1]
                improved = True
                print(f"  r{rnd} {key:22s} -> {results[0][1]:.4g}   score {best:.2f}")
        if not improved:
            print(f"  r{rnd}: converged")
            break

    delta = {k: round(v, 5) for k, v in cur.items() if abs(v - defaults.get(k, v)) > 1e-9}
    print(f"\nbest {best:.2f}")
    print(json.dumps(delta, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
