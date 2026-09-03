/**
 * Shared scaffolding for the flavors.
 *
 * Every flavor receives the same precomputed geometry, paper and shading, and
 * differs only in how it turns them into a pigment thickness field. Keeping
 * the fields common means the six algorithms stay comparable: switching flavor
 * changes the paint behaviour, not the shape, the light or the colour.
 *
 * The textures themselves are built once per render into arrays rather than
 * evaluated inside each flavor's pixel loop, and each is sampled on a grid
 * matched to the finest scale it actually carries. See `field/sampled.ts` for
 * why that is worth doing.
 */

import { factorFor, sampledField } from '../field/sampled.js';
import { fbm, fbm01, warp, worley, clamp01, mix } from '../noise.js';
import type { FormShading } from '../shading/form.js';
import type { WatercolorParams } from '../types.js';

export interface FieldContext {
  width: number;
  height: number;
  /** Characteristic shape size in working pixels (max of the bbox sides). */
  shapeSize: number;
  /** Ideal signed distance, positive inside. */
  sdf: Float32Array;
  /** Perturbed signed distance: where the wash actually lands. */
  wetSdf: Float32Array;
  /** Coverage mask derived from `wetSdf`, in [0,1]. */
  mask: Float32Array;
  /** Paper height in [0,1]. */
  paper: Float32Array;
  /** Form shading terms. */
  form: FormShading;
  /** Rim proximity term in [0,1], 1 at the wash boundary. */
  rim: Float32Array;
  /** Per-pixel gradient parameter in [0,1], or null for a flat fill. */
  gradientT: Float32Array | null;
  /** Thickness multiplier from the gradient's own value ramp, or null. */
  gradientThickness: Float32Array | null;
  params: WatercolorParams;
  seed: number;
  /** 1 / shapeSize: converts pixel coordinates to shape-relative noise space. */
  unit: number;
  /** Lazily-built texture arrays. */
  tex: TextureCache;
}

/**
 * The form-shading factor at a pixel.
 *
 * Exponential rather than `1 + k*x` for two reasons. It cannot drive the
 * thickness negative, and it is symmetric in ratio: the lit side gets as much
 * lighter as the shadow side gets darker, which is what a painter floating
 * pigment into a wet wash actually produces. Additive shading instead runs out
 * of room at the light end - it can only ever remove 100% of the pigment - and
 * the references need a light-to-shadow pigment ratio near ten to one, well
 * past what an additive term can express.
 */
export function shadeFactor(ctx: FieldContext, i: number, gain: number): number {
  const p = ctx.params;
  const shade = (0.5 - ctx.form.light[i]) * 2;
  const occ = (0.5 - ctx.form.openness[i]) * 2;
  return Math.exp(p.shading * shade * gain + p.ambientOcclusion * occ * 0.5);
}

/** Texture factor, likewise multiplicative in log space. */
export function textureFactor(amount: number, value: number): number {
  return amount <= 0 ? 1 : Math.exp(amount * value);
}

/**
 * Lazily-built, memoised texture fields.
 *
 * A flavor touches three or four of these; building all of them every time
 * would throw away most of the saving. Each getter builds on first use and
 * caches.
 */
export class TextureCache {
  private cache = new Map<string, Float32Array>();

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly unit: number,
    private readonly shapeSize: number,
    private readonly paper: Float32Array,
    private readonly params: WatercolorParams,
    private readonly seed: number,
  ) {}

  private build(key: string, featurePx: number, fn: (nx: number, ny: number) => number, maxFactor = 6): Float32Array {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const u = this.unit;
    const f = factorFor(featurePx, maxFactor);
    const field = sampledField(this.width, this.height, f, (x, y) => fn(x * u, y * u));
    this.cache.set(key, field);
    return field;
  }

  /**
   * Broad tonal drift across the wash.
   *
   * Pigment never distributes evenly: the brush unloads unevenly, and the film
   * of water is thicker in some places than others before it dries. Two octave
   * bands rather than one fBm, because the measured references show energy at
   * both a shape-scale and a few-millimetre scale with a dip between.
   */
  get mottle(): Float32Array {
    const f = 1 / Math.max(0.02, this.params.mottleScale);
    // Finest content is the third octave of the higher band.
    const feature = this.shapeSize / (f * 2.3 * 4);
    return this.build('mottle', feature, (nx, ny) => {
      const broad = fbm(nx * f * 0.55, ny * f * 0.55, this.seed ^ 0x1b873593, {
        octaves: 3,
        grad: true,
        gain: 0.6,
      });
      const mid = fbm(nx * f * 2.3, ny * f * 2.3, this.seed ^ 0x85ebca6b, {
        octaves: 3,
        grad: true,
        gain: 0.5,
      });
      return broad * 0.66 + mid * 0.34;
    });
  }

  /** Low-frequency field modulating how heavy the dried rim is at each point
   * around the perimeter. A puddle does not dry evenly, so its rim is heavy
   * along one arc and nearly absent along another. */
  get rimVar(): Float32Array {
    return this.build('rimVar', this.shapeSize / 9, (nx, ny) =>
      fbm(nx * 2.2 + 11.3, ny * 2.2 - 7.9, this.seed ^ 0x51ed270b, { octaves: 3, grad: true }),
    );
  }

  /**
   * Dried-patch structure at a given scale.
   *
   * This is the single most recognisable thing about a real wash, and it is
   * absent from every "watercolour filter" built on smooth noise alone. As a
   * wash dries it does not recede evenly: the film breaks into islands, each
   * island finishes drying at its own moment, and each leaves a flat plateau
   * of tone bounded by a hard, slightly darker line where its edge stalled.
   * Look closely at any of the references and the interior is visibly *made
   * of* these - irregular, faintly polygonal patches, each internally flat.
   *
   * Warped cell noise gives exactly that: `id` is the plateau's own tone,
   * `f2 - f1` traces where two plateaux met.
   */
  patch(key: string, scale: number, offset = 0): Float32Array {
    const f = 1 / Math.max(0.02, scale);
    const cellPx = this.shapeSize * scale;
    const warped: [number, number] = [0, 0];
    // Sampled finer than a smooth field of the same size would need: the cell
    // walls are near-hard edges, and too coarse a grid rounds them off.
    return this.build(
      key,
      cellPx / 6,
      (nx, ny) => {
        warp(nx * f + offset, ny * f - offset, this.seed ^ 0x6b43a9c5, 0.62, 0.75, warped, 3);
        const w = worley(warped[0], warped[1], this.seed ^ 0x2c1b3e57, 1);
        const plateau = (w.id - 0.5) * 2;
        const wall = 1 - clamp01((w.f2 - w.f1) / 0.16);
        return plateau * 0.86 + wall * wall * 0.42;
      },
      2,
    );
  }

  /**
   * Back-runs, blooms and cauliflowers.
   *
   * When fresh water meets a wash that has begun to set, it pushes the
   * half-dried pigment outwards and strands it in a hard-rimmed lobe. The
   * plateau carries most of the signal: a back-run reads as a patchwork of
   * flat tones first and as an outline second. Leading with the wall instead
   * gives a crazed, cracked look that no wash has ever had.
   */
  get bloom(): Float32Array {
    const p = this.params;
    const f = 1 / Math.max(0.03, p.bloomScale);
    const cellPx = this.shapeSize * p.bloomScale;
    const wallWidth = mix(0.5, 0.1, clamp01(p.bloomEdge));
    const warped: [number, number] = [0, 0];
    return this.build(
      'bloom',
      cellPx / 7,
      (nx, ny) => {
        // Two-stage warp: the first breaks the lattice, the second gives the
        // lobes their curled, finger-like outline.
        warp(nx * f, ny * f, this.seed ^ 0x3f4a7c1d, 0.75, 0.6, warped, 3);
        warp(warped[0], warped[1], this.seed ^ 0x7a1f3b9e, 0.3, 1.7, warped, 2);
        const w = worley(warped[0], warped[1], this.seed ^ 0x5bd1e995, 1);
        const plateau = (w.id - 0.5) * 2;
        const wall = 1 - clamp01((w.f2 - w.f1) / wallWidth);
        return plateau * 0.9 + wall * wall * 0.5;
      },
      2,
    );
  }

  /** Where a second wetting reached, gating the blooms. */
  get bloomReach(): Float32Array {
    return this.build('bloomReach', this.shapeSize / 11, (nx, ny) =>
      clamp01(0.5 + fbm(nx * 2.6, ny * 2.6, this.seed ^ 0x71b3a09d, { octaves: 3, grad: true }) * 0.95),
    );
  }

  /**
   * Pigment settling into the paper tooth.
   *
   * Heavy particles sink into the pits and are scrubbed off the peaks as the
   * water recedes, so granulation is largely a direct read of paper height.
   * The noise term stands in for the particles clumping: real granulation is
   * blotchy, not a clean copy of the grain.
   *
   * Only the clumping is sampled here; the tooth itself is read per-pixel
   * from the paper array, which is where the crispest detail comes from.
   */
  get grainClump(): Float32Array {
    return this.build(
      'grainClump',
      this.shapeSize / 62,
      (nx, ny) =>
        fbm(nx * 26, ny * 26, this.seed ^ 0xc2b2ae35, { octaves: 2, gain: 0.6, grad: true }) * 0.72 +
        fbm(nx * 62, ny * 62, this.seed ^ 0x27d4eb2f, { octaves: 1, grad: true }) * 0.28,
      2,
    );
  }

  /** Coarse sediment pooling, independent of the tooth. */
  get sediment(): Float32Array {
    return this.build('sediment', this.shapeSize / 38, (nx, ny) =>
      fbm(nx * 9.5, ny * 9.5, this.seed ^ 0x4d5ba1f7, { octaves: 4, gain: 0.62, grad: true }),
    );
  }

  /**
   * Directional flow streaks left by the wash draining across the paper.
   * Aligned with the light so they reinforce the implied form.
   */
  get flowStreak(): Float32Array {
    const angle = ((this.params.lightAngle + 90) * Math.PI) / 180;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    return this.build('flowStreak', this.shapeSize / 39, (nx, ny) => {
      const u = (nx * ca + ny * sa) * 3.0;
      const v = (-nx * sa + ny * ca) * 13.0;
      return fbm(u, v, this.seed ^ 0x2545f491, { octaves: 3, gain: 0.55, grad: true });
    });
  }

  /**
   * Dry-brush contact threshold: how hard the brush was pressed at each point
   * along the stroke. Thresholding paper height against a constant gives a
   * mechanical stipple; against this it gives a stroke.
   */
  get brushPressure(): Float32Array {
    return this.build('brushPressure', this.shapeSize / 22, (nx, ny) => {
      const pressure = fbm01(nx * 4.5, ny * 4.5, this.seed ^ 0x6f4a7b13, { octaves: 4, gain: 0.55 });
      const streak = fbm01(nx * 2.2, ny * 22, this.seed ^ 0x1c9e3a55, { octaves: 3, gain: 0.5 });
      return clamp01(pressure * 0.62 + streak * 0.38);
    });
  }

  /** Brush loading along the stroke direction, for the dry-brush flavor. */
  get brushLoad(): Float32Array {
    const angle = ((this.params.lightAngle + 90) * Math.PI) / 180;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    return this.build('brushLoad', this.shapeSize / 13, (nx, ny) =>
      clamp01(
        0.55 +
          fbm01(
            (nx * ca + ny * sa) * 1.6,
            (-nx * sa + ny * ca) * 0.8,
            this.seed ^ 0x3ab5c2d1,
            { octaves: 3 },
          ) *
            0.7,
      ),
    );
  }

  /** Wander used by the layered flavor to break up each glaze contour. */
  passWander(k: number): Float32Array {
    return this.build(`passWander${k}`, this.shapeSize / 16, (nx, ny) =>
      fbm(nx * 2.0, ny * 2.0, this.seed ^ (0x27d4eb2d + k * 7717), { octaves: 4, grad: true }),
    );
  }

  /** Per-pixel granulation, combining the tooth with the clumping field. */
  granulationAt(i: number, clump: Float32Array): number {
    return (0.5 - this.paper[i]) * 2 * 0.62 + clump[i] * 0.38;
  }

  /** Dry-brush contact fraction at a pixel. */
  drySkipAt(i: number, pressure: Float32Array, load: Float32Array): number {
    const threshold = mix(0.18, 0.86, pressure[i]) * (0.95 - 0.5 * load[i]);
    // Smooth, not binary: even a skipped peak keeps a trace of pigment.
    return clamp01((this.paper[i] - threshold) * 3.4);
  }
}
