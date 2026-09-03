/**
 * Timing benchmark across flavors, sizes and supersampling.
 *
 * The demo's animated mode runs at 8fps, so it has a 125ms budget per frame
 * and the ss=1 rows are the ones that matter. Reports the best of several runs
 * after a warm-up, because the first render of a given geometry also pays for
 * rasterisation and the distance transform, which are cached afterwards.
 *
 *   node --import tsx tools/bench.ts
 */

import { render, FLAVORS, type Flavor } from '../packages/watercolor/src/index.js';

const PATH =
  'M52 19.4 H124 A32.6 32.6 0 0 1 156.6 52 V124 A32.6 32.6 0 0 1 124 156.6 ' +
  'H52 A32.6 32.6 0 0 1 19.4 124 V52 A32.6 32.6 0 0 1 52 19.4 Z';

const CONFIGS: { width: number; supersample: number; label: string }[] = [
  { width: 384, supersample: 1, label: '384 ss1 (animation)' },
  { width: 640, supersample: 1, label: '640 ss1' },
  { width: 640, supersample: 2, label: '640 ss2 (default)' },
  { width: 1024, supersample: 3, label: '1024 ss3 (export)' },
];

const RUNS = 5;

function bench(flavor: Flavor, width: number, supersample: number): number {
  const opts = {
    path: PATH,
    color: '#41403c',
    transform: undefined,
    width,
    height: width,
    supersample,
    flavor,
  };
  render({ ...opts, seed: 0 });
  let best = Infinity;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    render({ ...opts, seed: 100 + i });
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

const rows: Record<string, Record<string, string>> = {};
for (const cfg of CONFIGS) {
  const row: Record<string, string> = {};
  for (const flavor of FLAVORS) {
    row[flavor] = `${Math.round(bench(flavor, cfg.width, cfg.supersample))}ms`;
  }
  rows[cfg.label] = row;
}
console.table(rows);
console.log('\n12fps needs every frame under 83ms.');
