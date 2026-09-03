/**
 * Analytic-coverage polygon rasteriser.
 *
 * Each output row is sampled at `subSamples` sub-scanlines; within a
 * sub-scanline the span ends contribute fractional coverage, so a straight
 * edge comes out exact and a curved one is limited only by the sub-scanline
 * count. Coverage is what the rest of the pipeline reads, not a hard mask,
 * which is how the silhouette can stay crisp while still being perturbed at
 * sub-pixel amplitude.
 */

import type { Contour } from './parse.js';

export type FillRule = 'nonzero' | 'evenodd';

interface Edge {
  /** Top y (already clipped to the raster). */
  y0: number;
  /** Bottom y. */
  y1: number;
  /** x at y0. */
  x: number;
  /** dx/dy. */
  dxdy: number;
  /** +1 or -1, for the nonzero winding count. */
  dir: number;
}

/**
 * Rasterise contours into a Float32Array of per-pixel coverage in [0,1].
 */
export function rasterize(
  contours: Contour[],
  width: number,
  height: number,
  fillRule: FillRule = 'nonzero',
  subSamples = 8,
): Float32Array {
  const cov = new Float32Array(width * height);
  const edges: Edge[] = [];
  for (const c of contours) {
    for (let i = 0; i + 3 < c.length; i += 2) {
      const ax = c[i];
      const ay = c[i + 1];
      const bx = c[i + 2];
      const by = c[i + 3];
      if (ay === by) continue;
      const dir = ay < by ? 1 : -1;
      const y0 = dir === 1 ? ay : by;
      const y1 = dir === 1 ? by : ay;
      const x0 = dir === 1 ? ax : bx;
      const dxdy = (bx - ax) / (by - ay);
      edges.push({ y0, y1, x: x0, dxdy, dir });
    }
  }
  if (edges.length === 0) return cov;
  edges.sort((p, q) => p.y0 - q.y0);

  const inc = 1 / subSamples;
  const weight = 1 / subSamples;
  let nextEdge = 0;
  let active: Edge[] = [];
  const xs: number[] = [];
  const dirs: number[] = [];

  let minY = Infinity;
  let maxY = -Infinity;
  for (const e of edges) {
    if (e.y0 < minY) minY = e.y0;
    if (e.y1 > maxY) maxY = e.y1;
  }
  const rowStart = Math.max(0, Math.floor(minY));
  const rowEnd = Math.min(height - 1, Math.ceil(maxY));

  // Fast-forward the edge cursor to the first visible row.
  while (nextEdge < edges.length && edges[nextEdge].y0 < rowStart) {
    if (edges[nextEdge].y1 > rowStart) active.push(edges[nextEdge]);
    nextEdge++;
  }

  for (let py = rowStart; py <= rowEnd; py++) {
    const rowBase = py * width;
    for (let s = 0; s < subSamples; s++) {
      const sy = py + (s + 0.5) * inc;
      while (nextEdge < edges.length && edges[nextEdge].y0 <= sy) {
        active.push(edges[nextEdge]);
        nextEdge++;
      }
      if (active.length === 0) continue;
      let compact = false;
      xs.length = 0;
      dirs.length = 0;
      for (let i = 0; i < active.length; i++) {
        const e = active[i];
        if (e.y1 <= sy) {
          compact = true;
          continue;
        }
        if (e.y0 > sy) continue;
        xs.push(e.x + (sy - e.y0) * e.dxdy);
        dirs.push(e.dir);
      }
      if (compact) active = active.filter((e) => e.y1 > sy);
      const n = xs.length;
      if (n < 2) continue;
      // Insertion sort: crossing lists are short and nearly sorted row to row.
      for (let i = 1; i < n; i++) {
        const xv = xs[i];
        const dv = dirs[i];
        let j = i - 1;
        while (j >= 0 && xs[j] > xv) {
          xs[j + 1] = xs[j];
          dirs[j + 1] = dirs[j];
          j--;
        }
        xs[j + 1] = xv;
        dirs[j + 1] = dv;
      }
      let winding = 0;
      for (let i = 0; i < n - 1; i++) {
        winding += fillRule === 'nonzero' ? dirs[i] : 1;
        const inside = fillRule === 'nonzero' ? winding !== 0 : (winding & 1) === 1;
        if (!inside) continue;
        addSpan(cov, rowBase, width, xs[i], xs[i + 1], weight);
      }
    }
  }
  return cov;
}

/** Accumulate a horizontal span [xa, xb) with analytic end coverage. */
function addSpan(
  cov: Float32Array,
  rowBase: number,
  width: number,
  xa: number,
  xb: number,
  weight: number,
): void {
  if (xb <= 0 || xa >= width || xb <= xa) return;
  if (xa < 0) xa = 0;
  if (xb > width) xb = width;
  const ia = Math.floor(xa);
  const ib = Math.floor(xb);
  if (ia === ib) {
    cov[rowBase + ia] += (xb - xa) * weight;
    return;
  }
  cov[rowBase + ia] += (ia + 1 - xa) * weight;
  for (let x = ia + 1; x < ib; x++) cov[rowBase + x] += weight;
  if (ib < width) cov[rowBase + ib] += (xb - ib) * weight;
}

/**
 * Compute the exact Euclidean distance transform of a binary field
 * (Felzenszwalb & Huttenlocher, O(n) per dimension).
 *
 * `f` holds squared-distance seeds: 0 where the feature is, large elsewhere.
 * Returns squared distances, in place.
 */
export function edtSquared(f: Float64Array, width: number, height: number): Float64Array {
  const n = Math.max(width, height);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);

  const transform1D = (get: (i: number) => number, set: (i: number, val: number) => void, len: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      const fq = get(q);
      let s = 0;
      for (;;) {
        const p = v[k];
        s = (fq + q * q - (get(p) + p * p)) / (2 * q - 2 * p);
        if (s <= z[k]) {
          k--;
          if (k < 0) {
            k = 0;
            break;
          }
        } else break;
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const p = v[k];
      d[q] = (q - p) * (q - p) + get(p);
    }
    for (let q = 0; q < len; q++) set(q, d[q]);
  };

  // Columns.
  for (let x = 0; x < width; x++) {
    transform1D(
      (i) => f[i * width + x],
      (i, val) => {
        f[i * width + x] = val;
      },
      height,
    );
  }
  // Rows.
  for (let y = 0; y < height; y++) {
    const base = y * width;
    transform1D(
      (i) => f[base + i],
      (i, val) => {
        f[base + i] = val;
      },
      width,
    );
  }
  return f;
}

/**
 * Signed distance in pixels from a coverage field. Positive inside.
 *
 * Near the boundary the exact grid distance is replaced by the sub-pixel
 * estimate `coverage - 0.5`, so the field stays smooth across the edge instead
 * of quantising to whole pixels. That matters: the edge perturbation is a
 * displacement of this field, and a quantised field would produce visible
 * staircase artefacts rather than a fibre-pinned wash edge.
 */
export function signedDistance(cov: Float32Array, width: number, height: number): Float32Array {
  const size = width * height;
  const inside = new Float64Array(size);
  const outside = new Float64Array(size);
  const BIG = 1e12;
  for (let i = 0; i < size; i++) {
    const solid = cov[i] >= 0.5;
    inside[i] = solid ? BIG : 0;
    outside[i] = solid ? 0 : BIG;
  }
  edtSquared(inside, width, height);
  edtSquared(outside, width, height);
  const sdf = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const c = cov[i];
    if (c > 0.02 && c < 0.98) {
      // Partially covered pixel: read the sub-pixel position straight off the
      // coverage, which is accurate to well under a pixel for smooth edges.
      sdf[i] = c - 0.5;
    } else if (c >= 0.98) {
      sdf[i] = Math.sqrt(inside[i]) - 0.5;
    } else {
      sdf[i] = -(Math.sqrt(outside[i]) - 0.5);
    }
  }
  return sdf;
}

/** Bilinear sample of a scalar field, clamped at the borders. */
export function sampleBilinear(
  field: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  if (x < 0) x = 0;
  else if (x > width - 1) x = width - 1;
  if (y < 0) y = 0;
  else if (y > height - 1) y = height - 1;
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = x0 + 1 < width ? x0 + 1 : x0;
  const y1 = y0 + 1 < height ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  const r0 = y0 * width;
  const r1 = y1 * width;
  const a = field[r0 + x0];
  const b = field[r0 + x1];
  const c = field[r1 + x0];
  const d = field[r1 + x1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
