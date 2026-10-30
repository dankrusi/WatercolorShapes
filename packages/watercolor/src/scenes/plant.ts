/**
 * Scene: a seedling, from seed to its third leaf.
 *
 * Ten seconds. A seed swells, puts a pale root down and a hooked shoot up,
 * rides the shoot a little way and is shed; the shoot straightens and
 * thickens into a stem while the taproot branches and branches again; a bud
 * at the tip opens into the first leaf, then two more open lower down; the
 * last second is a hold on the finished plant.
 *
 * Nothing is keyframed. Every organ is a stroke with a birth time, a growth
 * curve, a width that fills out with age, and a colour that runs pale at the
 * growing tip and deepens behind it - the way a root actually looks, white
 * at the end and brown where it is older. Roots branch where their parent
 * had already reached when they were born. The layout seed decides where the
 * branches go; the designed parts - the stem's lean, the three leaves - are
 * fixed, because they are drawn to a reference.
 *
 * Each organ is one shape with a stable seed and a pinned noise size, so the
 * renderer keeps its paint still while it grows. The leaves are one outline
 * each with the midrib and side veins cut out of them, which lets the paper
 * show through as the pale veins a painter leaves unpainted - and gives the
 * form shading a crease to pool pigment along.
 */

import { fbm } from '../noise.js';
import { normalizeSeed, Rng } from '../rng.js';
import type { LinearGradient, ShapeInput } from '../types.js';
import { resolveSceneOptions, type SceneOptionSpec, type SceneOptions } from './options.js';
import type { Scene } from './types.js';
import {
  arcLengths,
  bendTip,
  clamp01,
  cubicBezier,
  cutPolyline,
  easeOut,
  easeOutInverse,
  mix,
  mixColor,
  ovoid,
  pointAlong,
  polygonPath,
  smootherstep,
  smoothstep,
  strokePath,
  type Pt,
} from './stroke.js';

const VIEW = { x: 0, y: 0, width: 527, height: 790 };
/** Where the seed lies and the roots and stem meet. */
const CROWN: Pt = { x: 270, y: 478 };

// ---------------------------------------------------------------- palette --

const INK = {
  tip: '#ebe0d0',
  seedLight: '#9c6c40',
  seed: '#6e4526',
  seedDark: '#432816',
  stemDark: '#48433e',
  stemWarm: '#5e4c38',
  stemOchre: '#b57b36',
  stemLight: '#cb9650',
};

type Shade = 'charcoal' | 'ochre' | 'tan' | 'warmGrey';

const SHADE: Record<Shade, { deep: string; base: string }> = {
  charcoal: { deep: '#36332f', base: '#4b4742' },
  ochre: { deep: '#8d5a21', base: '#b57b36' },
  tan: { deep: '#a98457', base: '#c6a27a' },
  warmGrey: { deep: '#6d6155', base: '#8c7f71' },
};

// --------------------------------------------------------------- timeline --

/** Moments as fractions of the running time. */
const TL = {
  seedSwell: [0.0, 0.08] as const,
  seedLift: 0.1,
  seedFade: [0.21, 0.28] as const,
  stem: [0.1, 0.52] as const,
  hook: [0.19, 0.34] as const,
  rootsDone: 0.9,
};

// ---------------------------------------------------------------- options --

const OPTIONS: SceneOptionSpec[] = [
  { key: 'roots', label: 'Main roots', min: 2, max: 9, step: 1, default: 7, hint: 'How many roots leave the crown' },
  { key: 'branching', label: 'Branching', min: 0, max: 2, step: 0.05, default: 1, hint: 'How much the roots branch; 0 leaves only the main roots' },
  { key: 'rootSpread', label: 'Root spread', min: 0.4, max: 1.4, step: 0.05, default: 1, hint: 'How wide the roots fan out from the crown' },
  { key: 'rootDepth', label: 'Root depth', min: 0.5, max: 1.3, step: 0.05, default: 1, hint: 'How far the roots reach' },
  { key: 'stemHeight', label: 'Stem height', min: 0.6, max: 1.25, step: 0.05, default: 1 },
  { key: 'leaves', label: 'Leaves', min: 1, max: 3, step: 1, default: 3, hint: 'The apex leaf first, then the dark one, then the pale one' },
  { key: 'leafSize', label: 'Leaf size', min: 0.5, max: 1.4, step: 0.05, default: 1 },
  { key: 'veins', label: 'Veins', min: 0, max: 1.5, step: 0.05, default: 1, hint: 'Strength of the midrib and side veins; 0 for none' },
  {
    key: 'rootStability',
    label: 'Root stability',
    min: 0,
    max: 1,
    step: 0.05,
    default: 1,
    hint: '1 holds the roots still; lower lets them be redrawn a little differently each time the paint is, so they boil with it',
  },
];

// ------------------------------------------------------------------ roots --

interface Root {
  id: string;
  depth: number;
  pts: Pt[];
  len: number[];
  total: number;
  /** Full width at the base, in scene units. */
  width: number;
  shade: Shade;
  t0: number;
  t1: number;
}

interface PrimarySpec {
  /** Degrees from straight down; negative is left. */
  ang: number;
  len: number;
  width: number;
  shade: Shade;
  t0: number;
  /** How strongly the root turns back towards straight down as it goes. */
  pull: number;
  /** Where along the crown it starts, in units left or right of centre. */
  offset: number;
}

/**
 * The main roots, in the order they are kept as the `roots` option falls:
 * the radicle first - first out of the seed, and the one the others fan out
 * around - then the pair that frame it, then the rest.
 */
const PRIMARIES: PrimarySpec[] = [
  { ang: -4, len: 288, width: 11, shade: 'tan', t0: 0.04, pull: 0.2, offset: 0 },
  { ang: -38, len: 245, width: 10.5, shade: 'ochre', t0: 0.16, pull: 0.3, offset: -3 },
  { ang: 28, len: 235, width: 10, shade: 'charcoal', t0: 0.21, pull: 0.3, offset: 3 },
  { ang: -76, len: 180, width: 10, shade: 'charcoal', t0: 0.19, pull: 0.42, offset: -6 },
  { ang: 66, len: 180, width: 9.5, shade: 'ochre', t0: 0.25, pull: 0.42, offset: 6 },
  { ang: 12, len: 150, width: 7.5, shade: 'warmGrey', t0: 0.29, pull: 0.3, offset: 1 },
  { ang: -17, len: 200, width: 8, shade: 'charcoal', t0: 0.27, pull: 0.25, offset: -1 },
  { ang: 47, len: 170, width: 7.5, shade: 'tan', t0: 0.23, pull: 0.35, offset: 4 },
  { ang: -57, len: 165, width: 7, shade: 'ochre', t0: 0.26, pull: 0.4, offset: -4 },
];

/** Where the roots may go before they are cut off: inside the sheet, below the crown. */
const ROOT_BOUNDS = { minX: 60, maxX: 470, maxY: 768 };

/**
 * Integrate a root forward from a point: a heading that wanders with smooth
 * noise and keeps being pulled back towards straight down.
 */
function growCenterline(
  start: Pt,
  angDeg: number,
  length: number,
  pull: number,
  wiggle: number,
  noiseSeed: number,
  phase: number,
): Pt[] {
  const step = 3;
  const pts: Pt[] = [start];
  let th = (angDeg * Math.PI) / 180;
  let x = start.x;
  let y = start.y;
  const n = Math.max(2, Math.round(length / step));
  for (let i = 1; i <= n; i++) {
    const s = i * step;
    const drift = fbm(s * 0.016 + phase, phase * 0.37, noiseSeed, { octaves: 2, grad: true });
    th += drift * wiggle * 0.1;
    th += (0 - th) * pull * (step / 100);
    x += Math.sin(th) * step;
    y += Math.cos(th) * step;
    pts.push({ x, y });
  }
  return pts;
}

/** Keep the part of a centreline that stays on the sheet. */
function trimToBounds(pts: Pt[]): Pt[] {
  let n = pts.length;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < ROOT_BOUNDS.minX || p.x > ROOT_BOUNDS.maxX || p.y > ROOT_BOUNDS.maxY) {
      n = i;
      break;
    }
  }
  return pts.slice(0, Math.max(2, n));
}

/** Full width at a fraction of the full length: heavy at the base, fine at the end. */
function rootWidthAt(r: Root, s: number): number {
  return r.width * (0.26 + 0.74 * Math.pow(1 - clamp01(s), 1.5));
}

function makeRoot(
  id: string,
  depth: number,
  pts: Pt[],
  width: number,
  shade: Shade,
  t0: number,
  t1: number,
): Root {
  const len = arcLengths(pts);
  return { id, depth, pts, len, total: len[len.length - 1], width, shade, t0, t1 };
}

function pickShade(parent: Shade, depth: number, rng: Rng): Shade {
  const r = rng.next();
  if (depth === 1) {
    if (r < 0.55) return parent;
    if (r < 0.8) return 'tan';
    return parent === 'charcoal' ? 'ochre' : 'charcoal';
  }
  if (r < 0.5) return 'tan';
  if (r < 0.8) return parent;
  return 'warmGrey';
}

function addBranches(
  parent: Root,
  roots: Root[],
  rng: Rng,
  noiseSeed: number,
  branching: number,
): void {
  const depth = parent.depth + 1;
  if (depth > 2 || parent.total < 40) return;
  const base =
    depth === 1
      ? 3 + (parent.total > 160 ? 1 : 0) + (rng.next() < 0.5 ? 1 : 0)
      : 1 + (rng.next() < 0.6 ? 1 : 0) + (parent.total > 90 && rng.next() < 0.4 ? 1 : 0);
  const count = Math.round(base * branching);
  let side = rng.next() < 0.5 ? 1 : -1;
  for (let k = 0; k < count; k++) {
    const s = mix(0.2, 0.84, (k + 0.25 + rng.next() * 0.5) / count);
    const { p, dir } = pointAlong(parent.pts, parent.len, s * parent.total);
    const parentAng = (Math.atan2(dir.x, dir.y) * 180) / Math.PI;
    const spread = (26 + rng.next() * 26) * side;
    side = -side;
    const lenFactor =
      (depth === 1 ? mix(0.36, 0.6, rng.next()) : mix(0.3, 0.5, rng.next())) * (1 - 0.3 * s);
    const length = Math.max(18, parent.total * lenFactor);
    const width = rootWidthAt(parent, s) * (depth === 1 ? 0.72 : 0.7);
    const pts = trimToBounds(
      growCenterline(
        p,
        parentAng + spread,
        length,
        depth === 1 ? 0.4 : 0.3,
        depth === 1 ? 1.2 : 1.5,
        noiseSeed,
        rng.next() * 100,
      ),
    );
    const shade = pickShade(parent.shade, depth, rng);
    // Born a little after the parent's tip passed this point.
    const t0 = parent.t0 + (parent.t1 - parent.t0) * easeOutInverse(s) + 0.025;
    const t1 = Math.min(TL.rootsDone, t0 + (depth === 1 ? 0.27 : 0.2));
    if (t1 - t0 < 0.06) continue;
    const root = makeRoot(`${parent.id}.${k}`, depth, pts, width, shade, t0, t1);
    if (root.total < 10) continue;
    roots.push(root);
    addBranches(root, roots, rng, noiseSeed, branching);
  }
}

function buildRoots(layoutSeed: number, opts: SceneOptions): Root[] {
  const rng = new Rng(`plant:${layoutSeed}`);
  const noiseSeed = (layoutSeed * 2654435761) >>> 0;
  const roots: Root[] = [];
  PRIMARIES.slice(0, Math.round(opts.roots)).forEach((spec, i) => {
    const start = { x: CROWN.x + spec.offset, y: CROWN.y + 4 };
    // Spread opens the fan; the roots still curve back down as they go.
    const ang = Math.max(-88, Math.min(88, spec.ang * opts.rootSpread));
    const pts = trimToBounds(
      growCenterline(start, ang, spec.len * opts.rootDepth, spec.pull, 1.0, noiseSeed, i * 17.3 + rng.next() * 3),
    );
    const t1 = Math.min(TL.rootsDone, spec.t0 + (i === 0 ? 0.4 : 0.32));
    const root = makeRoot(`root:${i}`, 0, pts, spec.width, spec.shade, spec.t0, t1);
    roots.push(root);
    addBranches(root, roots, rng, noiseSeed, opts.branching);
  });
  // Finest first, so the heavy roots are laid over the hairs where they meet.
  roots.sort((a, b) => b.depth - a.depth);
  return roots;
}

/**
 * How a root is redrawn when the paint is: a slow warp of the sheet, so a
 * root and its branches move together and stay joined, plus a smaller wander
 * of the root's own, plus a flutter in its line weight. All of it fades to
 * nothing at the crown, which never moves. `unrest` is 1 - stability.
 */
interface Redraw {
  seed: number;
  unrest: number;
}

function redrawn(p: Pt, r: Root, re: Redraw): Pt {
  if (re.unrest <= 0) return p;
  const d = Math.hypot(p.x - CROWN.x, p.y - CROWN.y);
  const amp = re.unrest * 14 * smoothstep(10, 130, d);
  if (amp <= 0) return p;
  const f = 1 / 90;
  const own = (normalizeSeed(r.id) % 997) * 0.37;
  const sheetX = fbm(p.x * f, p.y * f, re.seed ^ 0x3a8f05c5, { octaves: 2, grad: true });
  const sheetY = fbm(p.x * f + 7.3, p.y * f - 3.1, re.seed ^ 0x5bd1e995, { octaves: 2, grad: true });
  const ownX = fbm(p.x * f * 1.6 + own, p.y * f * 1.6, re.seed ^ 0x27d4eb2f, { octaves: 2, grad: true });
  const ownY = fbm(p.x * f * 1.6 - own, p.y * f * 1.6 + own, re.seed ^ 0x165667b1, { octaves: 2, grad: true });
  return {
    x: p.x + amp * (0.65 * sheetX + 0.35 * ownX),
    y: p.y + amp * (0.65 * sheetY + 0.35 * ownY),
  };
}

function rootShape(r: Root, t: number, re: Redraw): ShapeInput | null {
  if (t < r.t0) return null;
  const g = easeOut((t - r.t0) / (r.t1 - r.t0));
  const drawn = r.total * g;
  if (drawn < 2) return null;
  // Fills out for a while after it has stopped lengthening.
  const thick = 0.5 + 0.5 * smoothstep(0, 1, (t - r.t0) / ((r.t1 - r.t0) * 1.3));
  // Growth is measured along the designed root; the redraw moves the result.
  const pts = cutPolyline(r.pts, r.len, drawn).map((p) => redrawn(p, r, re));
  const lens = arcLengths(pts);
  const taperLen = Math.max(4, drawn * 0.12);
  const own = (normalizeSeed(r.id) % 997) * 0.11;
  const hw = pts.map((_, i) => {
    let w = rootWidthAt(r, lens[i] / r.total) * thick * 0.5;
    if (re.unrest > 0) {
      // A hand does not hold the same pressure twice.
      const flutter = fbm(lens[i] * 0.045 + own, own * 0.5, re.seed ^ 0x1f123bb5, { octaves: 1, grad: true });
      w *= 1 + re.unrest * 0.35 * flutter;
    }
    const fromTip = drawn - lens[i];
    return w * Math.sqrt(Math.min(1, fromTip / taperLen));
  });
  const path = strokePath(pts, hw, hw, { roundStart: true });
  if (!path) return null;

  const mature = clamp01((t - r.t0) / (r.t1 - r.t0 + 0.12));
  const sh = SHADE[r.shade];
  const tipColor = mixColor(INK.tip, sh.base, 0.15 + 0.55 * mature);
  const shape: ShapeInput = {
    path,
    fillRule: 'nonzero',
    seed: r.id,
    noiseSize: r.total * 0.9,
  };
  if (drawn > 10) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    shape.gradient = {
      type: 'linear',
      units: 'userSpaceOnUse',
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      stops: [
        { offset: 0, color: sh.deep },
        { offset: 0.18, color: sh.base },
        { offset: 0.62, color: mixColor(sh.base, tipColor, 0.35) },
        { offset: 1, color: tipColor },
      ],
    };
  } else {
    shape.color = tipColor;
  }
  return shape;
}

// ------------------------------------------------------------------- stem --

const STEM = {
  wBase: 14.5,
  wTop: 8,
  /** Extra width where the stem spreads into the crown. */
  flare: 5,
  /** The final stem, from the crown to the apex, at unit height. */
  controls: [CROWN, { x: 271, y: 418 }, { x: 284, y: 345 }, { x: 297, y: 292 }],
};

interface Stem {
  centreline: Pt[];
  len: number[];
  total: number;
}

function buildStem(height: number): Stem {
  // Scaled about the crown, so a taller stem keeps its lean.
  const [p0, p1, p2, p3] = STEM.controls.map((p) => ({
    x: CROWN.x + (p.x - CROWN.x) * height,
    y: CROWN.y + (p.y - CROWN.y) * height,
  }));
  const centreline = cubicBezier(p0, p1, p2, p3, 64);
  const len = arcLengths(centreline);
  return { centreline, len, total: len[len.length - 1] };
}

interface StemState {
  shape: ShapeInput;
  drawn: number;
  grown: number;
  tip: Pt;
  tipDir: Pt;
}

function stemState(t: number, stem: Stem): StemState | null {
  if (t < TL.stem[0]) return null;
  const g = smootherstep(TL.stem[0], TL.stem[1], t);
  const drawn = stem.total * g;
  if (drawn < 1.5) return null;
  let pts = cutPolyline(stem.centreline, stem.len, drawn);
  // The hypocotyl comes up bent double, protecting the tip, and straightens
  // once it is clear of the ground.
  const hook = 1 - smoothstep(TL.hook[0], TL.hook[1], t);
  if (hook > 0.01 && drawn > 12) pts = bendTip(pts, 0.36, -1.3 * hook);
  const lens = arcLengths(pts);
  const young = 0.5 + 0.5 * smoothstep(0, 1, (t - TL.stem[0]) / 0.55);
  const taperLen = Math.max(5, drawn * 0.1);
  const hw = pts.map((_, i) => {
    const sFinal = lens[i] / stem.total;
    let w = mix(STEM.wBase, STEM.wTop, sFinal);
    const flare = Math.max(0, 1 - sFinal / 0.07);
    w += STEM.flare * flare * flare;
    w *= young;
    // Narrows towards the apex at all times, and to a point while growing.
    w *= mix(1, 0.62, smoothstep(0.88, 1, sFinal));
    const fromTip = drawn - lens[i];
    w *= g < 0.999 ? Math.sqrt(Math.min(1, fromTip / taperLen)) : 1;
    return w * 0.5;
  });
  const path = strokePath(pts, hw, hw, { roundStart: true });
  if (!path) return null;
  const tip = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const dl = Math.hypot(tip.x - prev.x, tip.y - prev.y) || 1;
  const tipDir = { x: (tip.x - prev.x) / dl, y: (tip.y - prev.y) / dl };

  // Charcoal at the crown, ochre above, pale at a growing tip. The bands are
  // absolute lengths up the stem, so a short sprout shows its lower colours
  // rather than the whole run squeezed into it.
  const at = (len: number) => clamp01(len / drawn);
  const offsets = [0, at(20), at(46), at(drawn - 40), 1];
  for (let i = 1; i < offsets.length; i++) offsets[i] = Math.max(offsets[i], offsets[i - 1]);
  const gradient: LinearGradient = {
    type: 'linear',
    units: 'userSpaceOnUse',
    x1: pts[0].x,
    y1: pts[0].y,
    x2: tip.x,
    y2: tip.y,
    stops: [
      { offset: offsets[0], color: INK.stemDark },
      { offset: offsets[1], color: INK.stemWarm },
      { offset: offsets[2], color: INK.stemOchre },
      { offset: offsets[3], color: INK.stemLight },
      { offset: offsets[4], color: mixColor(INK.stemLight, INK.tip, 0.6 * (1 - g)) },
    ],
  };
  return {
    shape: { path, fillRule: 'nonzero', gradient, seed: 'stem', noiseSize: stem.total },
    drawn,
    grown: g,
    tip,
    tipDir,
  };
}

// ----------------------------------------------------------------- leaves --

interface LeafDef {
  id: string;
  shade: { light: string; mid: string; dark: string };
  len: number;
  width: number;
  /** Degrees from straight up; positive leans right. */
  angle: number;
  /** The angle the bud starts at, closer to the stem. */
  budAngle: number;
  /** Fraction of the final stem it grows from, or the apex. */
  node: number | 'tip';
  petiole: number;
  /** Fullness of the two margins, [+normal side, -normal side]. */
  asym: [number, number];
  /** Side-vein positions along the blade, [+normal side, -normal side]. */
  veins: [number[], number[]];
  t: readonly [number, number];
  /** Sideways curve of the blade axis, as a fraction of its length. */
  curve: number;
  /** Shading across the blade: colour stops from the -normal margin to the +normal margin. */
  across: { offset: number; key: 'light' | 'mid' | 'dark' }[];
}

const LEAVES: LeafDef[] = [
  {
    id: 'leaf:terminal',
    shade: { light: '#e0b676', mid: '#cd974a', dark: '#a8712b' },
    len: 258,
    width: 146,
    angle: 26,
    budAngle: 6,
    node: 'tip',
    petiole: 14,
    asym: [0.8, 1.15],
    veins: [[0.3, 0.48, 0.66], [0.4]],
    t: [0.34, 0.8],
    curve: -0.06,
    across: [
      { offset: 0, key: 'light' },
      { offset: 0.44, key: 'mid' },
      { offset: 0.52, key: 'dark' },
      { offset: 0.8, key: 'dark' },
      { offset: 1, key: 'mid' },
    ],
  },
  {
    id: 'leaf:dark',
    shade: { light: '#656059', mid: '#4a4744', dark: '#393734' },
    len: 200,
    width: 82,
    angle: -55,
    budAngle: -24,
    node: 0.8,
    petiole: 20,
    asym: [1.02, 0.98],
    veins: [[0.4], [0.56]],
    t: [0.49, 0.86],
    curve: 0.04,
    across: [
      { offset: 0, key: 'light' },
      { offset: 0.5, key: 'dark' },
      { offset: 1, key: 'mid' },
    ],
  },
  {
    id: 'leaf:pale',
    shade: { light: '#c3b6a3', mid: '#a99a86', dark: '#8a7a66' },
    len: 160,
    width: 60,
    angle: 50,
    budAngle: 22,
    node: 0.58,
    petiole: 10,
    asym: [1.05, 0.95],
    veins: [[0.46], []],
    t: [0.55, 0.88],
    curve: -0.04,
    across: [
      { offset: 0, key: 'light' },
      { offset: 0.5, key: 'mid' },
      { offset: 1, key: 'dark' },
    ],
  },
];

/** Half-width of the blade along its length, 0..1, widest a little before the middle. */
const PROFILE_PEAK = Math.pow(0.8 / 2.15, 0.8) * Math.pow(1.35 / 2.15, 1.35);
function bladeProfile(s: number): number {
  return (Math.pow(s, 0.8) * Math.pow(1 - s, 1.35)) / PROFILE_PEAK;
}

function leafShapes(def: LeafDef, t: number, node: Pt, opts: SceneOptions): ShapeInput[] {
  if (t < def.t[0]) return [];
  const g = smootherstep(def.t[0], def.t[1], t);
  const size = opts.leafSize;
  const L = def.len * size * (0.05 + 0.95 * g);
  // A bud is a narrow spike; the blade broadens late.
  const Wd = def.width * size * (0.2 + 0.8 * Math.pow(g, 1.4));
  const ang = (mix(def.budAngle, def.angle, smoothstep(0, 1, g)) * Math.PI) / 180;
  const a = { x: Math.sin(ang), y: -Math.cos(ang) };
  const nrm = { x: -a.y, y: a.x };
  const pet = def.petiole * size * (0.25 + 0.75 * g);

  const pts: Pt[] = [];
  const hwL: number[] = [];
  const hwR: number[] = [];
  const petSteps = Math.max(2, Math.round(pet / 3));
  for (let i = 0; i <= petSteps; i++) {
    const u = i / petSteps;
    pts.push({ x: node.x + a.x * pet * u, y: node.y + a.y * pet * u });
    const w = mix(1.9, 1.3, u) * (0.55 + 0.45 * g);
    hwL.push(w);
    hwR.push(w);
  }
  const base = pts[pts.length - 1];
  const N = 44;
  const centre = (s: number): Pt => {
    const bend = def.curve * L * s * s;
    return { x: base.x + a.x * L * s + nrm.x * bend, y: base.y + a.y * L * s + nrm.y * bend };
  };
  const half = (s: number): number => (Wd / 2) * bladeProfile(s);
  for (let i = 1; i <= N; i++) {
    const s = i / N;
    pts.push(centre(s));
    const h = half(s);
    hwL.push(Math.max(h * def.asym[0], i < 3 ? 1.2 : 0));
    hwR.push(Math.max(h * def.asym[1], i < 3 ? 1.2 : 0));
  }
  let d = strokePath(pts, hwL, hwR, { roundStart: false });
  if (!d) return [];

  // Veins. A painter leaves them unpainted and tints them afterwards, so
  // they are cut out of the blade and then glazed over with a pale wash a
  // little wider than the gap: paper tinted where the gap was, and a faint
  // darker line where the glaze overlaps the blade. They come in once the
  // blade has some breadth.
  const v = smoothstep(0.45, 0.85, g) * opts.veins;
  let veinPath = '';
  if (v > 0.03 && L > 30) {
    const ribW = (s: number) => mix(0.6, 0.2, (s - 0.035) / 0.905) * v;
    const ribPts: Pt[] = [];
    const ribHw: number[] = [];
    const M = 30;
    for (let i = 0; i <= M; i++) {
      const s = mix(0.035, 0.94, i / M);
      ribPts.push(centre(s));
      ribHw.push(ribW(s));
    }
    const strokes: { pts: Pt[]; hw: number[] }[] = [{ pts: ribPts, hw: ribHw }];
    def.veins.forEach((positions, sideIndex) => {
      const side = sideIndex === 0 ? 1 : -1;
      for (const s of positions) {
        const start = centre(s);
        const reach = 0.56 * half(s) * def.asym[sideIndex];
        if (reach < 4) continue;
        // Each vein leaves at its own angle, so they do not read as a comb.
        const lean = 36 + ((s * 97) % 1) * 14;
        const vp: Pt[] = [];
        const vh: number[] = [];
        const K = 8;
        for (let k = 0; k <= K; k++) {
          const u = k / K;
          // Leaves the midrib steeply and sweeps towards the tip.
          const beta = (mix(lean, 20, u) * Math.PI) / 180;
          const dx = a.x * Math.cos(beta) + nrm.x * Math.sin(beta) * side;
          const dy = a.y * Math.cos(beta) + nrm.y * Math.sin(beta) * side;
          const dist = ribW(s) + 0.6 + reach * u;
          vp.push({ x: start.x + dx * dist, y: start.y + dy * dist });
          vh.push(mix(0.28, 0.1, u) * v);
        }
        strokes.push({ pts: vp, hw: vh });
      }
    });
    for (const st of strokes) {
      const hole = strokePath(st.pts, st.hw, st.hw, { roundStart: false });
      if (hole) d += hole;
      const wide = st.hw.map((w) => Math.max(0.55, w * 1.7));
      const glaze = strokePath(st.pts, wide, wide, { roundStart: false });
      if (glaze) veinPath += glaze;
    }
  }

  const c = centre(0.42);
  const span = Wd / 2 + 2;
  const gradient: LinearGradient = {
    type: 'linear',
    units: 'userSpaceOnUse',
    x1: c.x - nrm.x * span * def.asym[1],
    y1: c.y - nrm.y * span * def.asym[1],
    x2: c.x + nrm.x * span * def.asym[0],
    y2: c.y + nrm.y * span * def.asym[0],
    stops: def.across.map((st) => ({ offset: st.offset, color: def.shade[st.key] })),
  };
  const out: ShapeInput[] = [
    { path: d, fillRule: 'evenodd', gradient, seed: def.id, noiseSize: def.len * size },
  ];
  if (veinPath) {
    out.push({
      path: veinPath,
      fillRule: 'nonzero',
      color: mixColor(def.shade.light, '#ffffff', 0.42),
      opacity: 0.9,
      seed: `${def.id}:veins`,
      noiseSize: def.len * size,
    });
  }
  return out;
}

// ------------------------------------------------------------------- seed --

function seedShape(t: number, stem: StemState | null): ShapeInput | null {
  if (t > TL.seedFade[1]) return null;
  const fade = 1 - smoothstep(TL.seedFade[0], TL.seedFade[1], t);
  if (fade <= 0.02) return null;
  const swell = mix(0.88, 1, smoothstep(TL.seedSwell[0], TL.seedSwell[1], t));
  const scale = swell * mix(0.72, 1, fade);
  const rx = 8 * scale;
  const ry = 11 * scale;
  let c: Pt;
  let dir: Pt;
  if (stem && t >= TL.seedLift) {
    // The seed coat is carried up on the shoot tip until it is shed.
    dir = stem.tipDir;
    c = { x: stem.tip.x + dir.x * ry * 0.55, y: stem.tip.y + dir.y * ry * 0.55 };
  } else {
    dir = { x: 0, y: -1 };
    c = { x: CROWN.x, y: CROWN.y - 8 };
  }
  const rot = Math.atan2(dir.x, -dir.y) + 0.18;
  const path = polygonPath(ovoid(c.x, c.y, rx, ry, rot, 0.22));
  const ax = { x: Math.sin(rot), y: -Math.cos(rot) };
  const gradient: LinearGradient = {
    type: 'linear',
    units: 'userSpaceOnUse',
    x1: c.x - ax.x * ry,
    y1: c.y - ax.y * ry,
    x2: c.x + ax.x * ry,
    y2: c.y + ax.y * ry,
    stops: [
      { offset: 0, color: INK.seedDark },
      { offset: 0.45, color: INK.seed },
      { offset: 1, color: INK.seedLight },
    ],
  };
  return { path, fillRule: 'nonzero', gradient, opacity: fade, seed: 'seed', noiseSize: 26 };
}

// ------------------------------------------------------------------ scene --

interface Plant {
  roots: Root[];
  stem: Stem;
}

let layoutCache: { key: string; plant: Plant } | null = null;

/** The parts of the plant that do not change with time, built once per layout. */
function plantFor(layoutSeed: number, opts: SceneOptions): Plant {
  const key = `${layoutSeed}|${OPTIONS.map((o) => opts[o.key]).join(',')}`;
  if (!layoutCache || layoutCache.key !== key) {
    layoutCache = {
      key,
      plant: { roots: buildRoots(layoutSeed, opts), stem: buildStem(opts.stemHeight) },
    };
  }
  return layoutCache.plant;
}

export const plantScene: Scene = {
  id: 'plant',
  name: 'Plant growing',
  blurb:
    'A seed puts down a root and up a shoot, sheds its coat, and opens three leaves ' +
    'over a branching root system. Ten seconds, with a hold on the finished plant.',
  viewBox: VIEW,
  duration: 10,
  options: OPTIONS,
  frame(time: number, layoutSeed = 1, options?: Partial<SceneOptions>, paintSeed = 0): ShapeInput[] {
    const t = clamp01(time);
    const opts = resolveSceneOptions(OPTIONS, options);
    const plant = plantFor(layoutSeed, opts);
    const re: Redraw = { seed: normalizeSeed(paintSeed), unrest: 1 - opts.rootStability };
    const shapes: ShapeInput[] = [];
    for (const r of plant.roots) {
      const s = rootShape(r, t, re);
      if (s) shapes.push(s);
    }
    const stem = stemState(t, plant.stem);
    if (stem) {
      shapes.push(stem.shape);
      // Lowest leaf first, the apex leaf on top.
      for (const def of LEAVES.slice(0, Math.round(opts.leaves)).reverse()) {
        const node =
          def.node === 'tip'
            ? stem.tip
            : stem.drawn >= def.node * plant.stem.total
              ? pointAlong(plant.stem.centreline, plant.stem.len, def.node * plant.stem.total).p
              : null;
        if (!node) continue;
        shapes.push(...leafShapes(def, t, node, opts));
      }
    }
    const seed = seedShape(t, stem);
    if (seed) shapes.push(seed);
    return shapes;
  },
};
