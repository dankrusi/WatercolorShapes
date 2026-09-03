/**
 * Form-following shading.
 *
 * The references shade each shape as if it were a soft solid of its own
 * outline lit from one side: the half-disc reads as a dome, the rounded
 * diamond as a cushion. That is exactly what you get by treating the interior
 * distance field as a height map and lighting it.
 *
 * Nothing here is 3D rendering for its own sake. In a real wash the painter
 * floats more pigment into the turning-away side while the water is still
 * moving, so what the light model actually drives is *pigment thickness*, not
 * a lighting multiply on the final colour. That distinction is why the shadow
 * side of the references gets more saturated rather than just darker.
 */

import { gaussianBlur, gradient, maskedBlur } from '../field/blur.js';
import { expand, shrink } from '../field/pyramid.js';
import { clamp01 } from '../noise.js';

/** Lambert wrap: how far light bleeds past the terminator. */
const WRAP = 0.45;

export interface FormShading {
  /** Lambert term in [0,1]; 1 is fully lit. */
  light: Float32Array;
  /** Cavity/occlusion term in [0,1]; 1 is fully open. */
  openness: Float32Array;
  /** The implied height field, normalised to [0,1]. */
  height: Float32Array;
}

export interface FormOptions {
  /** Signed distance, positive inside, in working pixels. */
  sdf: Float32Array;
  /** Interior mask in [0,1]. */
  mask: Float32Array;
  width: number;
  height: number;
  /** Characteristic shape size in working pixels. */
  shapeSize: number;
  /** Light azimuth, degrees clockwise from 12 o'clock. */
  lightAngle: number;
  /** Light elevation, degrees above the paper. */
  lightElevation: number;
  /** Relief height as a fraction of shape size. */
  formDepth: number;
  /** Smoothing of the implied form, as a fraction of shape size. */
  formSoftness: number;
}

/**
 * Build the implied form and light it.
 */
export function computeFormShading(o: FormOptions): FormShading {
  // Run the whole stage on a coarser grid. The height field is about to be
  // blurred at a radius of `formSoftness * shapeSize` - a sixth of the shape
  // by default - so anything finer than a fraction of that radius is
  // discarded before it is ever lit. Working at full supersampled resolution
  // here costs several blur passes over a million pixels to produce a field
  // that is smooth by construction.
  const step = Math.max(1, Math.min(6, Math.round((o.formSoftness * o.shapeSize) / 4)));
  const lo = shrink(o.sdf, o.width, o.height, step);
  const loMask = shrink(o.mask, o.width, o.height, step);
  const inner = computeFormShadingAt({
    ...o,
    sdf: lo.data,
    mask: loMask.data,
    width: lo.width,
    height: lo.height,
    // The blur radius and the concavity gate are both expressed in grid
    // cells, so they shrink with the grid; the sdf *values* stay in output
    // pixels, and every use of them here is a ratio against `shapeSize`.
    formSoftness: (o.formSoftness * o.shapeSize) / step / o.shapeSize,
  });
  if (step === 1) return inner;
  return {
    light: expand(inner.light, lo.width, lo.height, o.width, o.height, step),
    openness: expand(inner.openness, lo.width, lo.height, o.width, o.height, step),
    height: expand(inner.height, lo.width, lo.height, o.width, o.height, step),
  };
}

function computeFormShadingAt(o: FormOptions): FormShading {
  const { sdf, mask, width, height, shapeSize } = o;
  const n = width * height;

  // Interior distance normalised so 1 is the deepest point of the shape.
  let maxD = 0;
  for (let i = 0; i < n; i++) if (sdf[i] > maxD) maxD = sdf[i];
  maxD = Math.max(1e-3, maxD);

  // Height profile against normalised inset.
  //
  // The obvious choice is the sphere, h = sqrt(t(2-t)), which turns a disc
  // into a hemisphere. It is also the wrong choice: it climbs to 44% of full
  // height within the first tenth of the inset, so essentially all of the
  // slope - and therefore all of the shading - is packed into a thin band
  // around the perimeter. Lit, that reads as a dark halo all the way round
  // and a flat interior, which is not what any of the references do.
  //
  // Mixing in a linear ramp spreads the slope across the whole interior. The
  // linear part alone is a cone: constant slope, so one side lights evenly
  // and the other falls evenly away, which is exactly the long directional
  // graduation a painter gets by tilting the board. The sphere term is kept
  // at a minority weight for the rounding it gives near the edge.
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = clamp01(sdf[i] / maxD);
    raw[i] = 0.62 * t + 0.38 * Math.sqrt(t * (2 - t));
  }

  // Smooth the medial-axis creases out of the height field. The distance
  // transform has a sharp ridge down the middle of any non-round shape; left
  // alone it produces a hard specular seam no painter would ever make.
  const sigma = Math.max(1, o.formSoftness * shapeSize);
  const smooth = maskedBlur(raw, mask, width, height, sigma);

  const { gx, gy } = gradient(smooth, width, height);

  // Normalise the slope by how steep this particular shape's height field
  // actually is, rather than by its size.
  //
  // Scaling the gradient by `formDepth * shapeSize` seems natural and is
  // wrong: the height field is already normalised to [0,1], so that product
  // makes the relief as tall as the shape is wide. Every pixel near the
  // outline then has a normal tipped past the light direction, and the whole
  // perimeter darkens evenly - a vignette, not a lit form. Referencing the
  // measured slope instead makes `formDepth` mean the same thing on a small
  // shape as on a large one, and on a smooth outline as on a craggy one.
  let steep = 0;
  {
    const samples: number[] = [];
    const stride = Math.max(1, Math.floor(n / 20000));
    for (let i = 0; i < n; i += stride) {
      if (mask[i] < 0.5) continue;
      samples.push(Math.hypot(gx[i], gy[i]));
    }
    if (samples.length > 8) {
      samples.sort((a, b) => a - b);
      // The median, not a high percentile: keyed to the steepest slopes, the
      // typical interior pixel ends up nearly flat and the shape reads as
      // unshaded except at its rim.
      steep = samples[samples.length >> 1];
    }
  }
  const relief = steep > 1e-9 ? Math.max(1e-4, o.formDepth) / steep : 0;
  // Cap how far a normal may tip. Without it the few genuinely steep pixels
  // near the outline swing past the light and darken regardless of which side
  // they are on - the halo again, just narrower.
  const maxTilt = Math.max(0.2, o.formDepth * 2.2);

  const az = (o.lightAngle * Math.PI) / 180;
  const el = (o.lightElevation * Math.PI) / 180;
  // Azimuth measured clockwise from 12 o'clock, in image coordinates where y
  // grows downwards.
  const lx = Math.sin(az) * Math.cos(el);
  const ly = -Math.cos(az) * Math.cos(el);
  const lz = Math.sin(el);

  const light = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let nx = -gx[i] * relief;
    let ny = -gy[i] * relief;
    const tilt = Math.sqrt(nx * nx + ny * ny);
    if (tilt > maxTilt) {
      const k = maxTilt / tilt;
      nx *= k;
      ny *= k;
    }
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
    const ndl = (nx * lx + ny * ly + lz) * inv;
    // Wrapped Lambert. Full Lambert clips the whole shadow side to one flat
    // value; plain half-Lambert (wrap = 1) does not clip but squeezes the
    // whole term into the upper half of its range, which caps the
    // light-to-shadow pigment ratio at about two to one - far short of the
    // references. A wrap of 0.45 keeps the shadow side readable while leaving
    // the term most of its range.
    light[i] = clamp01((ndl + WRAP) / (1 + WRAP));
  }

  // Openness: how much of the neighbourhood is above this point. Concavities
  // of the implied form collect pigment, the same way a real wash pools in
  // them before it dries.
  //
  // Faded out near the outline, where the height field's own falloff would
  // otherwise register as one continuous concavity all the way round and
  // duplicate the edge-darkening rim.
  const wide = maskedBlur(smooth, mask, width, height, sigma * 2.2);
  const openness = new Float32Array(n);
  const gate = Math.max(1, 0.06 * shapeSize);
  for (let i = 0; i < n; i++) {
    const g = clamp01(sdf[i] / gate);
    openness[i] = 0.5 + (clamp01(0.5 + (smooth[i] - wide[i]) * 3.5) - 0.5) * (g * g * (3 - 2 * g));
  }

  return { light, openness, height: smooth };
}

/**
 * Rim term: 1 at the wash boundary, falling to 0 further in.
 *
 * As a puddle dries the water evaporates fastest at the perimeter, and
 * replenishing flow carries pigment outwards to replace it. The pigment has
 * nowhere to go, so it strands in a rim. Its strength varies around the
 * perimeter because the puddle does not dry evenly, which is what
 * `variation` supplies.
 */
export function computeEdgeRim(
  sdf: Float32Array,
  width: number,
  height: number,
  widthPx: number,
  softness = 1,
  gravity = 0,
): Float32Array {
  const n = width * height;
  const out = new Float32Array(n);
  const w = Math.max(0.5, widthPx);
  // Which way the boundary faces. The distance field increases inwards, so
  // the outward normal is the negated gradient; its downward component says
  // how much of the wash drains towards this stretch of edge.
  let gy: Float32Array | null = null;
  if (gravity > 0) {
    const smooth = gaussianBlur(sdf, width, height, Math.max(1, w * 0.6));
    gy = gradient(smooth, width, height).gy;
  }
  for (let i = 0; i < n; i++) {
    const d = sdf[i];
    if (d <= 0) {
      out[i] = 0;
      continue;
    }
    // Exponential falloff from the boundary; the small quadratic lift near
    // zero keeps the very outermost pixels from over-darkening once the
    // silhouette has been perturbed.
    const t = d / w;
    let v = Math.exp(-t * t * 0.9) * (1 - Math.exp(-d * 1.6));
    if (gy) {
      // A wash drains downhill and strands its heaviest deposit along the
      // lowest edge it reaches. All three references show it: the flat
      // bottom of each half-disc carries a much darker rim than its arc.
      const down = clamp01(-gy[i] * 4 * 0.5 + 0.5);
      v *= 1 + gravity * (down * 2 - 1);
    }
    out[i] = v > 0 ? v : 0;
  }
  return softness > 0.3 ? gaussianBlur(out, width, height, softness) : out;
}
