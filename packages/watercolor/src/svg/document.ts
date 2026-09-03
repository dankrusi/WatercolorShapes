/**
 * Minimal SVG document reader.
 *
 * Deliberately not built on DOMParser: the same code then runs in Node for the
 * reference-comparison harness and in the browser for the demo, and there is
 * no risk of the two disagreeing about what a file contains. It understands
 * the subset a shape-oriented tool actually meets - the basic shapes, groups,
 * transforms, fills and gradients - and ignores the rest.
 */

import { multiply, parseTransform, IDENTITY, type Matrix } from '../path/parse.js';
import type { GradientFill, GradientStop, ShapeInput } from '../types.js';

interface Tag {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  closing: boolean;
}

const TAG_RE = /<\s*(\/?)\s*([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)\s*>/g;
const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function scanTags(src: string): Tag[] {
  const out: Tag[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(src)) !== null) {
    const attrs: Record<string, string> = {};
    ATTR_RE.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = ATTR_RE.exec(m[3])) !== null) {
      attrs[am[1]] = decodeEntities(am[2] ?? am[3] ?? '');
    }
    out.push({
      name: m[2].replace(/^.*:/, '').toLowerCase(),
      attrs,
      selfClosing: m[4] === '/',
      closing: m[1] === '/',
    });
  }
  return out;
}

/** Merge presentation attributes with any inline `style` declaration. */
function styleOf(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...attrs };
  const style = attrs['style'];
  if (style) {
    for (const decl of style.split(';')) {
      const idx = decl.indexOf(':');
      if (idx < 0) continue;
      const k = decl.slice(0, idx).trim().toLowerCase();
      const v = decl.slice(idx + 1).trim();
      if (k) out[k] = v;
    }
  }
  return out;
}

function num(v: string | undefined, fallback = 0): number {
  if (v === undefined) return fallback;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : fallback;
}

/** Convert a basic shape element to path data. */
function shapeToPath(name: string, a: Record<string, string>): string | null {
  switch (name) {
    case 'path':
      return a['d'] ?? null;
    case 'rect': {
      const x = num(a['x']);
      const y = num(a['y']);
      const w = num(a['width']);
      const h = num(a['height']);
      if (w <= 0 || h <= 0) return null;
      let rx = a['rx'] !== undefined ? num(a['rx']) : a['ry'] !== undefined ? num(a['ry']) : 0;
      let ry = a['ry'] !== undefined ? num(a['ry']) : rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (rx <= 0 || ry <= 0) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return (
        `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}` +
        `V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}` +
        `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
        `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
      );
    }
    case 'circle': {
      const cx = num(a['cx']);
      const cy = num(a['cy']);
      const r = num(a['r']);
      if (r <= 0) return null;
      return `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`;
    }
    case 'ellipse': {
      const cx = num(a['cx']);
      const cy = num(a['cy']);
      const rx = num(a['rx']);
      const ry = num(a['ry']);
      if (rx <= 0 || ry <= 0) return null;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case 'polygon':
    case 'polyline': {
      const pts = (a['points'] ?? '').trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
      if (pts.length < 6) return null;
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      return d + 'Z';
    }
    default:
      return null;
  }
}

function parseGradient(tag: Tag, stops: GradientStop[]): GradientFill | null {
  const a = tag.attrs;
  const units = (a['gradientUnits'] === 'userSpaceOnUse' ? 'userSpaceOnUse' : 'objectBoundingBox') as
    | 'userSpaceOnUse'
    | 'objectBoundingBox';
  const def = units === 'objectBoundingBox';
  if (tag.name === 'lineargradient') {
    return {
      type: 'linear',
      x1: a['x1'] !== undefined ? num(a['x1']) : def ? 0 : 0,
      y1: a['y1'] !== undefined ? num(a['y1']) : 0,
      x2: a['x2'] !== undefined ? num(a['x2']) : def ? 1 : 0,
      y2: a['y2'] !== undefined ? num(a['y2']) : 0,
      stops,
      units,
      transform: a['gradientTransform'],
    };
  }
  if (tag.name === 'radialgradient') {
    return {
      type: 'radial',
      cx: a['cx'] !== undefined ? num(a['cx']) : def ? 0.5 : 0,
      cy: a['cy'] !== undefined ? num(a['cy']) : def ? 0.5 : 0,
      r: a['r'] !== undefined ? num(a['r']) : def ? 0.5 : 0,
      fx: a['fx'] !== undefined ? num(a['fx']) : undefined,
      fy: a['fy'] !== undefined ? num(a['fy']) : undefined,
      stops,
      units,
      transform: a['gradientTransform'],
    };
  }
  return null;
}

export interface ParsedSvg {
  shapes: ShapeInput[];
  viewBox: { x: number; y: number; width: number; height: number } | null;
  width: number | null;
  height: number | null;
}

/**
 * Extract every filled shape from an SVG source string, in document order.
 */
export function parseSvg(src: string): ParsedSvg {
  const tags = scanTags(src);
  const gradients = new Map<string, GradientFill>();
  const gradientHrefs = new Map<string, string>();
  const shapes: ShapeInput[] = [];

  // Transform and inherited-style stack.
  const stack: { m: Matrix; style: Record<string, string> }[] = [{ m: { ...IDENTITY }, style: {} }];
  let viewBox: ParsedSvg['viewBox'] = null;
  let svgW: number | null = null;
  let svgH: number | null = null;

  // Gradient collection state.
  let curGradient: Tag | null = null;
  let curStops: GradientStop[] = [];

  for (const tag of tags) {
    const a = tag.attrs;

    if (tag.name === 'lineargradient' || tag.name === 'radialgradient') {
      if (tag.closing) {
        if (curGradient) {
          const id = curGradient.attrs['id'];
          const gr = parseGradient(curGradient, curStops);
          if (id && gr) gradients.set(id, gr);
          curGradient = null;
          curStops = [];
        }
        continue;
      }
      const href = a['href'] ?? a['xlink:href'];
      if (href && href.startsWith('#') && a['id']) gradientHrefs.set(a['id'], href.slice(1));
      if (tag.selfClosing) {
        const id = a['id'];
        const gr = parseGradient(tag, []);
        if (id && gr) gradients.set(id, gr);
      } else {
        curGradient = tag;
        curStops = [];
      }
      continue;
    }

    if (tag.name === 'stop' && curGradient && !tag.closing) {
      const st = styleOf(a);
      const off = st['offset'] ?? '0';
      curStops.push({
        offset: off.endsWith('%') ? parseFloat(off) / 100 : num(off),
        color: st['stop-color'] ?? '#000',
        opacity: st['stop-opacity'] !== undefined ? num(st['stop-opacity'], 1) : 1,
      });
      continue;
    }

    if (tag.name === 'svg' && !tag.closing) {
      const vb = a['viewBox'];
      if (vb) {
        const p = vb.trim().split(/[\s,]+/).map(Number);
        if (p.length >= 4 && p.every(Number.isFinite)) {
          viewBox = { x: p[0], y: p[1], width: p[2], height: p[3] };
        }
      }
      if (a['width']) svgW = num(a['width']);
      if (a['height']) svgH = num(a['height']);
      continue;
    }

    if (tag.name === 'g' || tag.name === 'a') {
      if (tag.closing) {
        if (stack.length > 1) stack.pop();
      } else if (!tag.selfClosing) {
        const top = stack[stack.length - 1];
        const st = styleOf(a);
        stack.push({
          m: multiply(top.m, parseTransform(a['transform'])),
          style: { ...top.style, ...pickInherited(st) },
        });
      }
      continue;
    }

    if (tag.closing) continue;

    const d = shapeToPath(tag.name, a);
    if (!d) continue;

    const top = stack[stack.length - 1];
    const st = { ...top.style, ...styleOf(a) };
    const fill = st['fill'];
    if (fill === 'none') continue;

    const m = multiply(top.m, parseTransform(a['transform']));
    const opacity = num(st['opacity'], 1) * num(st['fill-opacity'], 1);
    if (opacity <= 0.001) continue;

    const urlMatch = fill ? /^url\(\s*['"]?#([^)'"]+)['"]?\s*\)/.exec(fill) : null;
    let gradient: GradientFill | undefined;
    if (urlMatch) {
      gradient = resolveGradient(urlMatch[1], gradients, gradientHrefs);
      if (!gradient) continue;
    }

    shapes.push({
      path: d,
      color: gradient ? undefined : (fill ?? '#000000'),
      gradient,
      fillRule: st['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero',
      transform: matrixToString(m),
      opacity,
    });
  }

  return { shapes, viewBox, width: svgW, height: svgH };
}

/** Follow `href` chains so a gradient can inherit another's stops. */
function resolveGradient(
  id: string,
  gradients: Map<string, GradientFill>,
  hrefs: Map<string, string>,
): GradientFill | undefined {
  const seen = new Set<string>();
  let cur = id;
  let base: GradientFill | undefined;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const g = gradients.get(cur);
    if (g) {
      if (!base) base = { ...g };
      else if (base.stops.length === 0 && g.stops.length > 0) base = { ...base, stops: g.stops };
      if (base.stops.length > 0) break;
    }
    cur = hrefs.get(cur) ?? '';
  }
  return base && base.stops.length > 0 ? base : base;
}

const INHERITED = ['fill', 'fill-opacity', 'fill-rule', 'opacity'];

function pickInherited(style: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of INHERITED) if (style[k] !== undefined) out[k] = style[k];
  return out;
}

export function matrixToString(m: Matrix): string {
  return `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`;
}
