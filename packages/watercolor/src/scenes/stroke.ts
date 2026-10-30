/**
 * Geometry for drawn scenes.
 *
 * A scene is made of strokes - a centreline with a width along it - and the
 * renderer paints filled outlines, so the job here is turning one into the
 * other, plus the small set of curve and easing helpers a growing thing needs.
 *
 * Every outline is built the same way round (one side out, the tip, the
 * other side back), so any number of strokes can be joined into one path
 * under the nonzero rule without their windings cancelling where they cross.
 */

export interface Pt {
  x: number;
  y: number;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Hermite step between two edges. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Perlin's quintic step: zero second derivative at both ends, which is what growth looks like. */
export function smootherstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Fast start, long settle: how a root tip advances. */
export function easeOut(x: number, power = 2.2): number {
  return 1 - Math.pow(1 - clamp01(x), power);
}

/** Inverse of `easeOut`: how far through its growth a stroke is when it reaches fraction `s`. */
export function easeOutInverse(s: number, power = 2.2): number {
  return 1 - Math.pow(1 - clamp01(s), 1 / power);
}

/** Mix two hex colours in sRGB. Good enough for a palette; the renderer does the real mixing. */
export function mixColor(a: string, b: string, t: number): string {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  const k = clamp01(t);
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * k));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

/** Path numbers to two decimals, which is finer than any render resolves. */
export function fmt(v: number): string {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
}

/** A closed polygon as path data. */
export function polygonPath(points: Pt[]): string {
  if (points.length < 3) return '';
  let d = `M${fmt(points[0].x)} ${fmt(points[0].y)}`;
  for (let i = 1; i < points.length; i++) d += `L${fmt(points[i].x)} ${fmt(points[i].y)}`;
  return d + 'Z';
}

export interface StrokeOptions {
  /** Round the start off with a half-disc; otherwise it is cut square. */
  roundStart?: boolean;
}

/**
 * Outline a stroke.
 *
 * `left` and `right` are half-widths at each point, on either side of the
 * direction of travel. The end is carried on by its own half-width so a blunt
 * stroke ends in a curve rather than a flat; a width that falls to zero ends
 * in a point.
 */
export function strokePath(
  pts: Pt[],
  left: number[],
  right: number[] = left,
  opts: StrokeOptions = {},
): string | null {
  const n = pts.length;
  if (n < 2) return null;
  const tan: Pt[] = new Array(n);
  const L: Pt[] = new Array(n);
  const R: Pt[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) {
      dx = 0;
      dy = 1;
    } else {
      dx /= len;
      dy /= len;
    }
    tan[i] = { x: dx, y: dy };
    const nx = -dy;
    const ny = dx;
    const wl = Math.max(0, left[i]);
    const wr = Math.max(0, right[i]);
    L[i] = { x: pts[i].x + nx * wl, y: pts[i].y + ny * wl };
    R[i] = { x: pts[i].x - nx * wr, y: pts[i].y - ny * wr };
  }

  let d = `M${fmt(L[0].x)} ${fmt(L[0].y)}`;
  for (let i = 1; i < n; i++) d += `L${fmt(L[i].x)} ${fmt(L[i].y)}`;
  const endW = (Math.max(0, left[n - 1]) + Math.max(0, right[n - 1])) / 2;
  if (endW > 0.05) {
    const t = tan[n - 1];
    const e = pts[n - 1];
    d += `L${fmt(e.x + t.x * endW * 0.9)} ${fmt(e.y + t.y * endW * 0.9)}`;
  }
  for (let i = n - 1; i >= 0; i--) d += `L${fmt(R[i].x)} ${fmt(R[i].y)}`;
  if (opts.roundStart !== false) {
    const w = (Math.max(0, left[0]) + Math.max(0, right[0])) / 2;
    if (w > 0.2) {
      // From the right side round the back to the left side, where the path began.
      const t = tan[0];
      const nx = -t.y;
      const ny = t.x;
      const c = pts[0];
      for (let k = 1; k < 6; k++) {
        const ang = (Math.PI * k) / 6;
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        d += `L${fmt(c.x + (-nx * ca - t.x * sa) * w)} ${fmt(c.y + (-ny * ca - t.y * sa) * w)}`;
      }
    }
  }
  return d + 'Z';
}

/** Sample a cubic Bezier into `n` segments. */
export function cubicBezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, n: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push({
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    });
  }
  return out;
}

/** Cumulative arc length at each point. */
export function arcLengths(pts: Pt[]): number[] {
  const out = new Array<number>(pts.length);
  let acc = 0;
  out[0] = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    out[i] = acc;
  }
  return out;
}

/** The point and unit tangent at a distance along a polyline. */
export function pointAlong(pts: Pt[], lens: number[], dist: number): { p: Pt; dir: Pt } {
  const total = lens[lens.length - 1];
  const d = Math.max(0, Math.min(total, dist));
  let i = 1;
  while (i < lens.length - 1 && lens[i] < d) i++;
  const a = pts[i - 1];
  const b = pts[i];
  const span = lens[i] - lens[i - 1];
  const f = span > 1e-9 ? (d - lens[i - 1]) / span : 0;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    p: { x: a.x + dx * f, y: a.y + dy * f },
    dir: { x: dx / len, y: dy / len },
  };
}

/** The leading part of a polyline up to a distance, ending exactly there. */
export function cutPolyline(pts: Pt[], lens: number[], dist: number): Pt[] {
  const total = lens[lens.length - 1];
  if (dist >= total) return pts.slice();
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (lens[i] <= dist) {
      out.push(pts[i]);
      continue;
    }
    out.push(pointAlong(pts, lens, dist).p);
    break;
  }
  return out;
}

/**
 * Bend the last part of a polyline over on itself, as a shoot tip curls.
 *
 * `fraction` of the length is bent; the turn grows with the square of the
 * distance into it, so the bend starts gently and curls hardest at the tip.
 */
export function bendTip(pts: Pt[], fraction: number, angle: number): Pt[] {
  if (pts.length < 3 || Math.abs(angle) < 1e-6) return pts;
  const lens = arcLengths(pts);
  const total = lens[lens.length - 1];
  const from = total * (1 - fraction);
  let k0 = 1;
  while (k0 < pts.length && lens[k0] < from) k0++;
  if (k0 >= pts.length) return pts;
  const span = Math.max(1e-6, total - lens[k0 - 1]);
  const out = pts.slice();
  let prev = pts[k0 - 1];
  for (let i = k0; i < pts.length; i++) {
    const u = (lens[i] - lens[k0 - 1]) / span;
    const rot = angle * u * u;
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const next = { x: prev.x + dx * c - dy * s, y: prev.y + dx * s + dy * c };
    out[i] = next;
    prev = next;
  }
  return out;
}

/**
 * An egg outline. `egg` narrows one end: positive makes the -y end (the top,
 * before rotation) the pointed one.
 */
export function ovoid(cx: number, cy: number, rx: number, ry: number, rotation: number, egg = 0.2): Pt[] {
  const out: Pt[] = [];
  const N = 36;
  const cr = Math.cos(rotation);
  const sr = Math.sin(rotation);
  for (let i = 0; i < N; i++) {
    const phi = (i / N) * Math.PI * 2;
    const x = rx * Math.cos(phi) * (1 + egg * Math.sin(phi));
    const y = ry * Math.sin(phi);
    out.push({ x: cx + x * cr - y * sr, y: cy + x * sr + y * cr });
  }
  return out;
}
