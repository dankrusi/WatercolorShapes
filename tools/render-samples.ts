/**
 * Render the demo's built-in samples to `out-samples/`.
 *
 * These exercise the paths the reference cases do not: gradient fills, the
 * even-odd rule, overlapping shapes, and a transparent background.
 *
 *   node --import tsx tools/render-samples.ts [outDir]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, type Flavor } from '../packages/watercolor/src/index.js';
import { SAMPLES } from '../apps/demo/src/samples.js';
// @ts-expect-error - plain JS helper, intentionally untyped
import { encodePng } from './png.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, process.argv[2] ?? 'out-samples');
mkdirSync(outDir, { recursive: true });

const FLAVOR_BY_SAMPLE: Record<string, Flavor> = {
  'Half disc': 'wash',
  'Half disc, inverted': 'bloom',
  'Rounded diamond': 'granulate',
  Leaf: 'wash',
  Blob: 'fluid',
  'Ring (even-odd)': 'granulate',
  'Gradient sphere': 'wash',
  'Gradient sweep': 'layered',
  'Two shapes': 'wash',
};

let count = 0;
for (const sample of SAMPLES) {
  const flavor = FLAVOR_BY_SAMPLE[sample.name] ?? 'wash';
  const slug = sample.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const r = render({
    svg: sample.svg,
    width: 420,
    supersample: 3,
    padding: 0.05,
    seed: 12,
    flavor,
  });
  writeFileSync(join(outDir, `${slug}__${flavor}.png`), encodePng(r.data, r.width, r.height));
  count++;
}

// One transparent render, composited here over a dark backdrop so the alpha
// convention is visible rather than merely asserted.
const t = render({
  svg: SAMPLES[3].svg,
  width: 420,
  supersample: 3,
  padding: 0.05,
  seed: 12,
  flavor: 'wash',
  background: null,
});
const over = new Uint8ClampedArray(t.data.length);
for (let i = 0; i < t.data.length; i += 4) {
  const a = t.data[i + 3] / 255;
  over[i] = t.data[i] * a + 32 * (1 - a);
  over[i + 1] = t.data[i + 1] * a + 30 * (1 - a);
  over[i + 2] = t.data[i + 2] * a + 28 * (1 - a);
  over[i + 3] = 255;
}
writeFileSync(join(outDir, 'leaf__transparent-over-dark.png'), encodePng(over, t.width, t.height));
count++;

console.log(`wrote ${count} images to ${outDir}`);
