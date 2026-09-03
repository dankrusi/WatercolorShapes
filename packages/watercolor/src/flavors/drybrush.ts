/**
 * Flavor: `drybrush`.
 *
 * A brush carrying more pigment than water, dragged across rough paper. It
 * only touches the peaks of the tooth, so coverage breaks up into a stipple
 * that follows the grain, and the boundary is ragged rather than merely
 * irregular. Included as the counterpoint to the other five: it is the one
 * case where the shape's outline is genuinely allowed to fail.
 */

import { clamp01 } from '../noise.js';
import { shadeFactor, textureFactor, type FieldContext } from './common.js';

export function drybrushField(ctx: FieldContext): Float32Array {
  const { width, height, params: p, mask, rim, tex } = ctx;
  const out = new Float32Array(width * height);

  const mottle = tex.mottle;
  const clump = tex.grainClump;
  const pressure = tex.brushPressure;
  const load = tex.brushLoad;
  const rimVar = tex.rimVar;

  for (let i = 0; i < out.length; i++) {
    const m = mask[i];
    if (m <= 0.0006) continue;

    let t = shadeFactor(ctx, i, 1.2);
    t *= textureFactor(p.mottling, mottle[i] * 0.55);
    t *= textureFactor(p.granulation, tex.granulationAt(i, clump) * 0.5);

    // Brush loading falls off along the stroke, so the far end skips more.
    const contact = tex.drySkipAt(i, pressure, load);
    t *= 0.46 + 0.54 * contact;

    t += p.edgeDarkening * rim[i] * clamp01(1 + p.edgeVariation * rimVar[i]) * contact * 0.6;

    out[i] = t > 0 ? t * m : 0;
  }
  return out;
}
