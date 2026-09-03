/**
 * Flavor: `wash`.
 *
 * One graded wash laid wet-on-dry with a loaded brush, tilted so the water
 * drains towards the shadow side. The pigment is still mobile while the form
 * is being modelled, so tone transitions are long and smooth; texture comes
 * from uneven unloading and from the film breaking into drying islands,
 * rather than from settling or back-runs.
 *
 * This is the flavor that matches the ochre half-disc reference most closely.
 */

import { clamp01 } from '../noise.js';
import { shadeFactor, textureFactor, type FieldContext } from './common.js';

export function washField(ctx: FieldContext): Float32Array {
  const { width, height, params: p, mask, rim, tex } = ctx;
  const out = new Float32Array(width * height);

  const mottle = tex.mottle;
  const patchBig = tex.patch('washA', Math.max(0.03, p.mottleScale * 0.45));
  const patchSmall = tex.patch('washB', Math.max(0.02, p.mottleScale * 0.2), 5.7);
  const streak = tex.flowStreak;
  const clump = tex.grainClump;
  const rimVar = tex.rimVar;

  for (let i = 0; i < out.length; i++) {
    const m = mask[i];
    if (m <= 0.0006) continue;

    // Form: more pigment where the implied surface turns away from the light.
    let t = shadeFactor(ctx, i, 1.85);

    // Uneven unloading of the brush, plus the islands the drying film broke
    // into - two scales, because a wash this size dries in coarse regions
    // that each break up again.
    t *= textureFactor(
      p.mottling,
      mottle[i] * 0.4 + patchBig[i] * 0.3 + patchSmall[i] * 0.22 + streak[i] * 0.16,
    );

    // A little settling even in a smooth wash.
    t *= textureFactor(p.granulation, tex.granulationAt(i, clump) * 0.4);

    // Stranded rim. Additive, because it is pigment arriving from elsewhere
    // rather than a modulation of what is already there.
    t += p.edgeDarkening * rim[i] * clamp01(1 + p.edgeVariation * rimVar[i]) * 0.8;

    out[i] = t > 0 ? t * m : 0;
  }
  return out;
}
