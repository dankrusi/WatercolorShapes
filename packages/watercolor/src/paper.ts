/**
 * Paper substrate.
 *
 * The height field is the single most load-bearing texture in the renderer:
 * it decides where pigment settles (granulation), where a thirsty brush skips
 * (dry brush), where the advancing edge pins on a fibre, and how much water a
 * cell can hold in the fluid simulation. Generating it once and sharing it
 * keeps all of those correlated, which is exactly what makes real paper read
 * as one surface rather than several unrelated noises.
 */

import { sampledField } from './field/sampled.js';
import { fbm01, valueNoise } from './noise.js';

export interface PaperOptions {
  /** Grain size in pixels of the field being generated. */
  scale: number;
  seed: number;
  /** 0 = smooth hot-press, 1 = coarse rough-press. */
  roughness?: number;
}

/**
 * Generate a paper height field.
 *
 * Three components, mirroring how a sheet is actually made: a fine isotropic
 * tooth, an anisotropic fibre streak from the pulp alignment, and a broad
 * cloud from uneven sheet formation.
 */
export function makePaper(
  width: number,
  height: number,
  opts: PaperOptions,
): Float32Array {
  const { scale, seed } = opts;
  const roughness = opts.roughness ?? 0.6;
  const out = new Float32Array(width * height);
  const f = 1 / Math.max(0.5, scale);
  // Sheet formation varies over centimetres, not fibres, so the cloud term is
  // sampled coarsely and interpolated. Tooth and fibre stay per-pixel: they
  // are the detail the granulation reads back out.
  const cloudField = sampledField(width, height, Math.max(1, Math.round(6 / f)), (x, y) =>
    fbm01(x * f * 0.09, y * f * 0.09, seed ^ 0x2f9c1a37, { octaves: 3, gain: 0.6 }),
  );
  // Fibres run at a shallow angle and are stretched about 3:1.
  const ang = ((seed % 97) / 97) * Math.PI;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const px = x * f;
      const py = y * f;
      const tooth = fbm01(px * 1.9, py * 1.9, seed, { octaves: 3, gain: 0.55 });
      const fx = (px * ca + py * sa) * 0.45;
      const fy = (-px * sa + py * ca) * 3.1;
      const fibre = valueNoise(fx, fy, seed ^ 0x51ed270b);
      let h = tooth * 0.52 + fibre * 0.26 + cloudField[i] * 0.22;
      // Push contrast towards the extremes as roughness rises: a rough sheet
      // has deep pits and hard peaks, a hot-pressed one is nearly flat.
      h = 0.5 + (h - 0.5) * (0.55 + roughness * 1.1);
      out[i] = h < 0 ? 0 : h > 1 ? 1 : h;
    }
  }
  return out;
}
