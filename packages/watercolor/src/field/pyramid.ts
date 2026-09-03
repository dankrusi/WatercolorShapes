/**
 * Integer-factor shrink and expand for scalar fields.
 *
 * Used to run inherently smooth stages - the form shading in particular - on
 * a coarser grid than the output. The implied form is blurred at a radius of
 * roughly a sixth of the shape before it is ever lit, so computing it at full
 * supersampled resolution resolves nothing that survives the blur.
 */

/** Box-average shrink. Dimensions round up, so no edge pixels are dropped. */
export function shrink(
  src: Float32Array,
  width: number,
  height: number,
  factor: number,
): { data: Float32Array; width: number; height: number } {
  const f = Math.max(1, Math.round(factor));
  if (f === 1) return { data: src, width, height };
  const w = Math.max(1, Math.ceil(width / f));
  const h = Math.max(1, Math.ceil(height / f));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = y * f;
    const y1 = Math.min(height, y0 + f);
    for (let x = 0; x < w; x++) {
      const x0 = x * f;
      const x1 = Math.min(width, x0 + f);
      let acc = 0;
      let cnt = 0;
      for (let sy = y0; sy < y1; sy++) {
        const row = sy * width;
        for (let sx = x0; sx < x1; sx++) {
          acc += src[row + sx];
          cnt++;
        }
      }
      out[y * w + x] = cnt > 0 ? acc / cnt : 0;
    }
  }
  return { data: out, width: w, height: h };
}

/** Bilinear expand back to a target size. */
export function expand(
  src: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  factor: number,
): Float32Array {
  const f = Math.max(1, Math.round(factor));
  if (f === 1 && srcW === dstW && srcH === dstH) return src;
  const out = new Float32Array(dstW * dstH);
  const inv = 1 / f;
  let i = 0;
  for (let y = 0; y < dstH; y++) {
    // Sample at the centre of the coarse cell this pixel falls in.
    const gy = (y + 0.5) * inv - 0.5;
    const cy = gy < 0 ? 0 : gy > srcH - 1 ? srcH - 1 : gy;
    const y0 = cy | 0;
    const y1 = y0 + 1 < srcH ? y0 + 1 : y0;
    const fy = cy - y0;
    const r0 = y0 * srcW;
    const r1 = y1 * srcW;
    for (let x = 0; x < dstW; x++, i++) {
      const gx = (x + 0.5) * inv - 0.5;
      const cx = gx < 0 ? 0 : gx > srcW - 1 ? srcW - 1 : gx;
      const x0 = cx | 0;
      const x1 = x0 + 1 < srcW ? x0 + 1 : x0;
      const fx = cx - x0;
      const a = src[r0 + x0];
      const b = src[r0 + x1];
      const c = src[r1 + x0];
      const d = src[r1 + x1];
      const top = a + (b - a) * fx;
      const bot = c + (d - c) * fx;
      out[i] = top + (bot - top) * fy;
    }
  }
  return out;
}
