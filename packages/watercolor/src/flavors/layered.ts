/**
 * Flavor: `layered`.
 *
 * Glazing: several transparent passes, each allowed to dry before the next
 * goes down, so depth accumulates where they overlap. Because each pass dries
 * on its own, each leaves its own stranded rim somewhere inside the shape -
 * the soft internal contours that give a glazed passage its layered look.
 *
 * Only the first pass defines the silhouette; the later ones are laid inside
 * it, so the outline stays as crisp as any other flavor.
 *
 * The later passes are *regions*, not insets. Offsetting the shape's distance
 * field inward is the obvious way to pull a pass back from the edge, and it
 * fails badly: every pass then comes out a clean concentric copy of the
 * outline and they stack into something that reads as a contour map. A real
 * glaze covers a patch of the picture with an irregular soft boundary that
 * has nothing to do with the shape's outline, which is what a thresholded
 * low-frequency field gives.
 */

import { gaussianBlur } from '../field/blur.js';
import { clamp01 } from '../noise.js';
import { shadeFactor, textureFactor, type FieldContext } from './common.js';

export function layeredField(ctx: FieldContext): Float32Array {
  const { width, height, params: p, form, rim, tex } = ctx;
  const n = width * height;
  const out = new Float32Array(n);
  const passes = Math.max(1, Math.round(p.layers));

  const mottle = tex.mottle;
  const clump = tex.grainClump;
  const rimVar = tex.rimVar;

  // Each pass carries a fraction of the total load, the earlier ones slightly
  // heavier: the first lay-in is always the wettest.
  const weights: number[] = [];
  let wsum = 0;
  for (let k = 0; k < passes; k++) {
    const w = Math.pow(0.62, k);
    weights.push(w);
    wsum += w;
  }
  for (let k = 0; k < passes; k++) weights[k] /= wsum;

  const passMask = new Float32Array(n);
  // Keep later passes just off the silhouette, so only the first pass can
  // define the edge. Narrow on purpose: any wider and every later pass stops
  // short of the perimeter by the same margin, which thins the pigment in a
  // ring all the way round and reads as a soft outline - exactly the thing
  // this flavor is supposed to avoid.
  const keepIn = Math.max(1, ctx.edgeSize * 0.006);

  for (let k = 0; k < passes; k++) {
    if (k === 0) {
      passMask.set(ctx.mask);
    } else {
      const wander = tex.passWander(k);
      // Each pass covers a bit more than half the shape, weighted towards the
      // shadow so the modelling builds where the form turns away.
      const threshold = -0.12 + 0.05 * k;
      // A dried glaze boundary is a wet edge that stopped: soft compared with
      // the silhouette, but still a visible line. Blurring it away leaves the
      // flavor indistinguishable from a plain wash.
      const soft = 0.16;
      for (let i = 0; i < n; i++) {
        const m = ctx.mask[i];
        if (m <= 0.0006) {
          passMask[i] = 0;
          continue;
        }
        const shadowBias = (0.5 - form.light[i]) * 0.9;
        const v = wander[i] + shadowBias - threshold;
        const tt = clamp01((v + soft) / (2 * soft));
        const region = tt * tt * (3 - 2 * tt);
        const inset = clamp01((ctx.wetSdf[i] - keepIn) / keepIn);
        passMask[i] = m * region * (inset * inset * (3 - 2 * inset));
      }
    }

    // Each dried pass leaves a rim at its own boundary.
    const passRim =
      k === 0
        ? rim
        : passRimFrom(passMask, width, height, Math.max(1, p.edgeDarkeningWidth * ctx.edgeSize * 0.8));

    const w = weights[k] * passes * 0.62;
    // Later passes are accents on top of a full first lay-in, not equal
    // shares of it.
    const shadeGain = k === 0 ? 0.7 : 0.9;
    const rimGain = k === 0 ? 0.8 : 0.35;
    for (let i = 0; i < n; i++) {
      const pm = passMask[i];
      if (pm <= 0.0006) continue;
      let t = shadeFactor(ctx, i, shadeGain);
      t *= textureFactor(p.mottling, mottle[i] * 0.34 + clump[i] * 0.12);
      t *= textureFactor(p.granulation, tex.granulationAt(i, clump) * 0.32);
      t += p.edgeDarkening * passRim[i] * clamp01(1 + p.edgeVariation * rimVar[i]) * rimGain;
      out[i] += w * t * pm;
    }
  }

  // No final clip: every pass already carries the silhouette mask, and
  // applying it twice squares the edge ramp - which turns the one-pixel
  // boundary this flavor works hard to keep into a visibly soft one.
  return out;
}

/** Interior rim of an arbitrary mask: its own gradient magnitude, smoothed. */
function passRimFrom(
  mask: Float32Array,
  width: number,
  height: number,
  widthPx: number,
): Float32Array {
  const blurred = gaussianBlur(mask, width, height, Math.max(1, widthPx * 0.75));
  const out = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    // Positive where the crisp mask sits above its own blur: the inner lip of
    // the boundary, which is where the pigment stranded.
    out[i] = clamp01((mask[i] - blurred[i]) * 2.4);
  }
  return gaussianBlur(out, width, height, 0.8);
}
