/**
 * Test suite. Run with `pnpm test` (tsx, no test framework).
 *
 * Covers the properties the renderer promises rather than exact pixels:
 * determinism, geometric correctness, the colour contract, and the
 * scale-invariance that makes `resolution` a zoom rather than a re-roll.
 */

import {
  BASE_PARAMS,
  FLAVORS,
  contourBounds,
  flattenPath,
  layerRT,
  parseColor,
  parseSvg,
  pigmentFromColor,
  rasterize,
  render,
  signedDistance,
  srgbToLinear,
  type Flavor,
} from '../src/index.js';
import { getScene, plantScene, SCENES } from '../src/scenes/index.js';
import { solvePigment } from '../src/color/solve.js';
import { compositePigment } from '../src/color/km.js';
import { Rng } from '../src/rng.js';
import type { RGB } from '../src/color/color.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    process.stdout.write('.');
  } catch (err) {
    failed++;
    failures.push(`${name}\n    ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write('x');
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function close(a: number, b: number, tol: number, msg: string): void {
  assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
}

const SQUARE = 'M20 20 H180 V180 H20 Z';
const DISC = 'M100 12 A88 88 0 1 1 99.9 12 Z';

// ------------------------------------------------------------------- rng --

test('rng is deterministic for the same seed', () => {
  const a = new Rng('abc');
  const b = new Rng('abc');
  for (let i = 0; i < 50; i++) close(a.next(), b.next(), 0, 'stream');
});

test('rng differs for nearby seeds', () => {
  const a = new Rng(1);
  const b = new Rng(2);
  let same = 0;
  for (let i = 0; i < 50; i++) if (a.next() === b.next()) same++;
  assert(same < 3, `streams for seed 1 and 2 overlapped ${same} times`);
});

test('rng stays in range', () => {
  const r = new Rng('range');
  for (let i = 0; i < 5000; i++) {
    const v = r.next();
    assert(v >= 0 && v < 1, `value ${v} out of [0,1)`);
  }
});

// ------------------------------------------------------------------ path --

test('flattens a rectangle to four corners', () => {
  const [c] = flattenPath(SQUARE);
  const b = contourBounds([c]);
  close(b.x, 20, 1e-6, 'x');
  close(b.y, 20, 1e-6, 'y');
  close(b.w, 160, 1e-6, 'w');
  close(b.h, 160, 1e-6, 'h');
});

test('flattens an arc-based circle to the right bounds', () => {
  const contours = flattenPath(DISC);
  const b = contourBounds(contours);
  close(b.w, 176, 0.5, 'width');
  close(b.h, 176, 0.5, 'height');
});

test('parses unseparated arc flags', () => {
  // "a5 5 0 0130 30" packs large-arc and sweep against the next coordinate.
  const contours = flattenPath('M10 10 a5 5 0 0130 30 Z');
  assert(contours.length === 1, 'expected one contour');
  const b = contourBounds(contours);
  assert(b.w > 20 && b.h > 20, `arc collapsed: ${JSON.stringify(b)}`);
});

test('handles relative commands and implicit line-tos', () => {
  const abs = flattenPath('M10 10 L50 10 L50 50 L10 50 Z');
  const rel = flattenPath('m10 10 l40 0 l0 40 l-40 0 z');
  const implicit = flattenPath('M10 10 50 10 50 50 10 50 Z');
  for (const c of [rel, implicit]) {
    const a = contourBounds(abs);
    const b = contourBounds(c);
    close(a.x, b.x, 1e-6, 'x');
    close(a.w, b.w, 1e-6, 'w');
    close(a.h, b.h, 1e-6, 'h');
  }
});

test('applies a transform', () => {
  const b = contourBounds(flattenPath(SQUARE, { a: 2, b: 0, c: 0, d: 2, e: 5, f: -5 }));
  close(b.x, 45, 1e-6, 'x');
  close(b.w, 320, 1e-6, 'w');
});

// -------------------------------------------------------------- raster ----

test('rasterised area matches the analytic area', () => {
  const contours = flattenPath(SQUARE);
  const cov = rasterize(contours, 200, 200, 'nonzero', 8);
  let sum = 0;
  for (let i = 0; i < cov.length; i++) sum += cov[i];
  close(sum, 160 * 160, 60, 'covered area');
});

test('coverage stays within [0,1]', () => {
  const cov = rasterize(flattenPath(DISC), 200, 200, 'nonzero', 8);
  for (let i = 0; i < cov.length; i++) {
    assert(cov[i] >= -1e-5 && cov[i] <= 1 + 1e-5, `coverage ${cov[i]} out of range`);
  }
});

test('even-odd fill leaves a hole where nonzero does not', () => {
  // Both contours wound the same way: the winding number inside the inner
  // circle is 2, so nonzero fills it and even-odd does not. Winding them
  // oppositely would make both rules agree and test nothing.
  const ring = 'M100 14 A86 86 0 1 1 99.9 14 Z M100 62 A38 38 0 1 1 99.9 62 Z';
  const contours = flattenPath(ring);
  const eo = rasterize(contours, 200, 200, 'evenodd', 8);
  const nz = rasterize(contours, 200, 200, 'nonzero', 8);
  const centre = 100 * 200 + 100;
  assert(eo[centre] < 0.05, `even-odd centre should be empty, got ${eo[centre]}`);
  assert(nz[centre] > 0.95, `nonzero centre should be filled, got ${nz[centre]}`);
});

test('signed distance is positive inside and negative outside', () => {
  const cov = rasterize(flattenPath(SQUARE), 200, 200, 'nonzero', 8);
  const sdf = signedDistance(cov, 200, 200);
  assert(sdf[100 * 200 + 100] > 70, 'centre should be deep inside');
  assert(sdf[5 * 200 + 5] < -10, 'corner should be outside');
  // On the boundary at x = 20, the field should be near zero.
  assert(Math.abs(sdf[100 * 200 + 20]) < 1.5, `edge sdf was ${sdf[100 * 200 + 20]}`);
});

// ----------------------------------------------------------------- colour --

test('parses the colour syntaxes the demo can emit', () => {
  close(parseColor('#ff0000').rgb[0], 1, 1e-9, 'hex6 red');
  close(parseColor('#f00').rgb[0], 1, 1e-9, 'hex3 red');
  close(parseColor('#ff000080').alpha, 0.502, 0.01, 'hex8 alpha');
  close(parseColor('rgb(0, 128, 255)').rgb[2], 1, 1e-9, 'rgb blue');
  close(parseColor('rgba(0,0,0,0.25)').alpha, 0.25, 1e-9, 'rgba alpha');
  close(parseColor('hsl(0, 100%, 50%)').rgb[0], 1, 1e-6, 'hsl red');
  close(parseColor('white').rgb[1], 1, 1e-9, 'named');
});

test('Kubelka-Munk transmittance falls monotonically with thickness', () => {
  const p = pigmentFromColor([0.2, 0.1, 0.05], 0.4, 1);
  let prev = 1;
  for (let x = 0; x <= 8; x += 0.25) {
    const [R, T] = layerRT(p.K[0], p.S[0], x);
    assert(T <= prev + 1e-9, `transmittance rose at x=${x}`);
    assert(R >= -1e-9 && R <= 1 + 1e-9, `reflectance ${R} out of range`);
    assert(T >= -1e-9 && T <= 1 + 1e-9, `transmittance ${T} out of range`);
    prev = T;
  }
});

test('a pigment solve reproduces its target colour', () => {
  const paper: RGB = [srgbToLinear(0.97), srgbToLinear(0.94), srgbToLinear(0.91)];
  for (const css of ['#ddb07c', '#41403c', '#2f5d7c', '#c4b29d', '#8a5a86']) {
    const c = parseColor(css).rgb;
    const target: RGB = [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
    const solved = solvePigment(target, paper, 2.2, 0.42, 1);
    const got: RGB = [0, 0, 0];
    compositePigment(solved.pigment, solved.thickness, paper, got);
    for (let ch = 0; ch < 3; ch++) {
      // Within one 8-bit step, measured in linear light near the target.
      close(got[ch], target[ch], Math.max(0.004, target[ch] * 0.06), `${css} channel ${ch}`);
    }
  }
});

test('a thicker layer of the same pigment is darker', () => {
  const paper: RGB = [0.9, 0.88, 0.85];
  const p = pigmentFromColor([0.15, 0.08, 0.04], 0.4, 1);
  const a: RGB = [0, 0, 0];
  const b: RGB = [0, 0, 0];
  compositePigment(p, 0.5, paper, a);
  compositePigment(p, 3.0, paper, b);
  const lum = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  assert(lum(b) < lum(a), 'thicker layer should be darker');
});

// -------------------------------------------------------------------- svg --

test('reads shapes, fills and viewBox from an SVG', () => {
  const svg =
    '<svg viewBox="0 0 100 50"><rect x="1" y="2" width="10" height="20" fill="#123456"/>' +
    '<circle cx="5" cy="5" r="3" fill="red"/><path d="M0 0 L1 1" fill="none"/></svg>';
  const p = parseSvg(svg);
  assert(p.shapes.length === 2, `expected 2 shapes, got ${p.shapes.length}`);
  assert(p.shapes[0].color === '#123456', 'rect fill');
  assert(p.viewBox?.width === 100, 'viewBox width');
});

test('applies inherited group transforms and fills', () => {
  const svg =
    '<svg viewBox="0 0 100 100"><g transform="translate(10 20)" fill="#abcdef">' +
    '<rect x="0" y="0" width="10" height="10"/></g></svg>';
  const p = parseSvg(svg);
  assert(p.shapes.length === 1, 'one shape');
  assert(p.shapes[0].color === '#abcdef', 'inherited fill');
  const b = contourBounds(flattenPath(p.shapes[0].path, undefined, 0.1));
  // The transform lives on the shape, so the raw path is still at the origin.
  close(b.x, 0, 1e-6, 'untransformed x');
  assert(/matrix/.test(p.shapes[0].transform ?? ''), 'transform recorded');
});

test('reads a linear gradient and its stops', () => {
  const svg =
    '<svg viewBox="0 0 10 10"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">' +
    '<stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/>' +
    '</linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>';
  const p = parseSvg(svg);
  assert(p.shapes.length === 1, 'one shape');
  const g = p.shapes[0].gradient;
  assert(g?.type === 'linear', 'linear gradient');
  assert(g?.stops.length === 2, `expected 2 stops, got ${g?.stops.length}`);
  assert(g?.stops[1].color === '#000', 'second stop colour');
});

test('honours style attributes and fill-opacity', () => {
  const svg =
    '<svg viewBox="0 0 10 10"><rect width="5" height="5" style="fill:#334455;fill-opacity:0.5"/>' +
    '<rect width="5" height="5" style="fill:none"/></svg>';
  const p = parseSvg(svg);
  assert(p.shapes.length === 1, `fill:none should be skipped, got ${p.shapes.length}`);
  assert(p.shapes[0].color === '#334455', 'style fill');
  close(p.shapes[0].opacity ?? 1, 0.5, 1e-9, 'fill-opacity');
});

// ----------------------------------------------------------------- render --

const baseOptions = { path: DISC, color: '#8a5a3c', width: 96, supersample: 1, seed: 42 } as const;

test('every flavor renders without error', () => {
  for (const flavor of FLAVORS) {
    const r = render({ ...baseOptions, flavor, params: { fluidSteps: 8 } });
    assert(r.width === 96 && r.height === 96, `${flavor} size`);
    assert(r.data.length === 96 * 96 * 4, `${flavor} buffer length`);
    let ink = 0;
    for (let i = 0; i < r.data.length; i += 4) if (r.data[i] < 200) ink++;
    assert(ink > 500, `${flavor} produced almost no pigment (${ink} px)`);
  }
});

test('the same seed reproduces the same image', () => {
  for (const flavor of FLAVORS) {
    const a = render({ ...baseOptions, flavor, params: { fluidSteps: 8 } });
    const b = render({ ...baseOptions, flavor, params: { fluidSteps: 8 } });
    for (let i = 0; i < a.data.length; i++) {
      if (a.data[i] !== b.data[i]) throw new Error(`${flavor} differed at byte ${i}`);
    }
  }
});

test('different seeds produce different images', () => {
  const a = render({ ...baseOptions, seed: 1 });
  const b = render({ ...baseOptions, seed: 2 });
  let diff = 0;
  for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== b.data[i]) diff++;
  assert(diff > a.data.length / 40, `only ${diff} pixels differed between seeds`);
});

test('an omitted seed is reported back and reproduces the image', () => {
  const a = render({ path: DISC, color: '#333', width: 64, supersample: 1 });
  const b = render({ path: DISC, color: '#333', width: 64, supersample: 1, seed: a.seed });
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] !== b.data[i]) throw new Error(`replay from reported seed differed at ${i}`);
  }
});

/** Everything that varies pigment load, turned off. */
const FLAT = {
  shading: 0,
  ambientOcclusion: 0,
  mottling: 0,
  granulation: 0,
  blooms: 0,
  edgeDarkening: 0,
  paperTexture: 0,
  pigmentDrift: 0,
} as const;

test('an unmodulated wash reproduces the requested colour exactly', () => {
  // The colour contract: `color` is the tone the wash carries at its nominal
  // pigment load. With nothing modulating that load, every interior pixel
  // should sit on it.
  for (const css of ['#ddb07c', '#41403c', '#2f5d7c', '#7a3b8a']) {
    const r = render({
      path: SQUARE,
      color: css,
      viewBox: { x: 0, y: 0, width: 200, height: 200 },
      width: 200,
      supersample: 1,
      padding: 0,
      fit: 'none',
      seed: 5,
      params: { ...FLAT },
    });
    const want = parseColor(css).rgb;
    const acc = [0, 0, 0];
    let n = 0;
    // Sample well inside, away from the rim.
    for (let y = 50; y < 150; y++) {
      for (let x = 50; x < 150; x++) {
        const i = (y * 200 + x) * 4;
        acc[0] += r.data[i];
        acc[1] += r.data[i + 1];
        acc[2] += r.data[i + 2];
        n++;
      }
    }
    for (let ch = 0; ch < 3; ch++) {
      close(acc[ch] / n / 255, want[ch], 0.012, `${css} channel ${ch}`);
    }
  }
});

test('a modulated wash still averages near the requested colour', () => {
  // With the defaults on, shading and texture spread the pigment load either
  // side of nominal. Colour is not linear in load, so the mean drifts - it
  // lands a little lighter, because the lit passages let more paper through
  // than the shadows hold back. That is what a painted version does too; the
  // test pins how far it is allowed to go.
  for (const css of ['#ddb07c', '#41403c', '#2f5d7c']) {
    const r = render({
      path: SQUARE,
      color: css,
      viewBox: { x: 0, y: 0, width: 200, height: 200 },
      width: 200,
      supersample: 1,
      padding: 0,
      fit: 'none',
      seed: 5,
    });
    const want = parseColor(css).rgb;
    const acc = [0, 0, 0];
    let n = 0;
    for (let y = 50; y < 150; y++) {
      for (let x = 50; x < 150; x++) {
        const i = (y * 200 + x) * 4;
        acc[0] += r.data[i];
        acc[1] += r.data[i + 1];
        acc[2] += r.data[i + 2];
        n++;
      }
    }
    for (let ch = 0; ch < 3; ch++) {
      close(acc[ch] / n / 255, want[ch], 0.1, `${css} channel ${ch}`);
    }
  }
});

test('intensity moves the wash monotonically darker', () => {
  const lum = (intensity: number): number => {
    const r = render({ ...baseOptions, params: { intensity, paperTexture: 0 } });
    let sum = 0;
    let n = 0;
    for (let i = 0; i < r.data.length; i += 4) {
      sum += 0.2126 * r.data[i] + 0.7152 * r.data[i + 1] + 0.0722 * r.data[i + 2];
      n++;
    }
    return sum / n;
  };
  const a = lum(0.4);
  const b = lum(1.0);
  const c = lum(2.0);
  assert(a > b && b > c, `expected monotone darkening, got ${a} > ${b} > ${c}`);
});

test('a transparent background leaves the paper clear', () => {
  const r = render({ ...baseOptions, background: null });
  // Corner is outside the disc.
  assert(r.data[3] === 0, `corner alpha was ${r.data[3]}`);
  const centre = ((48 * 96 + 48) * 4) | 0;
  // A wash is translucent, so its alpha is well under 1 even at full strength.
  assert(r.data[centre + 3] > 100, `centre alpha was ${r.data[centre + 3]}`);
});

test('a baked cut-out is opaque inside and matches the on-paper render', () => {
  const opts = {
    path: DISC,
    color: '#7a4a2a',
    width: 96,
    supersample: 1,
    seed: 42,
    background: '#f7efe8',
  } as const;
  const onPaper = render(opts);
  const cutout = render({ ...opts, background: null, bakePaper: true });

  // Outside the shape: nothing at all.
  assert(cutout.data[3] === 0, `corner alpha was ${cutout.data[3]}`);

  // Inside: fully opaque, however pale the passage. That is the point of
  // baking - the pigment itself carries no transparency.
  let interior = 0;
  let worst = 0;
  for (let y = 20; y < 76; y++) {
    for (let x = 20; x < 76; x++) {
      const i = (y * 96 + x) * 4;
      if (cutout.data[i + 3] < 250) continue;
      interior++;
      for (let ch = 0; ch < 3; ch++) {
        worst = Math.max(worst, Math.abs(cutout.data[i + ch] - onPaper.data[i + ch]));
      }
    }
  }
  assert(interior > 2000, `only ${interior} opaque interior pixels`);
  assert(worst === 0, `baked colour differed from the on-paper render by ${worst}`);
});

test('baking does not leave holes where a flavor lifted the pigment', () => {
  // Dry brush skips the tooth, so the wash is full of bare paper inside the
  // silhouette. Those are part of the cut-out, not gaps in it.
  const r = render({
    path: DISC,
    color: '#7a4a2a',
    width: 96,
    supersample: 1,
    seed: 3,
    flavor: 'drybrush',
    background: null,
    bakePaper: true,
  });
  let holes = 0;
  for (let y = 30; y < 66; y++) {
    for (let x = 30; x < 66; x++) {
      if (r.data[(y * 96 + x) * 4 + 3] < 250) holes++;
    }
  }
  assert(holes === 0, `${holes} interior pixels were not opaque`);
});

test('a transparent render composited over its paper matches the opaque one', () => {
  const opts = {
    path: DISC,
    color: '#7a4a2a',
    width: 96,
    supersample: 1,
    seed: 42,
    paper: '#ffffff',
  } as const;
  const overWhite = render({ ...opts, background: '#ffffff' });
  const transparent = render({ ...opts, background: null });
  let worst = 0;
  for (let i = 0; i < overWhite.data.length; i += 4) {
    const a = transparent.data[i + 3] / 255;
    for (let ch = 0; ch < 3; ch++) {
      const composited = transparent.data[i + ch] * a + 255 * (1 - a);
      worst = Math.max(worst, Math.abs(composited - overWhite.data[i + ch]));
    }
  }
  // Straight alpha cannot represent Kubelka-Munk exactly, but it should be
  // close enough that a viewer cannot tell which one they were handed.
  assert(worst < 12, `worst channel difference over white was ${worst.toFixed(1)}`);
});

test('paper is what the paint sits on, background is only what fills the image', () => {
  const opts = { path: DISC, color: '#7a4a2a', width: 64, supersample: 1, seed: 8 } as const;
  // Same paper, different background: the painted pixels must be identical.
  const onCream = render({ ...opts, background: '#f7efe8' });
  const cutout = render({ ...opts, background: null, bakePaper: true, paper: '#f7efe8' });
  let worst = 0;
  for (let i = 0; i < onCream.data.length; i += 4) {
    if (cutout.data[i + 3] < 250) continue;
    for (let ch = 0; ch < 3; ch++) {
      worst = Math.max(worst, Math.abs(cutout.data[i + ch] - onCream.data[i + ch]));
    }
  }
  assert(worst === 0, `baking against the same paper differed by ${worst}`);
});

test('gradient fills shade the wash along the gradient', () => {
  const r = render({
    shapes: [
      {
        path: SQUARE,
        gradient: {
          type: 'linear',
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 0,
          stops: [
            { offset: 0, color: '#f2e2d2' },
            { offset: 1, color: '#241a12' },
          ],
        },
      },
    ],
    viewBox: { x: 0, y: 0, width: 200, height: 200 },
    width: 200,
    supersample: 1,
    padding: 0,
    fit: 'none',
    seed: 3,
    params: { paperTexture: 0 },
  });
  const sample = (x: number): number => {
    let sum = 0;
    for (let y = 60; y < 140; y++) {
      const i = (y * 200 + x) * 4;
      sum += 0.2126 * r.data[i] + 0.7152 * r.data[i + 1] + 0.0722 * r.data[i + 2];
    }
    return sum / 80;
  };
  const left = sample(40);
  const right = sample(160);
  assert(left > right + 60, `gradient did not shade: left ${left}, right ${right}`);
});

test('multiple shapes composite in document order', () => {
  const r = render({
    shapes: [
      { path: 'M0 0 H120 V120 H0 Z', color: '#e8d8c8' },
      { path: 'M60 0 H200 V120 H60 Z', color: '#22303a' },
    ],
    viewBox: { x: 0, y: 0, width: 200, height: 120 },
    width: 200,
    supersample: 1,
    padding: 0,
    fit: 'none',
    seed: 9,
  });
  const at = (x: number, y: number): number => {
    const i = (y * 200 + x) * 4;
    return 0.2126 * r.data[i] + 0.7152 * r.data[i + 1] + 0.0722 * r.data[i + 2];
  };
  assert(at(30, 60) > 150, 'left square should be pale');
  assert(at(170, 60) < 110, 'right square should be dark');
  assert(at(90, 60) < 110, 'overlap should take the later, darker wash');
});

test('resolution scales the output without re-rolling the pattern', () => {
  const opts = { path: DISC, color: '#7a4a2a', width: 100, supersample: 1, seed: 11 } as const;
  const small = render(opts);
  const large = render({ ...opts, resolution: 2 });
  assert(large.width === 200 && large.height === 200, `got ${large.width}x${large.height}`);
  // Compare the two at the same scale: the large one downsampled 2x should
  // track the small one closely. It will not match exactly - finer detail is
  // genuinely resolved - but the large-scale structure must be the same
  // painting, not a different roll of the dice.
  let sum = 0;
  let n = 0;
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 100; x++) {
      let acc = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          acc += large.data[((y * 2 + dy) * 200 + x * 2 + dx) * 4];
        }
      }
      sum += Math.abs(acc / 4 - small.data[(y * 100 + x) * 4]);
      n++;
    }
  }
  const mad = sum / n;
  assert(mad < 12, `mean absolute difference across resolutions was ${mad.toFixed(2)}`);
});

test('supersampling changes quality, not composition', () => {
  const opts = { path: DISC, color: '#7a4a2a', width: 120, seed: 13 } as const;
  const a = render({ ...opts, supersample: 1 });
  const b = render({ ...opts, supersample: 3 });
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) sum += Math.abs(a.data[i] - b.data[i]);
  const mad = sum / (a.data.length / 4);
  assert(mad < 14, `mean absolute difference across supersampling was ${mad.toFixed(2)}`);
});

test('the shape lands where the viewBox says it should', () => {
  const r = render({
    path: 'M50 50 H150 V150 H50 Z',
    color: '#000000',
    viewBox: { x: 0, y: 0, width: 200, height: 200 },
    width: 200,
    supersample: 1,
    padding: 0,
    fit: 'none',
    seed: 2,
    params: { edgeWobble: 0, edgeCrystal: 0, fiberPinning: 0, paperTexture: 0 },
  });
  const dark = (x: number, y: number): boolean => r.data[(y * 200 + x) * 4] < 128;
  assert(!dark(40, 100), 'x=40 should be outside');
  assert(dark(60, 100), 'x=60 should be inside');
  assert(dark(140, 100), 'x=140 should be inside');
  assert(!dark(160, 100), 'x=160 should be outside');
});

test('a loose border strays from the outline differently on every seed', () => {
  const opts = {
    path: SQUARE,
    color: '#000000',
    width: 128,
    supersample: 1,
    background: null,
    bakePaper: true,
    params: { edgeWobble: 0, edgeCrystal: 0, fiberPinning: 0, borderLooseness: 1 },
  } as const;
  const silhouette = (seed: number, looseness: number): Uint8Array => {
    const r = render({ ...opts, seed, params: { ...opts.params, borderLooseness: looseness } });
    const s = new Uint8Array(r.width * r.height);
    for (let i = 0; i < s.length; i++) s[i] = r.data[i * 4 + 3] > 127 ? 1 : 0;
    return s;
  };
  const exact = silhouette(1, 0);
  const a = silhouette(1, 1);
  const b = silhouette(2, 1);
  let area = 0;
  let offExact = 0;
  let offOther = 0;
  for (let i = 0; i < exact.length; i++) {
    area += exact[i];
    if (a[i] !== exact[i]) offExact++;
    if (a[i] !== b[i]) offOther++;
  }
  assert(offExact > area * 0.02, `loose outline barely moved off the exact one (${offExact} px)`);
  assert(offOther > area * 0.02, `two seeds gave nearly the same loose outline (${offOther} px)`);
  assert(offExact < area * 0.25, `loose outline lost the shape (${offExact} of ${area} px)`);
});

test('border looseness only touches the wash flavor', () => {
  const plain = render({ ...baseOptions, flavor: 'bloom' });
  const loose = render({ ...baseOptions, flavor: 'bloom', params: { borderLooseness: 1 } });
  for (let i = 0; i < plain.data.length; i++) {
    if (plain.data[i] !== loose.data[i]) throw new Error(`bloom changed at byte ${i}`);
  }
});

test('an empty or unparseable path yields blank paper, not a crash', () => {
  for (const path of ['', '   ', 'not a path']) {
    const r = render({ path, color: '#000', width: 32, supersample: 1, seed: 1 });
    assert(r.data.length === 32 * 32 * 4, 'buffer size');
    assert(r.data[3] === 255, 'background should be opaque paper');
  }
});

test('every declared parameter has a slider spec, and vice versa', async () => {
  const { PARAM_SPECS } = await import('../src/types.js');
  const declared = new Set(Object.keys(BASE_PARAMS));
  const specced = new Set(PARAM_SPECS.map((s) => s.key));
  for (const k of declared) assert(specced.has(k as never), `parameter "${k}" has no slider spec`);
  for (const k of specced) assert(declared.has(k), `slider spec "${k}" is not a parameter`);
  for (const spec of PARAM_SPECS) {
    const v = BASE_PARAMS[spec.key];
    assert(v >= spec.min && v <= spec.max, `default ${spec.key}=${v} outside [${spec.min}, ${spec.max}]`);
  }
});

test('flavor presets stay inside their declared slider ranges', async () => {
  const { PARAM_SPECS, FLAVOR_PRESETS, resolveParams } = await import('../src/types.js');
  for (const flavor of FLAVORS as Flavor[]) {
    const p = resolveParams(flavor);
    for (const spec of PARAM_SPECS) {
      const v = p[spec.key];
      assert(
        v >= spec.min && v <= spec.max,
        `${flavor}.${spec.key} = ${v} outside [${spec.min}, ${spec.max}]`,
      );
    }
    for (const key of Object.keys(FLAVOR_PRESETS[flavor])) {
      assert(key in BASE_PARAMS, `${flavor} preset sets unknown parameter "${key}"`);
    }
  }
});

// ------------------------------------------------------------ many shapes --

/** Worst channel difference between two renders over a pixel rectangle. */
function worstOver(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  let worst = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      for (let ch = 0; ch < 4; ch++) worst = Math.max(worst, Math.abs(a[i + ch] - b[i + ch]));
    }
  }
  return worst;
}

const FAR = {
  viewBox: { x: 0, y: 0, width: 300, height: 160 },
  width: 300,
  supersample: 1,
  padding: 0,
  fit: 'none' as const,
  seed: 4,
};
const NEAR_CORNER = { path: 'M10 10 H50 V50 H10 Z', color: '#7a4a2a', seed: 'a' };
const FAR_CORNER = { path: 'M250 110 H290 V150 H250 Z', color: '#2f5d7c', seed: 'b' };

test('shapes far apart paint independently of each other', () => {
  // Each shape is worked in its own window, so a second shape elsewhere on
  // the sheet cannot change the first by so much as a bit.
  const alone = render({ ...FAR, shapes: [NEAR_CORNER] });
  const both = render({ ...FAR, shapes: [NEAR_CORNER, FAR_CORNER] });
  assert(alone.width === both.width, 'same size');
  const worst = worstOver(alone.data, both.data, 300, 0, 0, 70, 70);
  assert(worst === 0, `adding a distant shape changed the first by ${worst}`);
});

test('a shape with its own seed paints the same wherever it sits in the list', () => {
  const first = render({ ...FAR, shapes: [NEAR_CORNER, FAR_CORNER] });
  const second = render({ ...FAR, shapes: [FAR_CORNER, NEAR_CORNER] });
  const worst = worstOver(first.data, second.data, 300, 0, 0, 70, 70);
  assert(worst === 0, `reordering changed a seeded shape by ${worst}`);
});

test('without its own seed, a shape is still seeded by its position', () => {
  // The behaviour every existing render relies on: the list order is the seed.
  const a = { ...NEAR_CORNER, seed: undefined };
  const b = { ...FAR_CORNER, seed: undefined };
  const first = render({ ...FAR, shapes: [a, b] });
  const second = render({ ...FAR, shapes: [b, a] });
  const worst = worstOver(first.data, second.data, 300, 0, 0, 70, 70);
  assert(worst > 8, `reordering unseeded shapes barely changed the paint (${worst})`);
});

test('thin shapes keep continuous coverage', () => {
  // A 2px hair the full width of a 400px sheet. Edge effects scaled to its
  // bounding box would be wider than it is and break it into beads.
  const r = render({
    path: 'M10 199 H390 V201 H10 Z',
    color: '#333333',
    viewBox: { x: 0, y: 0, width: 400, height: 400 },
    width: 400,
    supersample: 1,
    padding: 0,
    fit: 'none',
    seed: 3,
    background: null,
    bakePaper: true,
  });
  let gaps = 0;
  for (let x = 20; x < 380; x++) {
    let covered = false;
    for (let y = 196; y < 204; y++) if (r.data[(y * 400 + x) * 4 + 3] > 100) covered = true;
    if (!covered) gaps++;
  }
  assert(gaps === 0, `the hair broke in ${gaps} columns`);
});

test('a pinned noise size keeps the paint still while the outline grows', () => {
  // The same bar at two lengths. With the noise size pinned to the final
  // length, the part they share is painted identically; left to the bounding
  // box, the texture re-scales with the length and the shared part differs.
  const common = {
    viewBox: { x: 0, y: 0, width: 300, height: 300 },
    width: 300,
    supersample: 1,
    padding: 0,
    fit: 'none' as const,
    seed: 9,
    params: { shading: 0, ambientOcclusion: 0, pigmentDrift: 0, edgeDarkening: 0, paperTexture: 0 },
  };
  const bar = (length: number, noiseSize?: number) =>
    render({
      ...common,
      shapes: [{ path: `M20 140 H${20 + length} V160 H20 Z`, color: '#7a4a2a', seed: 'bar', noiseSize }],
    });
  const pinnedWorst = worstOver(bar(140, 260).data, bar(240, 260).data, 300, 30, 142, 120, 158);
  const looseWorst = worstOver(bar(140).data, bar(240).data, 300, 30, 142, 120, 158);
  // Not quite zero: each shape's pigment is normalised over its own mask, and
  // the longer bar averages a little more texture into that normalisation.
  assert(pinnedWorst <= 4, `pinned texture moved by ${pinnedWorst}`);
  assert(looseWorst > 12, `unpinned texture should have re-scaled (${looseWorst})`);
});

// ----------------------------------------------------------------- scenes --

test('the scene registry finds scenes by id', () => {
  assert(SCENES.length >= 1, 'at least one scene');
  assert(getScene('plant') === plantScene, 'plant by id');
  assert(getScene('cathedral') === undefined, 'unknown id');
  assert(plantScene.duration > 0 && plantScene.viewBox.width > 0, 'scene metadata');
});

test('the plant grows: more shapes and more paint as time passes', () => {
  const times = [0, 0.15, 0.35, 0.6, 1];
  const frames = times.map((t) => plantScene.frame(t, 1));
  assert(frames[0].length === 1, `the start should be one seed, got ${frames[0].length}`);
  assert(frames[4].length > 30, `the finished plant should be many strokes, got ${frames[4].length}`);
  const extent = (shapes: ReturnType<typeof plantScene.frame>): number => {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of shapes) {
      const b = contourBounds(flattenPath(s.path, undefined, 0.5));
      if (b.h <= 0) continue;
      minY = Math.min(minY, b.y);
      maxY = Math.max(maxY, b.y + b.h);
    }
    return maxY - minY;
  };
  const extents = frames.map(extent);
  for (let i = 1; i < extents.length; i++) {
    assert(extents[i] >= extents[i - 1] - 1e-6, `the plant shrank between ${times[i - 1]} and ${times[i]}`);
  }
  assert(extents[4] > plantScene.viewBox.height * 0.7, `the finished plant only spans ${extents[4]} units`);
});

test('plant frames are deterministic and the layout seed moves the roots', () => {
  const a = JSON.stringify(plantScene.frame(0.7, 1));
  const b = JSON.stringify(plantScene.frame(0.7, 1));
  const c = JSON.stringify(plantScene.frame(0.7, 2));
  assert(a === b, 'the same time and layout seed gave different shapes');
  assert(a !== c, 'a different layout seed gave the same shapes');
});

test('every plant stroke carries a stable seed, a noise size and a usable path', () => {
  for (const t of [0.12, 0.5, 1]) {
    const ids = new Set<string>();
    for (const s of plantScene.frame(t, 1)) {
      assert(s.seed !== undefined, `a shape at t=${t} has no seed`);
      assert(!ids.has(String(s.seed)), `duplicate shape seed ${String(s.seed)} at t=${t}`);
      ids.add(String(s.seed));
      assert((s.noiseSize ?? 0) > 0, `shape ${String(s.seed)} has no noise size`);
      const b = contourBounds(flattenPath(s.path, undefined, 0.5));
      assert(b.w > 0 && b.h > 0, `shape ${String(s.seed)} at t=${t} has an empty path`);
      assert(
        b.x >= 0 && b.y >= 0 && b.x + b.w <= plantScene.viewBox.width && b.y + b.h <= plantScene.viewBox.height,
        `shape ${String(s.seed)} at t=${t} leaves the viewBox`,
      );
    }
  }
});

test('a scene frame renders through the ordinary pipeline', () => {
  const r = render({
    shapes: plantScene.frame(0.5, 1),
    viewBox: plantScene.viewBox,
    width: 96,
    supersample: 1,
    seed: 1,
    background: null,
    bakePaper: true,
  });
  let ink = 0;
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i] > 128) ink++;
  assert(ink > 200, `the half-grown plant covered only ${ink} pixels`);
  assert(r.data[3] === 0, 'the corner should be transparent');
});

// ------------------------------------------------------------------ done --

process.stdout.write('\n');
if (failures.length) {
  console.error(`\n${failed} failed:\n`);
  for (const f of failures) console.error(`  - ${f}\n`);
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
