/**
 * Render a scene's frames to PNG files, optionally with a contact sheet.
 *
 *   node --import tsx tools/render-scene.ts [options]
 *
 *     --scene plant        which scene
 *     --frames 24          how many frames, spread evenly from start to end
 *     --width 480          output width in pixels
 *     --ss 2               supersampling
 *     --flavor wash        algorithm
 *     --seed 7             paint seed
 *     --repaint 1          hold each paint seed for this many frames
 *     --layout 1           the scene's layout seed
 *     --padding 0.06       margin around the scene
 *     --transparent        export cut-outs instead of painting on the paper
 *     --out out-scene      destination folder
 *     --contact 6          also write a contact sheet with this many columns
 *     --only 0.5           render a single frame at this time instead
 *     --params '{"intensity":1.2}'   parameter overrides as JSON
 *     --options '{"roots":5}'        scene options as JSON (see the scene's `options`)
 *
 * Frame i of n is the scene at time i / (n - 1), so the last frame is the
 * finished scene. Files are numbered for anything that assembles a sequence:
 *
 *   ffmpeg -framerate 12 -i out-scene/plant-%04d.png -c:v libvpx-vp9 -pix_fmt yuva420p plant.webm
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getScene,
  normalizeSeed,
  render,
  resolveSceneOptions,
  SCENES,
  type Flavor,
  type WatercolorParams,
} from '../packages/watercolor/src/index.js';
// @ts-expect-error - plain JS helper, intentionally untyped
import { encodePng } from './png.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const next = argv[i + 1];
  if (next !== undefined && !next.startsWith('--')) {
    args.set(a.slice(2), next);
    i++;
  } else {
    args.set(a.slice(2), 'true');
  }
}
const num = (key: string, fallback: number): number => {
  const v = args.get(key);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const sceneId = args.get('scene') ?? 'plant';
const scene = getScene(sceneId);
if (!scene) {
  console.error(`unknown scene "${sceneId}"; have: ${SCENES.map((s) => s.id).join(', ')}`);
  process.exit(1);
}
const frames = Math.max(1, Math.round(num('frames', 24)));
const width = Math.round(num('width', 480));
const supersample = Math.round(num('ss', 2));
const flavor = (args.get('flavor') ?? 'wash') as Flavor;
const seed = Math.round(num('seed', 7));
const repaint = Math.max(1, Math.round(num('repaint', 1)));
const layout = Math.round(num('layout', 1));
const padding = num('padding', 0.06);
const transparent = args.has('transparent');
const outDir = resolve(root, args.get('out') ?? 'out-scene');
const contactCols = Math.round(num('contact', 0));
const only = args.has('only') ? num('only', 1) : null;
const params: Partial<WatercolorParams> = args.has('params')
  ? (JSON.parse(args.get('params') as string) as Partial<WatercolorParams>)
  : {};
const sceneOptions = resolveSceneOptions(
  scene.options,
  args.has('options') ? (JSON.parse(args.get('options') as string) as Record<string, unknown>) : null,
);
mkdirSync(outDir, { recursive: true });

const digits = Math.max(4, String(frames).length);
const times: number[] =
  only !== null
    ? [only]
    : Array.from({ length: frames }, (_, i) => (frames > 1 ? i / (frames - 1) : 1));

interface Done {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}
const rendered: Done[] = [];
const t0 = performance.now();
times.forEach((time, i) => {
  const frameSeed = normalizeSeed(`${seed}:frame:${Math.floor(i / repaint)}`);
  const shapes = scene.frame(time, layout, sceneOptions, frameSeed);
  const tf = performance.now();
  const r = render({
    shapes,
    viewBox: scene.viewBox,
    width,
    supersample,
    padding,
    seed: frameSeed,
    flavor,
    params,
    background: transparent ? null : undefined,
    bakePaper: true,
  });
  const name = only !== null ? `${scene.id}-t${time.toFixed(3)}.png` : `${scene.id}-${String(i + 1).padStart(digits, '0')}.png`;
  writeFileSync(join(outDir, name), encodePng(r.data, r.width, r.height));
  rendered.push({ data: r.data, width: r.width, height: r.height });
  console.log(
    `${name}  t=${time.toFixed(3)}  shapes=${shapes.length}  ${Math.round(performance.now() - tf)}ms`,
  );
});
console.log(`${times.length} frames in ${((performance.now() - t0) / 1000).toFixed(1)}s -> ${outDir}`);

if (contactCols > 0 && rendered.length > 0) {
  const cellW = Math.min(200, rendered[0].width);
  const scale = cellW / rendered[0].width;
  const cellH = Math.round(rendered[0].height * scale);
  const cols = Math.min(contactCols, rendered.length);
  const rows = Math.ceil(rendered.length / cols);
  const W = cols * cellW;
  const H = rows * cellH;
  const sheet = new Uint8ClampedArray(W * H * 4);
  sheet.fill(255);
  rendered.forEach((fr, idx) => {
    const cx = (idx % cols) * cellW;
    const cy = Math.floor(idx / cols) * cellH;
    const f = fr.width / cellW;
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        // Box average over the source pixels this cell pixel covers.
        const sx0 = Math.floor(x * f);
        const sy0 = Math.floor(y * f);
        const sx1 = Math.min(fr.width, Math.max(sx0 + 1, Math.floor((x + 1) * f)));
        const sy1 = Math.min(fr.height, Math.max(sy0 + 1, Math.floor((y + 1) * f)));
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          for (let sx = sx0; sx < sx1; sx++) {
            const si = (sy * fr.width + sx) * 4;
            const a = fr.data[si + 3] / 255;
            r += fr.data[si] * a + 255 * (1 - a);
            g += fr.data[si + 1] * a + 255 * (1 - a);
            b += fr.data[si + 2] * a + 255 * (1 - a);
            n++;
          }
        }
        const di = ((cy + y) * W + cx + x) * 4;
        sheet[di] = r / n;
        sheet[di + 1] = g / n;
        sheet[di + 2] = b / n;
        sheet[di + 3] = 255;
      }
    }
  });
  writeFileSync(join(outDir, 'contact.png'), encodePng(sheet, W, H));
  console.log(`contact sheet ${cols}x${rows} -> ${join(outDir, 'contact.png')}`);
}
