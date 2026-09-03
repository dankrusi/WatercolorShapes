/**
 * Flavor: `bloom`.
 *
 * A wash disturbed while it was setting. Water re-entering a half-dry film
 * shoves the loosened pigment ahead of it and strands it at the limit of its
 * travel, so the surface ends up as a patchwork of flat plateaux divided by
 * hard walls. The greige half-disc reference is this: look along its edge and
 * the boundary steps in short straight runs, and the interior is plainly made
 * of overlapping lobes rather than a gradient.
 */

import { clamp01 } from '../noise.js';
import { shadeFactor, textureFactor, type FieldContext } from './common.js';

export function bloomField(ctx: FieldContext): Float32Array {
  const { width, height, params: p, mask, rim, tex } = ctx;
  const out = new Float32Array(width * height);

  const mottle = tex.mottle;
  const bloom = tex.bloom;
  const reach = tex.bloomReach;
  const clump = tex.grainClump;
  const rimVar = tex.rimVar;

  for (let i = 0; i < out.length; i++) {
    const m = mask[i];
    if (m <= 0.0006) continue;

    let t = shadeFactor(ctx, i, 1.4);
    t *= textureFactor(p.mottling, mottle[i] * 0.34);

    // Blooms do not cover the whole wash: they spread from wherever the water
    // went back in, which is what `reach` gates.
    //
    // The film loses body in the middle of a plateau and gains it at the
    // wall - pigment pushed to a wall is pigment missing from the middle - so
    // the two terms are deliberately opposite in sign.
    const b = bloom[i];
    t *= textureFactor(p.blooms, (b * 0.68 - clamp01(b * 0.5 + 0.5) * 0.22) * reach[i]);

    t *= textureFactor(p.granulation, tex.granulationAt(i, clump) * 0.3);

    t += p.edgeDarkening * rim[i] * clamp01(1 + p.edgeVariation * rimVar[i]) * 0.9;

    out[i] = t > 0 ? t * m : 0;
  }
  return out;
}
