/**
 * Separable blurs and resampling helpers for scalar fields.
 */

/**
 * Approximate a Gaussian with three successive box blurs (Kovesi's box sizes).
 * Linear in the number of pixels regardless of sigma, which matters because
 * the shading pass blurs at radii comparable to the whole shape.
 */
export function gaussianBlur(
  src: Float32Array,
  width: number,
  height: number,
  sigma: number,
  dst?: Float32Array,
): Float32Array {
  const out = dst ?? new Float32Array(src.length);
  out.set(src);
  if (sigma <= 0.3) return out;
  const boxes = boxSizesForGauss(sigma, 3);
  const tmp = new Float32Array(src.length);
  for (let i = 0; i < 3; i++) {
    const r = (boxes[i] - 1) / 2;
    boxBlurH(out, tmp, width, height, r);
    boxBlurV(tmp, out, width, height, r);
  }
  return out;
}

function boxSizesForGauss(sigma: number, n: number): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

function boxBlurH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  if (r < 1) {
    dst.set(src);
    return;
  }
  const inv = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    let acc = src[base] * (r + 1);
    for (let i = 0; i < r; i++) acc += src[base + Math.min(i, w - 1)];
    for (let x = 0; x < w; x++) {
      acc += src[base + Math.min(x + r, w - 1)] - src[base + Math.max(x - r - 1, 0)];
      dst[base + x] = acc * inv;
    }
  }
}

function boxBlurV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  if (r < 1) {
    dst.set(src);
    return;
  }
  const inv = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    let acc = src[x] * (r + 1);
    for (let i = 0; i < r; i++) acc += src[Math.min(i, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      acc += src[Math.min(y + r, h - 1) * w + x] - src[Math.max(y - r - 1, 0) * w + x];
      dst[y * w + x] = acc * inv;
    }
  }
}

/**
 * Blur that only mixes values inside a mask, then renormalises.
 *
 * Used for the form-shading height field: without it, the blur pulls in the
 * zero outside the shape and the whole silhouette darkens by a rim artefact
 * that has nothing to do with pigment behaviour.
 */
export function maskedBlur(
  src: Float32Array,
  mask: Float32Array,
  width: number,
  height: number,
  sigma: number,
): Float32Array {
  const num = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) num[i] = src[i] * mask[i];
  const bn = gaussianBlur(num, width, height, sigma);
  const bd = gaussianBlur(mask, width, height, sigma);
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = bd[i] > 1e-4 ? bn[i] / bd[i] : src[i];
  return out;
}

/** Box-average downsample by an integer factor (the supersampling resolve). */
export function downsample(
  src: Float32Array,
  srcW: number,
  srcH: number,
  factor: number,
): { data: Float32Array; width: number; height: number } {
  if (factor === 1) return { data: src, width: srcW, height: srcH };
  const w = Math.floor(srcW / factor);
  const h = Math.floor(srcH / factor);
  const out = new Float32Array(w * h);
  const inv = 1 / (factor * factor);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let sy = 0; sy < factor; sy++) {
        const row = (y * factor + sy) * srcW + x * factor;
        for (let sx = 0; sx < factor; sx++) sum += src[row + sx];
      }
      out[y * w + x] = sum * inv;
    }
  }
  return { data: out, width: w, height: h };
}

/** Central-difference gradient of a scalar field. */
export function gradient(
  f: Float32Array,
  width: number,
  height: number,
): { gx: Float32Array; gy: Float32Array } {
  const gx = new Float32Array(f.length);
  const gy = new Float32Array(f.length);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    const up = (y > 0 ? y - 1 : 0) * width;
    const dn = (y < height - 1 ? y + 1 : height - 1) * width;
    for (let x = 0; x < width; x++) {
      const xl = x > 0 ? x - 1 : 0;
      const xr = x < width - 1 ? x + 1 : width - 1;
      gx[base + x] = (f[base + xr] - f[base + xl]) * 0.5;
      gy[base + x] = (f[dn + x] - f[up + x]) * 0.5;
    }
  }
  return { gx, gy };
}
