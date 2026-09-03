/**
 * Noise bases used to build pigment texture.
 *
 * All of them are pure functions of (x, y, seed) so a tile can be recomputed
 * at any resolution and still line up: doubling the render size and halving
 * the sample step gives the same pattern at twice the detail, which is what
 * lets `resolution` behave like a zoom rather than a re-roll.
 */

import { hash2, hash2v } from './rng.js';

const scratch: [number, number] = [0, 0];

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Value noise in [0,1), quintic-interpolated. */
export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = fade(xf);
  const v = fade(yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return top + (bot - top) * v;
}

/**
 * Unit gradient directions for `gradNoise`.
 *
 * A table rather than `Math.cos`/`Math.sin` per lattice corner. Four
 * transcendental calls per noise sample, several noise samples per octave and
 * several octaves per texture put the trig squarely in the hot loop; 64
 * directions is more than enough to keep the field isotropic, and the lookup
 * is roughly twenty times cheaper.
 */
const GRAD_N = 64;
const GRAD_X = new Float32Array(GRAD_N);
const GRAD_Y = new Float32Array(GRAD_N);
for (let i = 0; i < GRAD_N; i++) {
  const a = (i / GRAD_N) * Math.PI * 2;
  GRAD_X[i] = Math.cos(a);
  GRAD_Y[i] = Math.sin(a);
}
const GRAD_MASK = GRAD_N - 1;

/** Gradient (Perlin-style) noise in roughly [-1,1]. Smoother than value noise. */
export function gradNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = fade(xf);
  const v = fade(yf);

  let h = (Math.imul(xi, 374761393) + Math.imul(yi, 668265263) + Math.imul(seed, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  let g = (h ^ (h >>> 16)) & GRAD_MASK;
  const a = GRAD_X[g] * xf + GRAD_Y[g] * yf;

  h = (Math.imul(xi + 1, 374761393) + Math.imul(yi, 668265263) + Math.imul(seed, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  g = (h ^ (h >>> 16)) & GRAD_MASK;
  const b = GRAD_X[g] * (xf - 1) + GRAD_Y[g] * yf;

  h = (Math.imul(xi, 374761393) + Math.imul(yi + 1, 668265263) + Math.imul(seed, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  g = (h ^ (h >>> 16)) & GRAD_MASK;
  const c = GRAD_X[g] * xf + GRAD_Y[g] * (yf - 1);

  h = (Math.imul(xi + 1, 374761393) + Math.imul(yi + 1, 668265263) + Math.imul(seed, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  g = (h ^ (h >>> 16)) & GRAD_MASK;
  const d = GRAD_X[g] * (xf - 1) + GRAD_Y[g] * (yf - 1);

  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return (top + (bot - top) * v) * 1.4;
}

export interface FbmOptions {
  octaves?: number;
  lacunarity?: number;
  gain?: number;
  /** Use gradient noise instead of value noise (smoother, zero-mean). */
  grad?: boolean;
  /** Take |n| and invert, producing creased ridges. */
  ridged?: boolean;
}

/**
 * Fractal Brownian motion. Returns approximately [0,1] for value noise and
 * approximately [-1,1] for gradient noise (before the 0.5 recentre below).
 */
export function fbm(x: number, y: number, seed: number, opts: FbmOptions = {}): number {
  const octaves = opts.octaves ?? 4;
  const lacunarity = opts.lacunarity ?? 2.0;
  const gain = opts.gain ?? 0.5;
  const grad = opts.grad ?? false;
  const ridged = opts.ridged ?? false;
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    let n = grad ? gradNoise(x * freq, y * freq, seed + o * 7919) : valueNoise(x * freq, y * freq, seed + o * 7919) * 2 - 1;
    if (ridged) n = 1 - 2 * Math.abs(n);
    sum += n * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm; // ~[-1, 1]
}

/** fBm remapped to [0,1]. */
export function fbm01(x: number, y: number, seed: number, opts: FbmOptions = {}): number {
  return fbm(x, y, seed, opts) * 0.5 + 0.5;
}

export interface WorleyResult {
  /** Distance to the nearest feature point, in cell units. */
  f1: number;
  /** Distance to the second nearest feature point, in cell units. */
  f2: number;
  /** Stable per-cell random value of the owning cell, in [0,1). */
  id: number;
  /** Offset from the sample to the owning feature point. */
  dx: number;
  dy: number;
}

const worleyOut: WorleyResult = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };

/**
 * Worley / cellular noise. `f2 - f1` traces the cell walls, which is what
 * gives blooms and back-runs their hard, faceted rims; `id` gives each cell a
 * flat tone so the interior reads as overlapping dried patches.
 */
export function worley(x: number, y: number, seed: number, jitter = 1): WorleyResult {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 1e9;
  let f2 = 1e9;
  let id = 0;
  let bdx = 0;
  let bdy = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = xi + ox;
      const cy = yi + oy;
      hash2v(cx, cy, seed, scratch);
      const px = cx + 0.5 + (scratch[0] - 0.5) * jitter;
      const py = cy + 0.5 + (scratch[1] - 0.5) * jitter;
      const dx = px - x;
      const dy = py - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hash2(cx, cy, seed ^ 0x5bf03635);
        bdx = dx;
        bdy = dy;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  worleyOut.f1 = f1;
  worleyOut.f2 = f2;
  worleyOut.id = id;
  worleyOut.dx = bdx;
  worleyOut.dy = bdy;
  return worleyOut;
}

/**
 * Domain warp: displaces the sample point by a low-frequency fBm field.
 * Turns the round cells of Worley noise into the irregular, lobed patches a
 * drying wash actually leaves behind.
 */
export function warp(
  x: number,
  y: number,
  seed: number,
  amount: number,
  freq: number,
  out: [number, number],
  octaves = 3,
): [number, number] {
  out[0] = x + amount * fbm(x * freq, y * freq, seed, { octaves, grad: true });
  out[1] = y + amount * fbm(x * freq + 31.7, y * freq - 17.3, seed ^ 0x1a2b3c4d, { octaves, grad: true });
  return out;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
