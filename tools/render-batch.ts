/**
 * Batch renderer for the parameter search.
 *
 * Reads a JSON job file - a list of {name, case, flavor, seed, params} - and
 * writes one PNG per entry. Kept separate from `render-refs.ts` so the search
 * driver can hand it hundreds of variants in a single process start; process
 * startup and module loading dominate otherwise.
 *
 *   node --import tsx tools/render-batch.ts <jobs.json> <outDir>
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, type Flavor, type WatercolorParams } from '../packages/watercolor/src/index.js';
// @ts-expect-error - plain JS helper, intentionally untyped
import { encodePng } from './png.mjs';
// @ts-expect-error - plain JS helper, intentionally untyped
import { CASES } from './cases.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Job {
  name: string;
  case: string;
  flavor: Flavor;
  seed?: number;
  supersample?: number;
  params?: Partial<WatercolorParams>;
}

const jobsPath = process.argv[2];
const outDir = resolve(root, process.argv[3] ?? 'out-search');
mkdirSync(outDir, { recursive: true });

const jobs: Job[] = JSON.parse(readFileSync(jobsPath, 'utf8'));
const byName = new Map<string, (typeof CASES)[number]>();
for (const c of CASES) byName.set(c.name, c);

const t0 = performance.now();
for (const job of jobs) {
  const c = byName.get(job.case);
  if (!c) throw new Error(`unknown case ${job.case}`);
  const r = render({
    shapes: [{ path: c.path, color: c.color, transform: c.transform }],
    viewBox: c.viewBox,
    width: c.width,
    height: c.height,
    fit: 'none',
    padding: 0,
    background: c.paper,
    supersample: job.supersample ?? 3,
    seed: job.seed ?? 7,
    flavor: job.flavor,
    params: job.params,
  });
  writeFileSync(join(outDir, `${job.case}__${job.name}.png`), encodePng(r.data, r.width, r.height));
}
console.log(`${jobs.length} renders in ${Math.round(performance.now() - t0)}ms -> ${outDir}`);
