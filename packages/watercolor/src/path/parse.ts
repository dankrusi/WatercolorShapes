/**
 * SVG path data parser and flattener.
 *
 * Produces polygons in user space. Curves are flattened adaptively so that the
 * chord error stays below `tolerance` device pixels, which keeps the silhouette
 * crisp even when the shape is rendered at 4x supersampling.
 */

export type Point = { x: number; y: number };
/** A closed contour, as a flat [x0,y0,x1,y1,...] array. */
export type Contour = number[];

export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

export function applyMatrix(m: Matrix, x: number, y: number, out: Point): Point {
  out.x = m.a * x + m.c * y + m.e;
  out.y = m.b * x + m.d * y + m.f;
  return out;
}

/** Parse an SVG `transform` attribute into a single matrix. */
export function parseTransform(str: string | null | undefined): Matrix {
  if (!str) return { ...IDENTITY };
  let m: Matrix = { ...IDENTITY };
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(str)) !== null) {
    const name = match[1];
    const args = match[2]
      .split(/[\s,]+/)
      .filter((s) => s.length)
      .map(Number);
    let t: Matrix = { ...IDENTITY };
    switch (name) {
      case 'matrix':
        if (args.length >= 6) t = { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] };
        break;
      case 'translate':
        t = { ...IDENTITY, e: args[0] || 0, f: args[1] || 0 };
        break;
      case 'scale': {
        const sx = args[0] ?? 1;
        const sy = args[1] ?? sx;
        t = { ...IDENTITY, a: sx, d: sy };
        break;
      }
      case 'rotate': {
        const ang = ((args[0] || 0) * Math.PI) / 180;
        const cos = Math.cos(ang);
        const sin = Math.sin(ang);
        const r: Matrix = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
        if (args.length >= 3) {
          const cx = args[1];
          const cy = args[2];
          t = multiply({ ...IDENTITY, e: cx, f: cy }, multiply(r, { ...IDENTITY, e: -cx, f: -cy }));
        } else {
          t = r;
        }
        break;
      }
      case 'skewX':
        t = { ...IDENTITY, c: Math.tan(((args[0] || 0) * Math.PI) / 180) };
        break;
      case 'skewY':
        t = { ...IDENTITY, b: Math.tan(((args[0] || 0) * Math.PI) / 180) };
        break;
    }
    m = multiply(m, t);
  }
  return m;
}

type Cmd = { op: string; args: number[] };

const NUM_RE = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;

function tokenize(d: string): Cmd[] {
  const cmds: Cmd[] = [];
  const re = /([MmZzLlHhVvCcSsQqTtAa])([^MmZzLlHhVvCcSsQqTtAa]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    const op = m[1];
    const body = m[2];
    const args: number[] = [];
    if (op === 'A' || op === 'a') {
      // Arc flags may be written unseparated ("a5 5 0 0130 30"), so parse
      // positionally rather than with a plain number scan.
      let i = 0;
      const s = body;
      const readNum = (): number | null => {
        while (i < s.length && /[\s,]/.test(s[i])) i++;
        const start = i;
        if (i < s.length && (s[i] === '+' || s[i] === '-')) i++;
        while (i < s.length && /\d/.test(s[i])) i++;
        if (i < s.length && s[i] === '.') {
          i++;
          while (i < s.length && /\d/.test(s[i])) i++;
        }
        if (i < s.length && (s[i] === 'e' || s[i] === 'E')) {
          i++;
          if (i < s.length && (s[i] === '+' || s[i] === '-')) i++;
          while (i < s.length && /\d/.test(s[i])) i++;
        }
        if (i === start) return null;
        return parseFloat(s.slice(start, i));
      };
      const readFlag = (): number | null => {
        while (i < s.length && /[\s,]/.test(s[i])) i++;
        if (i >= s.length) return null;
        const ch = s[i];
        if (ch === '0' || ch === '1') {
          i++;
          return ch === '1' ? 1 : 0;
        }
        return readNum();
      };
      for (;;) {
        const rx = readNum();
        if (rx === null) break;
        const ry = readNum();
        const rot = readNum();
        const laf = readFlag();
        const sf = readFlag();
        const x = readNum();
        const y = readNum();
        if (ry === null || rot === null || laf === null || sf === null || x === null || y === null) break;
        args.push(rx, ry, rot, laf, sf, x, y);
      }
    } else {
      NUM_RE.lastIndex = 0;
      let nm: RegExpExecArray | null;
      while ((nm = NUM_RE.exec(body)) !== null) args.push(parseFloat(nm[0]));
    }
    cmds.push({ op, args });
  }
  return cmds;
}

const ARG_COUNT: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};

type Emit = (x: number, y: number) => void;

/**
 * Flatten an SVG path `d` string into closed polygons.
 *
 * Open sub-paths are implicitly closed: a watercolour wash is a filled region,
 * so an unclosed contour is treated the way a fill would treat it.
 */
export function flattenPath(d: string, transform: Matrix = IDENTITY, tolerance = 0.1): Contour[] {
  const cmds = tokenize(d);
  const contours: Contour[] = [];
  let cur: Contour | null = null;
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let prevCtrlX = 0;
  let prevCtrlY = 0;
  let prevOp = '';
  const pt: Point = { x: 0, y: 0 };

  // Estimate the user-to-device scale so the flattening tolerance is expressed
  // in output pixels regardless of the incoming coordinate system.
  const scale = Math.sqrt(Math.abs(transform.a * transform.d - transform.b * transform.c)) || 1;
  const tol = Math.max(1e-4, tolerance / scale);

  const push = (x: number, y: number) => {
    if (!cur) return;
    applyMatrix(transform, x, y, pt);
    const n = cur.length;
    if (n >= 2 && Math.abs(cur[n - 2] - pt.x) < 1e-9 && Math.abs(cur[n - 1] - pt.y) < 1e-9) return;
    cur.push(pt.x, pt.y);
  };

  const endContour = () => {
    if (cur && cur.length < 6) contours.pop();
    cur = null;
  };

  const beginContour = (x: number, y: number) => {
    endContour();
    cur = [];
    contours.push(cur);
    push(x, y);
    startX = x;
    startY = y;
  };

  for (const cmd of cmds) {
    const rel = cmd.op >= 'a';
    const op = cmd.op.toUpperCase();
    const n = ARG_COUNT[op];
    const a = cmd.args;
    if (op === 'Z') {
      if (cur) {
        push(startX, startY);
        endContour();
      }
      cx = startX;
      cy = startY;
      prevOp = op;
      continue;
    }
    const groups = n > 0 ? Math.max(1, Math.floor(a.length / n)) : 1;
    for (let g = 0; g < groups; g++) {
      const p = a.slice(g * n, g * n + n);
      if (p.length < n) break;
      switch (op) {
        case 'M': {
          const x = rel ? cx + p[0] : p[0];
          const y = rel ? cy + p[1] : p[1];
          // Coordinate pairs after the first behave as implicit line-tos.
          if (g === 0) beginContour(x, y);
          else push(x, y);
          cx = x;
          cy = y;
          break;
        }
        case 'L': {
          const x = rel ? cx + p[0] : p[0];
          const y = rel ? cy + p[1] : p[1];
          if (!cur) beginContour(cx, cy);
          push(x, y);
          cx = x;
          cy = y;
          break;
        }
        case 'H': {
          const x = rel ? cx + p[0] : p[0];
          if (!cur) beginContour(cx, cy);
          push(x, cy);
          cx = x;
          break;
        }
        case 'V': {
          const y = rel ? cy + p[0] : p[0];
          if (!cur) beginContour(cx, cy);
          push(cx, y);
          cy = y;
          break;
        }
        case 'C':
        case 'S': {
          let x1: number, y1: number, x2: number, y2: number, x: number, y: number;
          if (op === 'C') {
            x1 = rel ? cx + p[0] : p[0];
            y1 = rel ? cy + p[1] : p[1];
            x2 = rel ? cx + p[2] : p[2];
            y2 = rel ? cy + p[3] : p[3];
            x = rel ? cx + p[4] : p[4];
            y = rel ? cy + p[5] : p[5];
          } else {
            const smooth = prevOp === 'C' || prevOp === 'S';
            x1 = smooth ? 2 * cx - prevCtrlX : cx;
            y1 = smooth ? 2 * cy - prevCtrlY : cy;
            x2 = rel ? cx + p[0] : p[0];
            y2 = rel ? cy + p[1] : p[1];
            x = rel ? cx + p[2] : p[2];
            y = rel ? cy + p[3] : p[3];
          }
          if (!cur) beginContour(cx, cy);
          flattenCubic(cx, cy, x1, y1, x2, y2, x, y, tol, push);
          prevCtrlX = x2;
          prevCtrlY = y2;
          cx = x;
          cy = y;
          break;
        }
        case 'Q':
        case 'T': {
          let qx: number, qy: number, x: number, y: number;
          if (op === 'Q') {
            qx = rel ? cx + p[0] : p[0];
            qy = rel ? cy + p[1] : p[1];
            x = rel ? cx + p[2] : p[2];
            y = rel ? cy + p[3] : p[3];
          } else {
            const smooth = prevOp === 'Q' || prevOp === 'T';
            qx = smooth ? 2 * cx - prevCtrlX : cx;
            qy = smooth ? 2 * cy - prevCtrlY : cy;
            x = rel ? cx + p[0] : p[0];
            y = rel ? cy + p[1] : p[1];
          }
          if (!cur) beginContour(cx, cy);
          // Degree-elevate to a cubic and reuse the same subdivision routine.
          flattenCubic(
            cx,
            cy,
            cx + (2 / 3) * (qx - cx),
            cy + (2 / 3) * (qy - cy),
            x + (2 / 3) * (qx - x),
            y + (2 / 3) * (qy - y),
            x,
            y,
            tol,
            push,
          );
          prevCtrlX = qx;
          prevCtrlY = qy;
          cx = x;
          cy = y;
          break;
        }
        case 'A': {
          const x = rel ? cx + p[5] : p[5];
          const y = rel ? cy + p[6] : p[6];
          if (!cur) beginContour(cx, cy);
          flattenArc(cx, cy, p[0], p[1], p[2], p[3] !== 0, p[4] !== 0, x, y, tol, push);
          cx = x;
          cy = y;
          break;
        }
      }
      prevOp = op;
    }
  }
  endContour();
  // Guarantee explicit closure on every contour.
  for (const c of contours) {
    const n = c.length;
    if (n >= 6 && (Math.abs(c[0] - c[n - 2]) > 1e-9 || Math.abs(c[1] - c[n - 1]) > 1e-9)) {
      c.push(c[0], c[1]);
    }
  }
  return contours.filter((c) => c.length >= 6);
}

/** Recursive cubic subdivision using the standard flatness test. */
function flattenCubic(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  tol: number,
  emit: Emit,
  depth = 0,
): void {
  if (depth > 18) {
    emit(x3, y3);
    return;
  }
  const dx = x3 - x0;
  const dy = y3 - y0;
  const d1 = Math.abs((x1 - x3) * dy - (y1 - y3) * dx);
  const d2 = Math.abs((x2 - x3) * dy - (y2 - y3) * dx);
  const dd = (d1 + d2) * (d1 + d2);
  if (dd < tol * (dx * dx + dy * dy)) {
    emit(x3, y3);
    return;
  }
  const x01 = (x0 + x1) / 2,
    y01 = (y0 + y1) / 2;
  const x12 = (x1 + x2) / 2,
    y12 = (y1 + y2) / 2;
  const x23 = (x2 + x3) / 2,
    y23 = (y2 + y3) / 2;
  const x012 = (x01 + x12) / 2,
    y012 = (y01 + y12) / 2;
  const x123 = (x12 + x23) / 2,
    y123 = (y12 + y23) / 2;
  const xm = (x012 + x123) / 2,
    ym = (y012 + y123) / 2;
  flattenCubic(x0, y0, x01, y01, x012, y012, xm, ym, tol, emit, depth + 1);
  flattenCubic(xm, ym, x123, y123, x23, y23, x3, y3, tol, emit, depth + 1);
}

/** Endpoint-parameterised elliptical arc to polyline (SVG spec F.6.5). */
function flattenArc(
  x0: number,
  y0: number,
  rx: number,
  ry: number,
  rotDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x1: number,
  y1: number,
  tol: number,
  emit: Emit,
): void {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx < 1e-12 || ry < 1e-12 || (x0 === x1 && y0 === y1)) {
    emit(x1, y1);
    return;
  }
  const phi = (rotDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx2 = (x0 - x1) / 2;
  const dy2 = (y0 - y1) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;
  // Scale up radii that are too small to span the endpoints.
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    const s = Math.sqrt(lam);
    rx *= s;
    ry *= s;
  }
  const sign = largeArc !== sweep ? 1 : -1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x0 + x1) / 2;
  const cy = sinP * cxp + cosP * cyp + (y0 + y1) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / (len || 1e-12))));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = ang(1, 0, ux, uy);
  let dTheta = ang(ux, uy, vx, vy);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  else if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const rmax = Math.max(rx, ry);
  // Segment count from the sagitta bound: error is about r * theta^2 / 8.
  const steps = Math.max(
    2,
    Math.ceil(Math.abs(dTheta) / (2 * Math.sqrt(Math.max(1e-9, (2 * tol) / rmax)))),
  );
  for (let i = 1; i <= steps; i++) {
    const t = theta1 + (dTheta * i) / steps;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    emit(cx + rx * ct * cosP - ry * st * sinP, cy + rx * ct * sinP + ry * st * cosP);
  }
}

/** Axis-aligned bounds of a set of contours. */
export function contourBounds(contours: Contour[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const c of contours) {
    for (let i = 0; i < c.length; i += 2) {
      if (c[i] < minX) minX = c[i];
      if (c[i] > maxX) maxX = c[i];
      if (c[i + 1] < minY) minY = c[i + 1];
      if (c[i + 1] > maxY) maxY = c[i + 1];
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
