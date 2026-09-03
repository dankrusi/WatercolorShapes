/**
 * Gradient fills.
 *
 * When the input path carries a gradient, the gradient takes over the job the
 * form shading would otherwise do: its own light-to-dark run becomes the
 * pigment thickness variation, and its hue run becomes a pigment ramp. The
 * wash then follows the artwork's intended shading rather than an invented
 * one, while still granulating, blooming and edge-darkening on top.
 */

import { linearToSrgb, parseColor, srgbToLinear, toLinear, type RGB } from '../color/color.js';
import { compositePigment, layerRT, PigmentLut, type Pigment } from '../color/km.js';
import { solvePigment } from '../color/solve.js';
import { applyMatrix, parseTransform, type Matrix } from '../path/parse.js';
import { clamp01 } from '../noise.js';
import type { GradientFill } from '../types.js';

export interface ResolvedStop {
  offset: number;
  rgbLinear: RGB;
  alpha: number;
}

export function resolveStops(fill: GradientFill): ResolvedStop[] {
  const stops = (fill.stops ?? [])
    .map((s) => {
      const c = parseColor(s.color);
      return {
        offset: clamp01(s.offset),
        rgbLinear: toLinear(c.rgb),
        alpha: c.alpha * (s.opacity ?? 1),
      };
    })
    .sort((a, b) => a.offset - b.offset);
  if (stops.length === 0) return [{ offset: 0, rgbLinear: [0, 0, 0], alpha: 1 }];
  if (stops.length === 1) return [stops[0], { ...stops[0], offset: 1 }];
  return stops;
}

/** Sample the stop list at t, interpolating in linear light. */
export function sampleStops(stops: ResolvedStop[], t: number, out: RGB): number {
  t = clamp01(t);
  if (t <= stops[0].offset) {
    out[0] = stops[0].rgbLinear[0];
    out[1] = stops[0].rgbLinear[1];
    out[2] = stops[0].rgbLinear[2];
    return stops[0].alpha;
  }
  const last = stops[stops.length - 1];
  if (t >= last.offset) {
    out[0] = last.rgbLinear[0];
    out[1] = last.rgbLinear[1];
    out[2] = last.rgbLinear[2];
    return last.alpha;
  }
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].offset) {
      const a = stops[i - 1];
      const b = stops[i];
      const span = b.offset - a.offset;
      const f = span > 1e-9 ? (t - a.offset) / span : 0;
      out[0] = a.rgbLinear[0] + (b.rgbLinear[0] - a.rgbLinear[0]) * f;
      out[1] = a.rgbLinear[1] + (b.rgbLinear[1] - a.rgbLinear[1]) * f;
      out[2] = a.rgbLinear[2] + (b.rgbLinear[2] - a.rgbLinear[2]) * f;
      return a.alpha + (b.alpha - a.alpha) * f;
    }
  }
  return 1;
}

export interface GradientField {
  /** Per-pixel gradient parameter in [0,1]. */
  t: Float32Array;
  stops: ResolvedStop[];
}

/**
 * Evaluate the gradient's parameter at every pixel.
 *
 * `bbox` is the shape's device-space bounding box, used to resolve
 * objectBoundingBox units.
 */
export function computeGradientField(
  fill: GradientFill,
  width: number,
  height: number,
  bbox: { x: number; y: number; w: number; h: number },
  userToDevice: Matrix,
): GradientField {
  const stops = resolveStops(fill);
  const t = new Float32Array(width * height);
  const objectUnits = (fill.units ?? 'objectBoundingBox') === 'objectBoundingBox';
  const gt = parseTransform(fill.transform);

  // Build the mapping from gradient-local coordinates to device pixels.
  const p = { x: 0, y: 0 };
  const toDevice = (gx: number, gy: number): { x: number; y: number } => {
    applyMatrix(gt, gx, gy, p);
    if (objectUnits) {
      return { x: bbox.x + p.x * bbox.w, y: bbox.y + p.y * bbox.h };
    }
    const q = { x: 0, y: 0 };
    applyMatrix(userToDevice, p.x, p.y, q);
    return q;
  };

  if (fill.type === 'linear') {
    const a = toDevice(fill.x1, fill.y1);
    const b = toDevice(fill.x2, fill.y2);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1e-9;
    let i = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++, i++) {
        t[i] = clamp01(((x + 0.5 - a.x) * dx + (y + 0.5 - a.y) * dy) / len2);
      }
    }
  } else {
    const c = toDevice(fill.cx, fill.cy);
    const f = toDevice(fill.fx ?? fill.cx, fill.fy ?? fill.cy);
    // Radius in device units: average the two axes of the transformed circle.
    const edge = toDevice(fill.cx + fill.r, fill.cy);
    const edge2 = toDevice(fill.cx, fill.cy + fill.r);
    const r1 = Math.hypot(edge.x - c.x, edge.y - c.y);
    const r2 = Math.hypot(edge2.x - c.x, edge2.y - c.y);
    const r = Math.max(1e-6, (r1 + r2) / 2);
    let i = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++, i++) {
        // Focal-point radial: parameterise along the ray from the focus.
        const px = x + 0.5 - f.x;
        const py = y + 0.5 - f.y;
        const fcx = f.x - c.x;
        const fcy = f.y - c.y;
        const A = px * px + py * py;
        const B = 2 * (px * fcx + py * fcy);
        const C = fcx * fcx + fcy * fcy - r * r;
        // Solve |f + s*p - c| = r for s; t = 1/s.
        let val: number;
        if (Math.abs(A) < 1e-12) {
          val = 0;
        } else {
          const disc = B * B - 4 * A * C;
          const s = disc <= 0 ? 1 : (-B + Math.sqrt(disc)) / (2 * A);
          val = s > 1e-9 ? 1 / s : 1;
        }
        t[i] = clamp01(val);
      }
    }
  }
  return { t, stops };
}

/**
 * A stack of Kubelka-Munk lookup tables sampled along a colour ramp.
 *
 * Compositing a pigment whose K and S change per pixel would mean evaluating
 * hyperbolics per pixel. Sampling the ramp at `slices` points and lerping
 * between two tables costs two lookups instead, and at 24 slices the
 * difference from the exact result is below one 8-bit step for every ramp
 * tested here.
 */
export class PigmentRamp {
  private luts: PigmentLut[];
  readonly pigments: Pigment[];
  /** Per-slice thickness at which that slice composites to its stop colour. */
  readonly nominal: Float32Array;
  readonly meanNominal: number;
  private alphas: Float32Array;
  readonly slices: number;
  private tmpA: RGB = [0, 0, 0];
  private tmpB: RGB = [0, 0, 0];

  constructor(
    stops: ResolvedStop[],
    paper: RGB,
    scattering: number,
    bodyStrength: number,
    depth: number,
    slices = 24,
  ) {
    this.slices = slices;
    this.luts = [];
    this.pigments = [];
    this.nominal = new Float32Array(slices);
    this.alphas = new Float32Array(slices);
    const c: RGB = [0, 0, 0];
    let maxNominal = 0;
    let sum = 0;
    for (let i = 0; i < slices; i++) {
      const t = slices === 1 ? 0 : i / (slices - 1);
      const alpha = sampleStops(stops, t, c);
      // Blend the stop towards the paper by its own alpha first, so a partly
      // transparent stop asks for a lighter wash rather than a thinner one
      // that then gets faded twice.
      const target: RGB = [
        c[0] * alpha + paper[0] * (1 - alpha),
        c[1] * alpha + paper[1] * (1 - alpha),
        c[2] * alpha + paper[2] * (1 - alpha),
      ];
      const solved = solvePigment(target, paper, depth, scattering, bodyStrength);
      this.pigments.push(solved.pigment);
      this.nominal[i] = solved.thickness;
      this.alphas[i] = 1;
      sum += solved.thickness;
      if (solved.thickness > maxNominal) maxNominal = solved.thickness;
    }
    this.meanNominal = sum / Math.max(1, slices);
    const maxThickness = Math.max(0.25, maxNominal * 7);
    for (let i = 0; i < slices; i++) {
      this.luts.push(new PigmentLut(this.pigments[i], paper, maxThickness, 512));
    }
  }

  /** Nominal thickness at a point along the ramp. */
  nominalAt(t: number): number {
    const f = clamp01(t) * (this.slices - 1);
    const i0 = f | 0;
    const i1 = i0 + 1 < this.slices ? i0 + 1 : i0;
    return this.nominal[i0] + (this.nominal[i1] - this.nominal[i0]) * (f - i0);
  }

  /** Composite over the fixed paper backdrop the tables were built against. */
  sample(t: number, thickness: number, out: RGB): number {
    const f = clamp01(t) * (this.slices - 1);
    const i0 = f | 0;
    const i1 = i0 + 1 < this.slices ? i0 + 1 : i0;
    const fr = f - i0;
    const a = this.tmpA;
    const b = this.tmpB;
    this.luts[i0].sample(thickness, a);
    this.luts[i1].sample(thickness, b);
    out[0] = a[0] + (b[0] - a[0]) * fr;
    out[1] = a[1] + (b[1] - a[1]) * fr;
    out[2] = a[2] + (b[2] - a[2]) * fr;
    return this.alphas[i0] + (this.alphas[i1] - this.alphas[i0]) * fr;
  }

  /**
   * Composite over an arbitrary backdrop, evaluating Kubelka-Munk directly.
   * Needed once a second shape is laid over the first, where the backdrop is
   * whatever the earlier wash left behind rather than bare paper.
   */
  compositeOver(t: number, thickness: number, backdrop: RGB, out: RGB): number {
    const f = clamp01(t) * (this.slices - 1);
    const i0 = f | 0;
    const i1 = i0 + 1 < this.slices ? i0 + 1 : i0;
    const fr = f - i0;
    const a = this.tmpA;
    const b = this.tmpB;
    compositePigment(this.pigments[i0], thickness, backdrop, a);
    if (i1 !== i0) {
      compositePigment(this.pigments[i1], thickness, backdrop, b);
      out[0] = a[0] + (b[0] - a[0]) * fr;
      out[1] = a[1] + (b[1] - a[1]) * fr;
      out[2] = a[2] + (b[2] - a[2]) * fr;
    } else {
      out[0] = a[0];
      out[1] = a[1];
      out[2] = a[2];
    }
    return this.alphas[i0] + (this.alphas[i1] - this.alphas[i0]) * fr;
  }

  /**
   * Straight-alpha coverage for a layer of this thickness.
   *
   * A pigment transmits differently in each channel - that is what makes it
   * coloured - and one alpha cannot express three transmittances, so some
   * approximation is forced. The choice here is the one that makes the case
   * people actually hit exact.
   *
   * A layer's *gain* on the backdrop is T^2/(1-R): how much of what is behind
   * it survives. Taking `1 - alpha` to be the smallest gain across the three
   * channels guarantees that recovering the straight colour as
   * `(composite - (1 - alpha)) / alpha` never goes negative, so nothing
   * clips, and compositing the result back over the paper reproduces the
   * opaque render exactly in every channel. Over a much darker backdrop the
   * wash reads lighter than physics says it should - the transparency is
   * carried as one number instead of a spectrum - which degrades in the
   * direction of looking like a cut-out rather than like a colour filter.
   */
  hiding(t: number, thickness: number): number {
    const i0 = Math.min(this.slices - 1, Math.round(clamp01(t) * (this.slices - 1)));
    const p = this.pigments[i0];
    let minGain = 1;
    for (let ch = 0; ch < 3; ch++) {
      const [R, T] = layerRT(p.K[ch], p.S[ch], thickness);
      const gain = clamp01((T * T) / Math.max(1e-4, 1 - R));
      if (gain < minGain) minGain = gain;
    }
    return clamp01(1 - minGain);
  }
}

export function sampleProfile(prof: Float32Array, t: number): number {
  const f = clamp01(t) * (prof.length - 1);
  const i0 = f | 0;
  const i1 = Math.min(prof.length - 1, i0 + 1);
  return prof[i0] + (prof[i1] - prof[i0]) * (f - i0);
}

/** Mean colour of a stop list, used when a gradient needs one flat pigment. */
export function meanStopColor(stops: ResolvedStop[]): RGB {
  const c: RGB = [0, 0, 0];
  const acc: RGB = [0, 0, 0];
  const N = 16;
  for (let i = 0; i < N; i++) {
    sampleStops(stops, i / (N - 1), c);
    acc[0] += c[0];
    acc[1] += c[1];
    acc[2] += c[2];
  }
  return [acc[0] / N, acc[1] / N, acc[2] / N];
}

/** Convenience: a CSS colour string for a linear-light triple. */
export function linearToCss(rgb: RGB): string {
  const b = (v: number) => Math.round(clamp01(linearToSrgb(v)) * 255);
  return `rgb(${b(rgb[0])}, ${b(rgb[1])}, ${b(rgb[2])})`;
}

/** Convenience: parse a CSS colour straight to linear light. */
export function cssToLinear(css: string): { rgb: RGB; alpha: number } {
  const c = parseColor(css);
  return { rgb: [srgbToLinear(c.rgb[0]), srgbToLinear(c.rgb[1]), srgbToLinear(c.rgb[2])], alpha: c.alpha };
}
