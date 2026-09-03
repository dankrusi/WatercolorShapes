/**
 * Coarse-grid field evaluation.
 *
 * Most of the texture in a wash lives at scales far coarser than a pixel: the
 * mottling of a 500px shape has features 150px across, the dried patches
 * perhaps 60px. Evaluating a four-octave fBm at every one of a million
 * supersampled pixels to resolve a 150px feature is almost all wasted work -
 * and it was, measurably: the per-pixel noise was 93% of total render time.
 *
 * So each texture declares the finest scale it actually carries, is evaluated
 * on a grid matched to that scale, and is read back with bilinear
 * interpolation. The cost falls with the square of the factor while the
 * visible result is unchanged, because the samples were already oversampling
 * a band-limited signal.
 *
 * The one thing this must not be used for is a texture with genuinely hard
 * edges at pixel scale - a bilinear upsample would round them off. Those keep
 * a small factor or none at all.
 */

/**
 * Evaluate `fn(x, y)` on a grid `factor` times coarser in each axis, then
 * bilinearly upsample to full resolution.
 */
export function sampledField(
  width: number,
  height: number,
  factor: number,
  fn: (x: number, y: number) => number,
): Float32Array {
  const f = Math.max(1, Math.round(factor));
  if (f === 1) {
    const out = new Float32Array(width * height);
    let i = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++, i++) out[i] = fn(x, y);
    }
    return out;
  }

  // One extra sample on each axis so the last output pixel still interpolates
  // between two real samples instead of clamping.
  const cw = Math.ceil(width / f) + 1;
  const ch = Math.ceil(height / f) + 1;
  const coarse = new Float32Array(cw * ch);
  let ci = 0;
  for (let cy = 0; cy < ch; cy++) {
    const sy = cy * f;
    for (let cx = 0; cx < cw; cx++, ci++) coarse[ci] = fn(cx * f, sy);
  }

  const out = new Float32Array(width * height);
  const inv = 1 / f;
  let i = 0;
  for (let y = 0; y < height; y++) {
    const gy = y * inv;
    const y0 = gy | 0;
    const fy = gy - y0;
    const r0 = y0 * cw;
    const r1 = (y0 + 1 < ch ? y0 + 1 : y0) * cw;
    for (let x = 0; x < width; x++, i++) {
      const gx = x * inv;
      const x0 = gx | 0;
      const fx = gx - x0;
      const x1 = x0 + 1 < cw ? x0 + 1 : x0;
      const a = coarse[r0 + x0];
      const b = coarse[r0 + x1];
      const c = coarse[r1 + x0];
      const d = coarse[r1 + x1];
      const top = a + (b - a) * fx;
      const bot = c + (d - c) * fx;
      out[i] = top + (bot - top) * fy;
    }
  }
  return out;
}

/**
 * Pick a sampling factor for a texture whose finest feature spans
 * `featurePx` pixels. Two samples per feature is the Nyquist limit; three
 * gives a margin that keeps the interpolation from visibly rounding anything.
 */
export function factorFor(featurePx: number, max = 6): number {
  return Math.max(1, Math.min(max, Math.floor(featurePx / 3)));
}
