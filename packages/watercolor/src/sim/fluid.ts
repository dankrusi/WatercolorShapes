/**
 * Shallow-water watercolour simulation.
 *
 * Follows the structure of Curtis, Anderson, Seims, Fleischer & Salesin,
 * "Computer-Generated Watercolor" (SIGGRAPH 1997): a shallow-water layer
 * carrying suspended pigment over a pigment-deposition layer, with a
 * capillary layer underneath that wicks water through the paper.
 *
 * Each timestep runs the same four stages as the paper:
 *
 *   moveWater        - advect and diffuse velocity, drive it by the water
 *                      surface gradient, then push water outwards towards the
 *                      wet-mask boundary
 *   movePigment      - advect suspended pigment with the flow
 *   transferPigment  - adsorb pigment onto the paper and re-dissolve it,
 *                      both biased by the paper's tooth
 *   capillaryFlow    - wick water through the fibres beyond the visible wet
 *                      area, letting the wash creep
 *
 * The edge darkening in the output is not painted on: it falls out of
 * `flowOutward` carrying pigment to the perimeter faster than it carries it
 * back, exactly as in a real drying puddle.
 */

import { fbm01 } from '../noise.js';

export interface FluidOptions {
  width: number;
  height: number;
  /** Initial wet area, 0..1. */
  mask: Float32Array;
  /** Paper height, 0..1. */
  paper: Float32Array;
  /** Initial suspended pigment per cell. */
  pigment: Float32Array;
  steps: number;
  viscosity: number;
  drag: number;
  /** Adsorption rate. */
  deposition: number;
  /** Desorption (re-dissolve) rate. */
  lift: number;
  /** How strongly the tooth biases adsorption; 0 is a perfectly even paper. */
  granularity: number;
  /** Outward pressure gradient strength, the edge-darkening driver. */
  edgePull: number;
  /** Capillary wicking strength. */
  capillary: number;
  seed: number;
}

export interface FluidResult {
  /** All the pigment, once the wash has dried and settled onto the paper. */
  deposited: Float32Array;
  /** Final wet area, which capillary wicking may have grown. */
  wet: Float32Array;
}

const DT = 1;

export function simulateWash(o: FluidOptions): FluidResult {
  const { width: w, height: h } = o;
  const n = w * h;

  // Shallow-water state.
  let u = new Float32Array(n);
  let v = new Float32Array(n);
  let p = new Float32Array(n); // water surface height
  const M = new Float32Array(n); // wet mask
  let g = new Float32Array(n); // suspended pigment
  const d = new Float32Array(n); // deposited pigment

  // Capillary layer.
  const s = new Float32Array(n); // fluid saturation in the fibres
  const c = new Float32Array(n); // fluid capacity of the fibres

  // Initial water height varies with the tooth: a wash sits deeper in the
  // pits, and that unevenness is the seed for every later flow pattern.
  for (let i = 0; i < n; i++) {
    const m = o.mask[i];
    M[i] = m > 0.5 ? 1 : 0;
    p[i] = m * (0.85 + (1 - o.paper[i]) * 0.5);
    g[i] = o.pigment[i];
    c[i] = 0.45 + o.paper[i] * 0.55;
    s[i] = m > 0.5 ? c[i] * 0.75 : 0;
  }

  // A weak, divergence-free-ish initial stir standing in for the brush
  // stroke that laid the wash down. Without it the first few steps have no
  // flow to advect anything with and the result is suspiciously symmetric.
  const stirFreq = 3.5 / Math.max(1, Math.min(w, h));
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (!M[i]) continue;
      const a = fbm01(x * stirFreq, y * stirFreq, o.seed ^ 0x51ab3d7f, { octaves: 3, grad: true });
      const b = fbm01(x * stirFreq + 19.3, y * stirFreq - 7.1, o.seed ^ 0x2ff3a19b, { octaves: 3, grad: true });
      u[i] = (a - 0.5) * 0.9;
      v[i] = (b - 0.5) * 0.9;
    }
  }

  const tmpA = new Float32Array(n);
  const tmpB = new Float32Array(n);
  const blurM = new Float32Array(n);
  const div = new Float32Array(n);
  const q = new Float32Array(n);
  const q2 = new Float32Array(n);
  let gTmp = new Float32Array(n);

  const steps = Math.max(1, Math.round(o.steps));
  for (let step = 0; step < steps; step++) {
    // The wash dries over the run: water leaves, the flow stiffens, and
    // adsorption starts to win over re-dissolving. Everything that makes a
    // real wash settle rather than churn forever is in this one ramp.
    const dryness = step / steps;
    const wetness = 1 - dryness * dryness;

    moveWater(w, h, M, u, v, p, blurM, tmpA, tmpB, div, q, q2, o, wetness);
    movePigmentInto(w, h, M, u, v, g, gTmp, wetness);
    const swap = g;
    g = gTmp;
    gTmp = swap;
    transferPigment(n, M, g, d, o, dryness);
    if (o.capillary > 0) capillaryFlow(w, h, M, s, c, o, wetness);
  }

  // Whatever is still suspended when the water goes settles where it stands.
  for (let i = 0; i < n; i++) d[i] += g[i];

  return { deposited: d, wet: M };
}

function moveWater(
  w: number,
  h: number,
  M: Float32Array,
  u: Float32Array,
  v: Float32Array,
  p: Float32Array,
  blurM: Float32Array,
  /** Scratch for the advected u and v components. */
  tu: Float32Array,
  tv: Float32Array,
  div: Float32Array,
  q: Float32Array,
  q2: Float32Array,
  o: FluidOptions,
  wetness: number,
): void {
  const n = w * h;
  const visc = o.viscosity;
  const drag = o.drag;

  // --- advect velocity (semi-Lagrangian, unconditionally stable) ---------
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (!M[i]) {
        tu[i] = 0;
        tv[i] = 0;
        continue;
      }
      const px = x - DT * u[i];
      const py = y - DT * v[i];
      tu[i] = bilinear(u, w, h, px, py);
      tv[i] = bilinear(v, w, h, px, py);
    }
  }

  // --- viscosity, surface-gradient forcing, drag -------------------------
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (!M[i]) {
        u[i] = 0;
        v[i] = 0;
        continue;
      }
      const xl = x > 0 ? i - 1 : i;
      const xr = x < w - 1 ? i + 1 : i;
      const yu = y > 0 ? i - w : i;
      const yd = y < h - 1 ? i + w : i;
      // Laplacian smoothing stands in for the viscous term.
      const lu = (tu[xl] + tu[xr] + tu[yu] + tu[yd]) * 0.25 - tu[i];
      const lv = (tv[xl] + tv[xr] + tv[yu] + tv[yd]) * 0.25 - tv[i];
      // Water runs downhill on its own surface.
      const gx = (p[xr] - p[xl]) * 0.5;
      const gy = (p[yd] - p[yu]) * 0.5;
      let nu = tu[i] + visc * 4 * lu - gx * 0.9 * wetness;
      let nv = tv[i] + visc * 4 * lv - gy * 0.9 * wetness;
      nu *= 1 - drag;
      nv *= 1 - drag;
      // Clamp: a cell should not move more than one cell per step, or the
      // semi-Lagrangian trace starts skipping structure.
      u[i] = nu > 0.9 ? 0.9 : nu < -0.9 ? -0.9 : nu;
      v[i] = nv > 0.9 ? 0.9 : nv < -0.9 ? -0.9 : nv;
    }
  }

  // --- project to (near-)divergence-free ---------------------------------
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (!M[i]) {
        div[i] = 0;
        q[i] = 0;
        continue;
      }
      const xl = x > 0 && M[i - 1] ? i - 1 : i;
      const xr = x < w - 1 && M[i + 1] ? i + 1 : i;
      const yu = y > 0 && M[i - w] ? i - w : i;
      const yd = y < h - 1 && M[i + w] ? i + w : i;
      div[i] = (u[xr] - u[xl] + v[yd] - v[yu]) * 0.5;
      q[i] = 0;
    }
  }
  // Jacobi. Six sweeps leaves a little residual divergence, which is fine
  // here: a small compressible slack reads as the wash breathing rather than
  // as an artefact, and the alternative costs more than the look is worth.
  let src = q;
  let dst = q2;
  for (let it = 0; it < 6; it++) {
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i++) {
        if (!M[i]) {
          dst[i] = 0;
          continue;
        }
        const xl = x > 0 && M[i - 1] ? i - 1 : i;
        const xr = x < w - 1 && M[i + 1] ? i + 1 : i;
        const yu = y > 0 && M[i - w] ? i - w : i;
        const yd = y < h - 1 && M[i + w] ? i + w : i;
        dst[i] = (src[xl] + src[xr] + src[yu] + src[yd] - div[i]) * 0.25;
      }
    }
    const t = src;
    src = dst;
    dst = t;
  }
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (!M[i]) continue;
      const xl = x > 0 && M[i - 1] ? i - 1 : i;
      const xr = x < w - 1 && M[i + 1] ? i + 1 : i;
      const yu = y > 0 && M[i - w] ? i - w : i;
      const yd = y < h - 1 && M[i + w] ? i + w : i;
      u[i] -= (src[xr] - src[xl]) * 0.5;
      v[i] -= (src[yd] - src[yu]) * 0.5;
    }
  }

  // --- continuity: the water surface follows the flow --------------------
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (!M[i]) continue;
      const px = x - DT * u[i];
      const py = y - DT * v[i];
      tu[i] = bilinear(p, w, h, px, py);
    }
  }
  for (let i = 0; i < n; i++) if (M[i]) p[i] = tu[i];

  // --- flowOutward -------------------------------------------------------
  // Evaporation is fastest at the perimeter, so replenishing flow runs
  // outwards and strands pigment there. Subtracting a blurred mask from the
  // water height builds precisely that gradient.
  if (o.edgePull > 0) {
    boxBlur3(M, blurM, w, h, Math.max(2, Math.round(Math.min(w, h) * 0.035)));
    for (let i = 0; i < n; i++) {
      if (!M[i]) continue;
      p[i] -= o.edgePull * (1 - blurM[i]) * wetness;
      if (p[i] < 0) p[i] = 0;
    }
  }
}

/** Advect suspended pigment along the flow, writing into `out`. */
function movePigmentInto(
  w: number,
  h: number,
  M: Float32Array,
  u: Float32Array,
  v: Float32Array,
  g: Float32Array,
  out: Float32Array,
  wetness: number,
): void {
  const scale = 0.4 + 0.6 * wetness;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (!M[i]) {
        out[i] = g[i];
        continue;
      }
      const px = x - DT * u[i] * scale;
      const py = y - DT * v[i] * scale;
      out[i] = bilinearMasked(g, M, w, h, px, py, g[i]);
    }
  }
}

/**
 * Adsorption and desorption between the water and the paper.
 *
 * `granularity` biases both directions by the tooth: pigment binds readily in
 * a pit and is lifted easily off a peak, which is what turns an even wash
 * into a granulated one over the course of the run.
 */
function transferPigment(
  n: number,
  M: Float32Array,
  g: Float32Array,
  d: Float32Array,
  o: FluidOptions,
  dryness: number,
): void {
  const rho = o.deposition * (0.4 + 1.6 * dryness);
  const omega = o.lift * (1 - dryness * 0.8);
  const gamma = o.granularity;
  for (let i = 0; i < n; i++) {
    if (!M[i]) continue;
    const h = o.paper[i];
    let down = g[i] * (1 - (h - 0.5) * gamma) * rho;
    let up = d[i] * (1 + (h - 0.5) * gamma) * omega;
    if (down < 0) down = 0;
    if (up < 0) up = 0;
    // Saturation: the paper can only hold so much before it stops taking more.
    const room = Math.max(0, 2.5 - d[i]);
    if (down > room) down = room;
    if (up > d[i]) up = d[i];
    const delta = down - up;
    d[i] += delta;
    g[i] -= delta;
    if (g[i] < 0) g[i] = 0;
  }
}

/**
 * Capillary wicking through the fibres.
 *
 * Water moves from wetter fibres to drier ones as long as the receiver has
 * capacity left; where saturation passes a threshold the visible wet area
 * grows. This is what lets the wash creep a fibre's width past where the
 * brush stopped - the fine irregularity along the reference edges.
 */
function capillaryFlow(
  w: number,
  h: number,
  M: Float32Array,
  s: Float32Array,
  c: Float32Array,
  o: FluidOptions,
  wetness: number,
): void {
  const n = w * h;
  const rate = o.capillary * 0.25 * wetness;
  const eps = 0.08;
  const delta = 0.62;
  const src = s.slice();
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const si = src[i];
      if (si <= eps) continue;
      for (let k = 0; k < 4; k++) {
        const j =
          k === 0 ? (x > 0 ? i - 1 : -1)
          : k === 1 ? (x < w - 1 ? i + 1 : -1)
          : k === 2 ? (y > 0 ? i - w : -1)
          : y < h - 1 ? i + w : -1;
        if (j < 0) continue;
        const sj = src[j];
        if (si <= sj || sj >= c[j]) continue;
        const move = Math.min(si - sj, c[j] - sj) * 0.25 * rate;
        s[i] -= move;
        s[j] += move;
      }
    }
  }
  for (let i = 0; i < n; i++) if (!M[i] && s[i] > delta) M[i] = 1;
}

function bilinear(f: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < 0) x = 0;
  else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  const r0 = y0 * w;
  const r1 = y1 * w;
  const a = f[r0 + x0];
  const b = f[r0 + x1];
  const cc = f[r1 + x0];
  const dd = f[r1 + x1];
  return a + (b - a) * fx + (cc - a) * fy + (a - b - cc + dd) * fx * fy;
}

/** Bilinear sample that ignores dry cells, so pigment cannot be drawn in
 * from outside the wash. */
function bilinearMasked(
  f: Float32Array,
  M: Float32Array,
  w: number,
  h: number,
  x: number,
  y: number,
  fallback: number,
): number {
  if (x < 0) x = 0;
  else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  const idx = [y0 * w + x0, y0 * w + x1, y1 * w + x0, y1 * w + x1];
  const wgt = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
  let acc = 0;
  let wsum = 0;
  for (let k = 0; k < 4; k++) {
    if (!M[idx[k]]) continue;
    acc += f[idx[k]] * wgt[k];
    wsum += wgt[k];
  }
  return wsum > 1e-4 ? acc / wsum : fallback;
}

/** Separable box blur used only for the flowOutward mask. */
function boxBlur3(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const tmp = new Float32Array(src.length);
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    let acc = src[base] * (r + 1);
    for (let i = 0; i < r; i++) acc += src[base + Math.min(i, w - 1)];
    for (let x = 0; x < w; x++) {
      acc += src[base + Math.min(x + r, w - 1)] - src[base + Math.max(x - r - 1, 0)];
      tmp[base + x] = acc * inv;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = tmp[x] * (r + 1);
    for (let i = 0; i < r; i++) acc += tmp[Math.min(i, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      acc += tmp[Math.min(y + r, h - 1) * w + x] - tmp[Math.max(y - r - 1, 0) * w + x];
      dst[y * w + x] = acc * inv;
    }
  }
}
