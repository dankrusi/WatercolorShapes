/**
 * Kubelka-Munk pigment optics.
 *
 * A watercolour layer is a thin film of scattering, absorbing pigment over a
 * reflective paper. Kubelka-Munk gives its reflectance R and transmittance T
 * as a function of layer thickness, which is why a real wash gets *more
 * saturated* as it gets darker rather than simply multiplying towards black.
 * Reproducing that is most of what separates a convincing wash from an
 * opacity ramp.
 *
 * Reference: Kubelka (1948); Curtis et al., "Computer-Generated Watercolor",
 * SIGGRAPH 1997, section 4.
 */

import type { RGB } from './color.js';

export interface Pigment {
  /** Absorption coefficient per channel. */
  K: RGB;
  /** Scattering coefficient per channel. */
  S: RGB;
}

/**
 * Derive K and S from the colour the pigment shows at full strength.
 *
 * Single-constant KM inverts to K/S = (1-R)^2 / 2R at infinite thickness.
 * `scattering` then chooses where on that family the pigment sits: low values
 * give a transparent, staining pigment (thin layers barely register, deep
 * layers go rich and dark); high values give a chalky, opaque, granulating one.
 */
export function pigmentFromColor(rgbLinear: RGB, scattering = 0.5, opacity = 1): Pigment {
  const K: RGB = [0, 0, 0];
  const S: RGB = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    // Clamp away from the poles: R = 0 makes K infinite, R = 1 makes K zero.
    const R = Math.min(0.999, Math.max(0.0015, rgbLinear[i]));
    const ks = ((1 - R) * (1 - R)) / (2 * R);
    // Bias scattering by luminance so dark pigments stay transparent and pale
    // ones stay bodied, matching how real paints behave.
    const s = Math.max(0.02, scattering * (0.35 + 0.65 * R)) * opacity;
    S[i] = s;
    K[i] = ks * s;
  }
  return { K, S };
}

const EPS = 1e-6;

/**
 * Reflectance and transmittance of a layer of thickness `x` (hyperbolic KM).
 */
export function layerRT(K: number, S: number, x: number): [number, number] {
  if (x <= EPS) return [0, 1];
  if (S < EPS) {
    // Pure absorber: Beer-Lambert.
    const t = Math.exp(-K * x);
    return [0, t];
  }
  const a = 1 + K / S;
  const b = Math.sqrt(Math.max(EPS, a * a - 1));
  const bSx = b * S * x;
  // Guard the hyperbolics: beyond about 30 they saturate to the opaque limit.
  if (bSx > 30) {
    const R = 1 / (a + b);
    return [R, 0];
  }
  const sh = Math.sinh(bSx);
  const ch = Math.cosh(bSx);
  const c = a * sh + b * ch;
  return [sh / c, b / c];
}

/**
 * Composite a pigment layer of thickness `x` over a backdrop reflectance.
 *
 * The denominator is the infinite series of internal inter-reflections between
 * layer and paper; it is what keeps a glaze looking like a glaze.
 */
export function overLayer(K: number, S: number, x: number, backdrop: number): number {
  const [R, T] = layerRT(K, S, x);
  const denom = 1 - R * backdrop;
  return R + (T * T * backdrop) / (denom > EPS ? denom : EPS);
}

/** Composite an RGB pigment layer over an RGB backdrop, all in linear light. */
export function compositePigment(p: Pigment, thickness: RGB | number, backdrop: RGB, out: RGB): RGB {
  const t0 = typeof thickness === 'number' ? thickness : thickness[0];
  const t1 = typeof thickness === 'number' ? thickness : thickness[1];
  const t2 = typeof thickness === 'number' ? thickness : thickness[2];
  out[0] = overLayer(p.K[0], p.S[0], t0, backdrop[0]);
  out[1] = overLayer(p.K[1], p.S[1], t1, backdrop[1]);
  out[2] = overLayer(p.K[2], p.S[2], t2, backdrop[2]);
  return out;
}

/**
 * Precompute a lookup of composited colour against a fixed paper, indexed by
 * pigment thickness.
 *
 * Thickness varies per pixel but K, S and the paper do not, so the expensive
 * hyperbolics collapse into a 1D table that the per-pixel loop reads with a
 * lerp. At 1024 entries the interpolation error is far below a quantisation
 * step of the 8-bit output.
 */
export class PigmentLut {
  readonly size: number;
  readonly maxThickness: number;
  private table: Float32Array;

  constructor(pigment: Pigment, paper: RGB, maxThickness = 6, size = 1024) {
    this.size = size;
    this.maxThickness = maxThickness;
    this.table = new Float32Array(size * 3);
    const out: RGB = [0, 0, 0];
    for (let i = 0; i < size; i++) {
      // Square the parameter so the table is dense where the eye is sensitive:
      // most of the visible change happens in the first fraction of thickness.
      const t = (i / (size - 1)) ** 2 * maxThickness;
      compositePigment(pigment, t, paper, out);
      this.table[i * 3] = out[0];
      this.table[i * 3 + 1] = out[1];
      this.table[i * 3 + 2] = out[2];
    }
  }

  /** Look up the composited linear-light colour for a pigment thickness. */
  sample(thickness: number, out: RGB): RGB {
    let u = Math.sqrt(Math.max(0, thickness) / this.maxThickness);
    if (u > 1) u = 1;
    const f = u * (this.size - 1);
    const i0 = f | 0;
    const i1 = i0 + 1 < this.size ? i0 + 1 : i0;
    const fr = f - i0;
    const a = i0 * 3;
    const b = i1 * 3;
    out[0] = this.table[a] + (this.table[b] - this.table[a]) * fr;
    out[1] = this.table[a + 1] + (this.table[b + 1] - this.table[a + 1]) * fr;
    out[2] = this.table[a + 2] + (this.table[b + 2] - this.table[a + 2]) * fr;
    return out;
  }
}

/**
 * The neat pigment behind a requested wash colour.
 *
 * A user asks for the colour they want the shape to *be*. That colour is a
 * dilute wash, not the paint in the pan: the paint is darker and more
 * saturated, and the wash is what a thin layer of it looks like over paper.
 * Raising each linear channel to a power does both at once, because the
 * smaller a channel is the more the power darkens it - which is exactly how a
 * real pigment gains chroma as the film thickens.
 *
 * Getting this the right way round is what keeps the wash off the flat top of
 * the Kubelka-Munk curve. Treating the input as neat pigment instead puts the
 * nominal thickness deep into saturation, where a 40% swing in pigment load
 * moves the output by almost nothing and every trace of granulation,
 * mottling and form shading is crushed out of the image.
 */
export function deepenColor(rgb: RGB, depth: number): RGB {
  const k = Math.max(1, depth);
  return [
    Math.pow(Math.max(1e-5, rgb[0]), k),
    Math.pow(Math.max(1e-5, rgb[1]), k),
    Math.pow(Math.max(1e-5, rgb[2]), k),
  ];
}

/**
 * Thickness at which a pigment layer over `paper` reaches a target luminance.
 * This is what turns "I want this colour" into "lay down this much paint".
 */
export function thicknessForLuminance(p: Pigment, paper: RGB, targetLum: number): number {
  const out: RGB = [0, 0, 0];
  let lo = 0;
  let hi = 48;
  for (let i = 0; i < 44; i++) {
    const mid = (lo + hi) / 2;
    compositePigment(p, mid, paper, out);
    const l = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
    if (l > targetLum) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Thickness at which a pigment reaches a given fraction of its full strength,
 * found by bisection. Used to normalise `intensity` so that changing the
 * scattering parameter does not also change how dark the wash reads.
 */
export function thicknessForCoverage(p: Pigment, paper: RGB, fraction: number): number {
  const target: RGB = [0, 0, 0];
  const out: RGB = [0, 0, 0];
  compositePigment(p, 64, paper, target);
  const lumTarget = 0.2126 * target[0] + 0.7152 * target[1] + 0.0722 * target[2];
  const lumPaper = 0.2126 * paper[0] + 0.7152 * paper[1] + 0.0722 * paper[2];
  const want = lumPaper + (lumTarget - lumPaper) * fraction;
  let lo = 0;
  let hi = 64;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    compositePigment(p, mid, paper, out);
    const l = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
    if (l > want) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
