/**
 * Wash boundary perturbation.
 *
 * A brush-laid wash does not stop where the drawing says it does. The
 * advancing water front is held back by surface tension and pinned by paper
 * fibres, so it lands within a fraction of a millimetre of the intended line
 * but never exactly on it. That is the whole "sharp, but not perfect" quality
 * of the references, and it is reproduced by displacing the signed distance
 * field rather than by blurring: displacement moves the edge, blurring only
 * softens it, and a softened edge looks like print, not paint.
 *
 * Three displacement terms, each with a physical counterpart:
 *
 *   wobble   - the meniscus wandering over a few millimetres of travel
 *   faceting - the front jumping cell to cell as it releases and re-pins,
 *              which is what leaves the small straight steps in the
 *              references rather than a smooth sine
 *   fibre    - individual fibres of the tooth holding or wicking the front
 */

import { gaussianBlur } from './blur.js';
import { factorFor, sampledField } from './sampled.js';
import { sampleBilinear } from '../path/raster.js';
import { fbm, warp, worley } from '../noise.js';
import { Rng } from '../rng.js';

export interface LoosenOptions {
  sdf: Float32Array;
  width: number;
  height: number;
  /** Characteristic shape size in working pixels. */
  shapeSize: number;
  seed: number;
  /** 0 keeps the outline exactly; 1 is a quick, loose hand. */
  amount: number;
}

/**
 * Loosen the outline the painter was aiming at.
 *
 * `perturbEdge` models the water front landing a fraction of a millimetre off
 * the line. This is the step before it: the brush itself not following the
 * line. Nobody lays a wash exactly into a drawn shape - corners come out
 * rounded because a loaded brush cannot turn on a point, one side bellies out
 * while another falls short, and the whole patch sits a little off where the
 * pencil put it. Each of those is a different accident on every attempt,
 * which is what an animated sequence of seeds needs: a stamped outline with
 * only its texture boiling reads as a filter, a hand-traced one as painting.
 *
 * Returns a new field, still close to a true distance, so everything
 * downstream - including the form shading - treats it as the shape.
 */
export function loosenOutline(o: LoosenOptions): Float32Array {
  const { sdf, width, height, shapeSize, seed } = o;
  const amount = Math.max(0, o.amount);
  if (amount <= 0) return sdf;

  // Corners. Blurring a distance field leaves straight runs exactly where they
  // were - a linear ramp is its own blur - and rounds only where the field
  // bends, convex and concave alike.
  const rounded = gaussianBlur(sdf, width, height, amount * 0.035 * shapeSize);

  // Bellying and falling short, at the scale of the shape's own sides.
  const unit = 1 / Math.max(1, shapeSize);
  const freq = 1.7;
  const ampWander = amount * 0.032 * shapeSize;
  const wander = sampledField(width, height, factorFor(shapeSize / (freq * 6)), (x, y) =>
    fbm(x * unit * freq, y * unit * freq, seed ^ 0x3c6ef372, { octaves: 3, grad: true, gain: 0.5 }),
  );

  // The patch as a whole slipping off the drawing, and running a touch
  // generous or a touch mean.
  const rng = new Rng(`loosen:${seed}`);
  const angle = rng.next() * Math.PI * 2;
  const slip = amount * 0.012 * shapeSize * Math.sqrt(rng.next());
  const dx = Math.cos(angle) * slip;
  const dy = Math.sin(angle) * slip;
  const bias = amount * 0.006 * shapeSize * (rng.next() * 2 - 1);

  const out = new Float32Array(sdf.length);
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      out[i] = sampleBilinear(rounded, width, height, x - dx, y - dy) + ampWander * wander[i] + bias;
    }
  }
  return out;
}

export interface EdgeOptions {
  sdf: Float32Array;
  width: number;
  height: number;
  /** Characteristic shape size in working pixels. */
  shapeSize: number;
  /** Paper height field, same dimensions. */
  paper: Float32Array;
  seed: number;
  /** Low-frequency wander, as a fraction of shape size. */
  wobble: number;
  /** Octaves in the wander. */
  detail: number;
  /** Faceted stepping amplitude, as a fraction of shape size. */
  crystal: number;
  /** Fibre pinning amplitude, as a fraction of shape size. */
  fiber: number;
  /** Cell size for the faceting, as a fraction of shape size. */
  crystalScale?: number;
}

/**
 * Displace a signed distance field to produce the wash boundary.
 * Returns a new field; the input is left untouched so the ideal outline
 * remains available for shading.
 */
export function perturbEdge(o: EdgeOptions): Float32Array {
  const { sdf, width, height, shapeSize, paper, seed } = o;
  const out = new Float32Array(sdf.length);
  const ampWobble = o.wobble * shapeSize;
  const ampCrystal = o.crystal * shapeSize;
  const ampFiber = o.fiber * shapeSize;

  // Noise coordinates are shape-relative, so rendering the same shape at
  // twice the resolution zooms into the same pattern instead of re-rolling it.
  const unit = 1 / Math.max(1, shapeSize);
  const wobbleFreq = 3.2;
  const cellFreq = 1 / Math.max(0.008, o.crystalScale ?? 0.055);
  const octaves = Math.max(1, Math.round(o.detail));
  const warped: [number, number] = [0, 0];

  // The bands beyond a few pixels of the boundary can never change sign, so
  // only touch the ones that can. On a 1024px render that is a small
  // fraction of the pixels and saves most of the noise evaluation.
  const reach = ampWobble + ampCrystal + ampFiber + 2;

  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const d = sdf[i];
      if (d > reach || d < -reach) {
        out[i] = d;
        continue;
      }
      const nx = x * unit;
      const ny = y * unit;
      let disp = 0;
      if (ampWobble > 0) {
        disp += ampWobble * fbm(nx * wobbleFreq, ny * wobbleFreq, seed ^ 0x27d4eb2d, {
          octaves,
          grad: true,
          gain: 0.55,
        });
      }
      if (ampCrystal > 0) {
        // Warp the lattice first, otherwise the facets betray a regular grid.
        warp(nx * cellFreq, ny * cellFreq, seed ^ 0x165667b1, 0.55, 0.35, warped, 2);
        const w = worley(warped[0], warped[1], seed ^ 0x9e3779b9, 1);
        // A flat per-cell offset makes the front step, not undulate.
        const step = w.id - 0.5;
        // Soften right at the cell wall so adjacent steps join rather than tear.
        const wall = Math.min(1, (w.f2 - w.f1) * 3.2);
        disp += ampCrystal * step * (0.35 + 0.65 * wall);
      }
      if (ampFiber > 0) {
        disp += ampFiber * (paper[i] - 0.5) * 2;
      }
      out[i] = d + disp;
    }
  }
  return out;
}

/**
 * Convert a signed distance field into a coverage mask.
 *
 * `softness` is the full transition width in working pixels. Keeping it near
 * one pixel is what makes the result read as sharp; the irregularity comes
 * from `perturbEdge`, not from here.
 */
export function maskFromSdf(
  sdf: Float32Array,
  softness: number,
  out?: Float32Array,
): Float32Array {
  const dst = out ?? new Float32Array(sdf.length);
  const h = Math.max(0.15, softness) * 0.5;
  const inv = 1 / (2 * h);
  for (let i = 0; i < sdf.length; i++) {
    const t = (sdf[i] + h) * inv;
    dst[i] = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  }
  return dst;
}
