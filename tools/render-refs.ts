/**
 * Reference-comparison harness.
 *
 * Renders each fitted reference case with each flavor and writes PNGs into
 * `out/`, so `tools/compare.py` can score them against the originals.
 *
 *   node --import tsx tools/render-refs.ts [--flavors=a,b] [--seeds=1,2] [--out=dir]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, FLAVORS, type Flavor, type RenderOptions } from '../packages/watercolor/src/index.js';
// @ts-expect-error - plain JS helpers, intentionally untyped
import { encodePng } from './png.mjs';
// @ts-expect-error - plain JS helpers, intentionally untyped
import { CASES } from './cases.mjs';
// @ts-expect-error - plain JS helpers, intentionally untyped
import { TUNING } from './tuning.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const flavors = arg('flavors', FLAVORS.join(',')).split(',').filter(Boolean) as Flavor[];
const seeds = arg('seeds', '7').split(',').filter(Boolean);
const outDir = resolve(root, arg('out', 'out'));
mkdirSync(outDir, { recursive: true });

interface Case {
  name: string;
  width: number;
  height: number;
  viewBox: { x: number; y: number; width: number; height: number };
  path: string;
  transform?: string;
  color: string;
  paper: string;
}

let total = 0;
const report: Record<string, Record<string, number>> = {};

for (const c of CASES as Case[]) {
  for (const flavor of flavors) {
    const tuned = TUNING[c.name]?.[flavor] ?? TUNING[c.name]?.['*'] ?? {};
    for (const seed of seeds) {
      const options: RenderOptions = {
        shapes: [{ path: c.path, color: c.color, transform: c.transform }],
        viewBox: c.viewBox,
        width: c.width,
        height: c.height,
        fit: 'none',
        padding: 0,
        background: c.paper,
        supersample: 3,
        seed: Number(seed),
        flavor,
        params: tuned,
      };
      const t0 = performance.now();
      const r = render(options);
      const ms = performance.now() - t0;
      const file = join(outDir, `${c.name}__${flavor}__s${seed}.png`);
      writeFileSync(file, encodePng(r.data, r.width, r.height));
      report[c.name] ??= {};
      report[c.name][flavor] = Math.round(ms);
      total++;
    }
  }
}

console.log(`wrote ${total} images to ${outDir}`);
console.table(report);
