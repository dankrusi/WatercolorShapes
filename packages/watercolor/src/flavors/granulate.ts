/**
 * Flavor: `granulate`.
 *
 * A heavy, low-binder pigment on rough paper. The particles are too dense to
 * stay suspended, so they drop into the tooth as the wash sits, leaving a
 * fine speckle whose contrast rises with pigment load. The measured
 * charcoal-diamond reference has most of its texture energy in exactly this
 * band, and almost none in the broad cloudy band a plain wash shows.
 */

import { clamp01 } from '../noise.js';
import { shadeFactor, textureFactor, type FieldContext } from './common.js';

export function granulateField(ctx: FieldContext): Float32Array {
  const { width, height, params: p, mask, rim, paper, tex } = ctx;
  const out = new Float32Array(width * height);

  const mottle = tex.mottle;
  const patch = tex.patch('granA', Math.max(0.03, p.mottleScale * 0.4));
  const clump = tex.grainClump;
  const sediment = tex.sediment;
  const rimVar = tex.rimVar;

  for (let i = 0; i < out.length; i++) {
    const m = mask[i];
    if (m <= 0.0006) continue;

    let t = shadeFactor(ctx, i, 1.5);

    // Broad drift, deliberately weaker than in `wash`: heavy pigment settles
    // before it has time to migrate far, so the large-scale field stays flat.
    t *= textureFactor(p.mottling, mottle[i] * 0.3 + patch[i] * 0.22);

    // The settling itself. Letting the amplitude rise with the local load
    // reproduces the way granulation is invisible in a pale passage and
    // obvious in a dark one.
    const load = clamp01(t * 0.75);
    const gran = tex.granulationAt(i, clump);
    // Dry-down flecks: single grains that caught on a tooth peak and were
    // then scrubbed clean as the water pulled back.
    const fleck = paper[i] > 0.86 ? (paper[i] - 0.86) * 7.1 : 0;
    t *= textureFactor(
      p.granulation,
      gran * (0.42 + 0.55 * load) + sediment[i] * 0.24 - fleck * 0.32,
    );

    t += p.edgeDarkening * rim[i] * clamp01(1 + p.edgeVariation * rimVar[i]) * 0.95;

    out[i] = t > 0 ? t * m : 0;
  }
  return out;
}
