/**
 * The renderer.
 *
 * Pipeline, in order:
 *
 *   1. flatten the input paths and work out the shape-to-canvas transform
 *   2. generate the paper substrate (shared by every later stage)
 *   3. rasterise exact coverage and build a signed distance field
 *   4. displace that field to get the wash boundary
 *   5. build the implied form and light it
 *   6. hand the fields to the chosen flavor, which returns pigment thickness
 *   7. composite through Kubelka-Munk onto the paper
 *   8. resolve the supersampling
 *
 * Stages 2-7 run once per input shape, compositing each wash over the last.
 */

import { downsample } from './field/blur.js';
import { maskFromSdf, perturbEdge } from './field/edge.js';
import { bloomField } from './flavors/bloom.js';
import { TextureCache, type FieldContext } from './flavors/common.js';
import { drybrushField } from './flavors/drybrush.js';
import { fluidField } from './flavors/fluid.js';
import { granulateField } from './flavors/granulate.js';
import { layeredField } from './flavors/layered.js';
import { washField } from './flavors/wash.js';
import { linearToSrgb, parseColor, srgbToLinear, toLinear, type RGB } from './color/color.js';
import { clamp01 } from './noise.js';
import { makePaper } from './paper.js';
import {
  contourBounds,
  flattenPath,
  multiply,
  parseTransform,
  type Contour,
  type Matrix,
} from './path/parse.js';
import { rasterize, signedDistance } from './path/raster.js';
import { computeEdgeRim, computeFormShading } from './shading/form.js';
import { computeGradientField, PigmentRamp, type ResolvedStop } from './shading/gradient.js';
import { parseSvg } from './svg/document.js';
import { normalizeSeed, Rng } from './rng.js';
import {
  FLAVOR_PRESETS,
  resolveParams,
  type Flavor,
  type RenderOptions,
  type RenderResult,
  type ShapeInput,
  type WatercolorParams,
} from './types.js';

const DEFAULT_PAPER = '#f7efe8';

const now: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

interface CachedGeometry {
  cov: Float32Array;
  sdf: Float32Array;
}

const GEOMETRY_CACHE_SIZE = 6;
const geometryCache = new Map<string, CachedGeometry>();

/** Drop the cached rasterisations. Useful in long-lived hosts. */
export function clearGeometryCache(): void {
  geometryCache.clear();
}

interface PreparedShape {
  input: ShapeInput;
  contours: Contour[];
  bounds: { x: number; y: number; w: number; h: number };
  matrix: Matrix;
}

/**
 * Render a watercolour interpretation of one or more SVG shapes.
 */
export function render(options: RenderOptions): RenderResult {
  const timings: Record<string, number> = {};
  const t0 = now();

  const seed = options.seed ?? Math.floor(Math.random() * 0xffffffff);
  const seedNum = normalizeSeed(seed);
  const flavor: Flavor = options.flavor ?? 'wash';
  const params = resolveParams(flavor, options.params);

  // --- 1. gather shapes --------------------------------------------------
  const shapes = collectShapes(options);
  if (shapes.length === 0) {
    return emptyResult(options, seed, flavor, timings);
  }

  const resolution = Math.max(0.05, options.resolution ?? 1);
  const ss = Math.max(1, Math.min(4, Math.round(options.supersample ?? 2)));
  const padding = Math.max(0, Math.min(0.45, options.padding ?? 0.04));
  const fit = options.fit ?? 'contain';

  // Flatten in the shape's own user space first, so bounds are known before
  // the fitting transform exists.
  const prepared: PreparedShape[] = shapes.map((input) => {
    const m = parseTransform(input.transform);
    const contours = flattenPath(input.path, m, 0.08);
    return { input, contours, bounds: contourBounds(contours), matrix: m };
  });
  const unionBounds = unionOf(prepared.map((s) => s.bounds));
  if (unionBounds.w <= 0 || unionBounds.h <= 0) {
    return emptyResult(options, seed, flavor, timings);
  }

  const source = options.viewBox ?? {
    x: unionBounds.x,
    y: unionBounds.y,
    width: unionBounds.w,
    height: unionBounds.h,
  };

  // --- 2. output geometry ------------------------------------------------
  const baseW = Math.max(1, Math.round(options.width ?? 512));
  const aspect = source.height / Math.max(1e-6, source.width);
  const baseH = Math.max(1, Math.round(options.height ?? Math.max(1, baseW * aspect)));
  const outW = Math.max(1, Math.round(baseW * resolution));
  const outH = Math.max(1, Math.round(baseH * resolution));
  const W = outW * ss;
  const H = outH * ss;

  const pad = padding * Math.min(W, H);
  let scale: number;
  let tx: number;
  let ty: number;
  if (fit === 'contain') {
    scale = Math.min((W - 2 * pad) / source.width, (H - 2 * pad) / source.height);
    tx = (W - source.width * scale) / 2 - source.x * scale;
    ty = (H - source.height * scale) / 2 - source.y * scale;
  } else {
    scale = Math.min(W / source.width, H / source.height);
    tx = -source.x * scale;
    ty = -source.y * scale;
  }
  const toDevice: Matrix = { a: scale, b: 0, c: 0, d: scale, e: tx, f: ty };

  const shapeSize = Math.max(unionBounds.w, unionBounds.h) * scale;
  timings.setup = now() - t0;

  // --- 3. paper ----------------------------------------------------------
  const tPaper = now();
  const backgroundCss = options.background === undefined ? DEFAULT_PAPER : options.background;
  const transparent = backgroundCss === null;
  const paperCss = options.paper ?? backgroundCss ?? DEFAULT_PAPER;
  const paperParsed = parseColor(paperCss);
  const paperLinear = toLinear(paperParsed.rgb);
  const bakePaper = transparent && (options.bakePaper ?? false);
  const paper = makePaper(W, H, {
    scale: Math.max(0.6, params.paperScale * resolution * ss),
    seed: seedNum ^ 0x27182818,
    roughness: 0.62,
  });
  timings.paper = now() - tPaper;

  // --- 4. accumulate washes ---------------------------------------------
  const colorBuf = new Float32Array(W * H * 3);
  // How much pigment ended up at each pixel. Drives how far the paper grain is
  // buried, and is the output alpha for a physically transparent render.
  const inkBuf = new Float32Array(W * H);
  // Silhouette coverage, needed only for a baked cut-out, where the alpha is
  // geometric rather than optical. Allocated lazily: at export resolutions it
  // is another 37MB.
  const coverBuf = transparent && bakePaper ? new Float32Array(W * H) : null;
  for (let i = 0, j = 0; i < W * H; i++, j += 3) {
    colorBuf[j] = paperLinear[0];
    colorBuf[j + 1] = paperLinear[1];
    colorBuf[j + 2] = paperLinear[2];
  }

  const rng = new Rng(`root:${seedNum}`);
  for (let si = 0; si < prepared.length; si++) {
    const shapeSeed = normalizeSeed(`${seedNum}:${si}:${Math.floor(rng.next() * 1e9)}`);
    paintShape(
      prepared[si],
      si,
      { W, H, ss, shapeSize, toDevice, paper, paperLinear, transparent, bakePaper },
      params,
      flavor,
      shapeSeed,
      colorBuf,
      inkBuf,
      coverBuf,
      timings,
    );
  }

  // --- 5. paper grain on the surface ------------------------------------
  const tGrain = now();
  if (params.paperTexture > 0) {
    const amp = params.paperTexture * 0.16;
    for (let i = 0, j = 0; i < W * H; i++, j += 3) {
      // The grain reads strongly on bare paper and is progressively buried by
      // pigment, because the wash fills the pits it would otherwise shadow.
      const k = 1 + (paper[i] - 0.5) * amp * (1 - 0.55 * clamp01(inkBuf[i]));
      colorBuf[j] *= k;
      colorBuf[j + 1] *= k;
      colorBuf[j + 2] *= k;
    }
  }
  timings.grain = now() - tGrain;

  // --- 6. resolve --------------------------------------------------------
  const tResolve = now();
  const data = new Uint8ClampedArray(outW * outH * 4);
  const n = outW * outH;
  let srcR: Float32Array;
  let srcG: Float32Array;
  let srcB: Float32Array;
  let srcA: Float32Array;
  if (ss === 1) {
    srcR = new Float32Array(n);
    srcG = new Float32Array(n);
    srcB = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      srcR[i] = colorBuf[j];
      srcG[i] = colorBuf[j + 1];
      srcB[i] = colorBuf[j + 2];
    }
    srcA = coverBuf ?? inkBuf;
  } else {
    const chR = new Float32Array(W * H);
    const chG = new Float32Array(W * H);
    const chB = new Float32Array(W * H);
    for (let i = 0, j = 0; i < W * H; i++, j += 3) {
      chR[i] = colorBuf[j];
      chG[i] = colorBuf[j + 1];
      chB[i] = colorBuf[j + 2];
    }
    // Averaged in linear light, which is the whole point of carrying the
    // pipeline in linear light: resolving in sRGB would lighten every edge.
    srcR = downsample(chR, W, H, ss).data;
    srcG = downsample(chG, W, H, ss).data;
    srcB = downsample(chB, W, H, ss).data;
    srcA = downsample(coverBuf ?? inkBuf, W, H, ss).data;
  }

  const paperSrgb: RGB = [
    linearToSrgb(paperLinear[0]),
    linearToSrgb(paperLinear[1]),
    linearToSrgb(paperLinear[2]),
  ];
  const cs: RGB = [0, 0, 0];
  for (let i = 0, k = 0; i < n; i++, k += 4) {
    cs[0] = linearToSrgb(srcR[i]);
    cs[1] = linearToSrgb(srcG[i]);
    cs[2] = linearToSrgb(srcB[i]);
    if (!transparent) {
      data[k] = Math.round(cs[0] * 255);
      data[k + 1] = Math.round(cs[1] * 255);
      data[k + 2] = Math.round(cs[2] * 255);
      data[k + 3] = 255;
      continue;
    }
    let a = clamp01(srcA[i]);
    if (a <= 0.003) {
      data[k] = 0;
      data[k + 1] = 0;
      data[k + 2] = 0;
      data[k + 3] = 0;
      continue;
    }
    if (bakePaper) {
      // The paper is already in the buffer, so the colour is emitted as-is and
      // the alpha is pure silhouette. Nothing to undo: this pixel is exactly
      // what the opaque render would have shown.
      data[k] = Math.round(cs[0] * 255);
      data[k + 1] = Math.round(cs[1] * 255);
      data[k + 2] = Math.round(cs[2] * 255);
      data[k + 3] = Math.round(a * 255);
      continue;
    }
    // The straight colour is recovered in sRGB, not in linear light, because
    // that is the space every consumer of an RGBA PNG will composite it in:
    // canvas, CSS, and every image editor blend alpha on the encoded values.
    // Undoing the paper in linear light and letting the viewer put a backdrop
    // back in sRGB leaves a large, visible error in exactly the pale passages
    // where a wash is most transparent.
    //
    // The physical hiding power is a floor, not the final answer: one alpha
    // cannot carry three transmittances, so where the pigment blocks one
    // channel far harder than another it is raised until the subtraction
    // below stays non-negative in every channel. Compositing the result back
    // over the paper then reproduces the opaque render exactly.
    let need = 0;
    for (let ch = 0; ch < 3; ch++) {
      const p = paperSrgb[ch];
      if (p > 1e-4) need = Math.max(need, 1 - cs[ch] / p);
    }
    if (need > a) a = clamp01(need);
    const inv = 1 / a;
    data[k] = Math.round(clamp01((cs[0] - paperSrgb[0] * (1 - a)) * inv) * 255);
    data[k + 1] = Math.round(clamp01((cs[1] - paperSrgb[1] * (1 - a)) * inv) * 255);
    data[k + 2] = Math.round(clamp01((cs[2] - paperSrgb[2] * (1 - a)) * inv) * 255);
    data[k + 3] = Math.round(a * 255);
  }
  timings.resolve = now() - tResolve;
  timings.total = now() - t0;

  return { width: outW, height: outH, data, seed, flavor, timings };
}

interface Frame {
  W: number;
  H: number;
  ss: number;
  shapeSize: number;
  toDevice: Matrix;
  paper: Float32Array;
  paperLinear: RGB;
  transparent: boolean;
  bakePaper: boolean;
}

function paintShape(
  shape: PreparedShape,
  index: number,
  frame: Frame,
  params: WatercolorParams,
  flavor: Flavor,
  seedNum: number,
  colorBuf: Float32Array,
  inkBuf: Float32Array,
  coverBuf: Float32Array | null,
  timings: Record<string, number>,
): void {
  const { W, H, ss, paper } = frame;
  const n = W * H;

  // Device-space contours for this shape.
  const m = multiply(frame.toDevice, shape.matrix);
  const contours = flattenPath(shape.input.path, m, 0.06);
  const bounds = contourBounds(contours);
  if (bounds.w <= 0 || bounds.h <= 0) return;
  const shapeSize = Math.max(bounds.w, bounds.h);

  const tRaster = now();
  // Sub-scanlines only need to make up for what supersampling does not
  // already provide: at ss = 3 the two together give 12 vertical samples per
  // output pixel, past the point of visible difference.
  const subScanlines = ss >= 3 ? 3 : ss === 2 ? 5 : 8;
  const fillRule = shape.input.fillRule ?? 'nonzero';
  // Rasterisation and the distance transform depend only on the geometry, not
  // on the seed or on any paint parameter. Both of the ways this library gets
  // used interactively - dragging a slider, and stepping the seed at 12fps -
  // hold the geometry fixed and change everything else, so caching the pair
  // removes a fifth of the frame cost from both.
  const geomKey = `${shape.input.path}|${fillRule}|${W}x${H}|${subScanlines}|${m.a},${m.b},${m.c},${m.d},${m.e},${m.f}`;
  let geom = geometryCache.get(geomKey);
  if (geom) {
    // Refresh recency.
    geometryCache.delete(geomKey);
    geometryCache.set(geomKey, geom);
  } else {
    const cov = rasterize(contours, W, H, fillRule, subScanlines);
    geom = { cov, sdf: signedDistance(cov, W, H) };
    geometryCache.set(geomKey, geom);
    while (geometryCache.size > GEOMETRY_CACHE_SIZE) {
      const oldest = geometryCache.keys().next().value as string;
      geometryCache.delete(oldest);
    }
  }
  const sdf = geom.sdf;
  timings.raster = (timings.raster ?? 0) + (now() - tRaster);

  // --- boundary ----------------------------------------------------------
  const tEdge = now();
  const wetSdf = perturbEdge({
    sdf,
    width: W,
    height: H,
    shapeSize,
    paper,
    seed: seedNum,
    wobble: params.edgeWobble,
    detail: params.edgeDetail,
    crystal: params.edgeCrystal,
    fiber: params.fiberPinning,
  });
  // Edge softness is quoted in output pixels, so scale it into working space.
  const mask = maskFromSdf(wetSdf, params.edgeSoftness * ss, undefined);
  timings.edge = (timings.edge ?? 0) + (now() - tEdge);

  // --- shading -----------------------------------------------------------
  const tShade = now();
  const form = computeFormShading({
    sdf,
    mask,
    width: W,
    height: H,
    shapeSize,
    lightAngle: params.lightAngle,
    lightElevation: params.lightElevation,
    formDepth: params.formDepth,
    formSoftness: params.formSoftness,
  });
  const rim = computeEdgeRim(
    wetSdf,
    W,
    H,
    Math.max(1, params.edgeDarkeningWidth * shapeSize),
    Math.max(0.4, 0.5 * ss),
    params.edgeGravity,
  );
  timings.shading = (timings.shading ?? 0) + (now() - tShade);

  // --- pigment colour ----------------------------------------------------
  const gradient = shape.input.gradient;
  let stops: ResolvedStop[];
  let gradientT: Float32Array | null = null;
  let gradientThickness: Float32Array | null = null;

  if (gradient) {
    const field = computeGradientField(gradient, W, H, bounds, m);
    gradientT = field.t;
    stops = field.stops;
  } else {
    const parsed = parseColor(shape.input.color ?? '#000000');
    const baseLinear: RGB = [
      srgbToLinear(parsed.rgb[0]),
      srgbToLinear(parsed.rgb[1]),
      srgbToLinear(parsed.rgb[2]),
    ];
    // Two-point ramp standing in for pigment drift: the shadow side of a wash
    // sits a little cooler and the lit side a little warmer, because the
    // thicker film scatters less of the short wavelengths back out.
    stops = driftStops(baseLinear, params.pigmentDrift, parsed.alpha);
  }

  const ramp = new PigmentRamp(
    stops,
    frame.paperLinear,
    params.scattering,
    params.bodyStrength,
    params.pigmentDepth,
    gradient ? 24 : 12,
  );
  const nominal = ramp.meanNominal;

  if (gradient && gradientT) {
    // The gradient's own value run becomes pigment thickness, so a shape
    // filled with a light-to-dark ramp comes out shaded by that ramp rather
    // than by an invented light.
    gradientThickness = new Float32Array(n);
    const inv = 1 / Math.max(1e-6, nominal);
    for (let i = 0; i < n; i++) gradientThickness[i] = ramp.nominalAt(gradientT[i]) * inv;
  }

  const ctx: FieldContext = {
    width: W,
    height: H,
    shapeSize,
    sdf,
    wetSdf,
    mask,
    paper,
    form,
    rim,
    gradientT,
    gradientThickness,
    params,
    seed: seedNum,
    unit: 1 / Math.max(1, shapeSize),
    tex: new TextureCache(W, H, 1 / Math.max(1, shapeSize), shapeSize, paper, params, seedNum),
  };

  // --- flavor ------------------------------------------------------------
  const tFlavor = now();
  let thickness: Float32Array;
  switch (flavor) {
    case 'granulate':
      thickness = granulateField(ctx);
      break;
    case 'bloom':
      thickness = bloomField(ctx);
      break;
    case 'fluid':
      thickness = fluidField(ctx);
      break;
    case 'drybrush':
      thickness = drybrushField(ctx);
      break;
    case 'layered':
      thickness = layeredField(ctx);
      break;
    default:
      thickness = washField(ctx);
      break;
  }
  // The fluid flavor folds the gradient into its initial load; the others
  // apply it here.
  if (gradientThickness && flavor !== 'fluid') {
    for (let i = 0; i < n; i++) thickness[i] *= gradientThickness[i];
  }
  timings.flavor = (timings.flavor ?? 0) + (now() - tFlavor);

  // --- composite ---------------------------------------------------------
  const tComp = now();
  // Normalise the flavor's thickness field so the *average* pixel composites
  // to exactly the colour that was asked for. Whatever a flavor does to the
  // distribution, the shape still reads as the requested colour, and
  // `intensity` moves it lighter or heavier from there.
  const meanT = meanOverMask(thickness, mask);
  const scaleT = (nominal / Math.max(1e-4, meanT)) * params.intensity;
  const full = nominal;

  const shapeAlpha = shape.input.opacity ?? 1;
  const rampT = gradientT;
  const col: RGB = [0, 0, 0];
  const backdrop: RGB = [0, 0, 0];
  // The lookup tables were built against the paper, so they are only valid
  // for the first wash. A second shape sits on whatever the first left behind
  // and has to evaluate Kubelka-Munk against that.
  const useLut = index === 0;

  for (let i = 0; i < n; i++) {
    const mk = mask[i];
    if (mk <= 0.0006) continue;
    // Coverage is recorded before the pigment early-outs below: a passage the
    // flavor lifted back to bare paper - a dry-brush skip, say - is still
    // inside the cut-out, and must come out opaque paper rather than a hole.
    if (coverBuf) {
      const cover = mk * shapeAlpha;
      if (cover > coverBuf[i]) coverBuf[i] = cover;
    }
    const th = thickness[i] * scaleT;
    if (th <= 1e-5) continue;
    // Flat fills index the ramp by the light term so the drift follows the
    // form; gradient fills index it by the gradient's own parameter.
    const t = rampT ? rampT[i] : 1 - form.light[i];
    let a: number;
    const j = i * 3;
    if (useLut) {
      a = ramp.sample(t, th, col);
    } else {
      backdrop[0] = colorBuf[j];
      backdrop[1] = colorBuf[j + 1];
      backdrop[2] = colorBuf[j + 2];
      a = ramp.compositeOver(t, th, backdrop, col);
    }
    const w = a * shapeAlpha;
    if (w >= 0.999) {
      colorBuf[j] = col[0];
      colorBuf[j + 1] = col[1];
      colorBuf[j + 2] = col[2];
    } else {
      colorBuf[j] += (col[0] - colorBuf[j]) * w;
      colorBuf[j + 1] += (col[1] - colorBuf[j + 1]) * w;
      colorBuf[j + 2] += (col[2] - colorBuf[j + 2]) * w;
    }
    if (frame.transparent && !frame.bakePaper) {
      // Straight alpha for a transparent background: how much of what is
      // behind this layer it actually hides.
      const hide = ramp.hiding(t, th) * w;
      inkBuf[i] = inkBuf[i] + (1 - inkBuf[i]) * hide;
    } else {
      inkBuf[i] = Math.max(inkBuf[i], clamp01(th / Math.max(1e-4, full)));
    }
  }
  timings.composite = (timings.composite ?? 0) + (now() - tComp);
}

/** Two stops standing in for the warm/cool drift across a single pigment. */
function driftStops(base: RGB, drift: number, alpha: number): ResolvedStop[] {
  if (drift <= 1e-4) {
    return [
      { offset: 0, rgbLinear: base, alpha },
      { offset: 1, rgbLinear: base, alpha },
    ];
  }
  const d = Math.min(1, drift);
  const warm = preserveLuminance(base, [1 + 0.16 * d, 1 + 0.03 * d, 1 - 0.2 * d]);
  const cool = preserveLuminance(base, [1 - 0.13 * d, 1 - 0.04 * d, 1 + 0.24 * d]);
  // t = 0 is the lit end (light term high), t = 1 the shadow end.
  return [
    { offset: 0, rgbLinear: warm, alpha },
    { offset: 1, rgbLinear: cool, alpha },
  ];
}

function preserveLuminance(c: RGB, k: RGB): RGB {
  const out: RGB = [c[0] * k[0], c[1] * k[1], c[2] * k[2]];
  const l0 = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const l1 = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
  const f = l1 > 1e-6 ? l0 / l1 : 1;
  return [clamp01(out[0] * f), clamp01(out[1] * f), clamp01(out[2] * f)];
}

function meanOverMask(field: Float32Array, mask: Float32Array): number {
  let sum = 0;
  let wsum = 0;
  for (let i = 0; i < field.length; i++) {
    const m = mask[i];
    if (m <= 0.5) continue;
    sum += field[i];
    wsum += 1;
  }
  return wsum > 0 ? sum / wsum : 1;
}

function unionOf(list: { x: number; y: number; w: number; h: number }[]): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const b of list) {
    if (b.w <= 0 || b.h <= 0) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function collectShapes(options: RenderOptions): ShapeInput[] {
  let shapes: ShapeInput[] = [];
  if (options.shapes && options.shapes.length) {
    shapes = options.shapes.slice();
  } else if (options.svg) {
    shapes = parseSvg(options.svg).shapes;
  } else if (options.path) {
    shapes = [{ path: options.path }];
  }
  return shapes
    .filter((s) => s.path && s.path.trim().length > 0)
    .map((s) => ({
      ...s,
      color: s.gradient ? undefined : (s.color ?? options.color ?? '#2b2b2b'),
      gradient: s.gradient ?? (s.color ? undefined : options.gradient),
    }));
}

function emptyResult(
  options: RenderOptions,
  seed: number | string,
  flavor: Flavor,
  timings: Record<string, number>,
): RenderResult {
  const w = Math.max(1, Math.round((options.width ?? 512) * (options.resolution ?? 1)));
  const h = Math.max(1, Math.round((options.height ?? options.width ?? 512) * (options.resolution ?? 1)));
  const data = new Uint8ClampedArray(w * h * 4);
  const bg = options.background === undefined ? DEFAULT_PAPER : options.background;
  if (bg !== null) {
    const c = parseColor(bg);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = Math.round(c.rgb[0] * 255);
      data[i * 4 + 1] = Math.round(c.rgb[1] * 255);
      data[i * 4 + 2] = Math.round(c.rgb[2] * 255);
      data[i * 4 + 3] = 255;
    }
  }
  return { width: w, height: h, data, seed, flavor, timings };
}

/** The flavor presets, exposed for the demo's "reset to flavor" control. */
export { FLAVOR_PRESETS };
