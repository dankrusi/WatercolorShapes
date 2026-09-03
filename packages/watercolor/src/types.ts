/**
 * Public option types, parameter metadata and defaults.
 */

export type Flavor = 'wash' | 'granulate' | 'bloom' | 'fluid' | 'drybrush' | 'layered';

export const FLAVORS: Flavor[] = ['wash', 'granulate', 'bloom', 'fluid', 'drybrush', 'layered'];

export const FLAVOR_INFO: Record<Flavor, { label: string; blurb: string }> = {
  wash: {
    label: 'Wash',
    blurb:
      'A single graded wash laid wet-on-dry. Smooth form shading, soft mottling, restrained edge darkening.',
  },
  granulate: {
    label: 'Granulate',
    blurb:
      'Heavy pigment settling into the paper tooth. Fine dense grain plus broad cloudy drifts, sharp edge.',
  },
  bloom: {
    label: 'Bloom',
    blurb:
      'Back-runs and cauliflowers. Hard-rimmed dried patches over a lighter body, with a faceted edge.',
  },
  fluid: {
    label: 'Fluid (physical)',
    blurb:
      'Shallow-water fluid simulation with pigment advection, adsorption and capillary spread. Slowest, most physical.',
  },
  drybrush: {
    label: 'Dry brush',
    blurb:
      'A thirsty brush skipping over the tooth. Broken coverage, ragged edge, paper showing through.',
  },
  layered: {
    label: 'Layered glaze',
    blurb:
      'Several transparent passes, each with its own slightly different edge, building depth where they overlap.',
  },
};

/** A gradient colour stop. */
export interface GradientStop {
  /** Position along the gradient, 0..1. */
  offset: number;
  /** Any CSS colour string. */
  color: string;
  /** 0..1, multiplied into the stop colour's own alpha. */
  opacity?: number;
}

export interface LinearGradient {
  type: 'linear';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stops: GradientStop[];
  /** 'objectBoundingBox' (default, coords 0..1) or 'userSpaceOnUse'. */
  units?: 'objectBoundingBox' | 'userSpaceOnUse';
  /** SVG gradientTransform, as an attribute string. */
  transform?: string;
}

export interface RadialGradient {
  type: 'radial';
  cx: number;
  cy: number;
  r: number;
  fx?: number;
  fy?: number;
  stops: GradientStop[];
  units?: 'objectBoundingBox' | 'userSpaceOnUse';
  transform?: string;
}

export type GradientFill = LinearGradient | RadialGradient;

/** One filled sub-shape of the input. */
export interface ShapeInput {
  /** SVG path data. */
  path: string;
  /** Solid fill colour. Ignored when `gradient` is set. */
  color?: string;
  /** Gradient fill. Drives both the colour ramp and the shading. */
  gradient?: GradientFill;
  fillRule?: 'nonzero' | 'evenodd';
  /** SVG transform attribute applied to this shape's path data. */
  transform?: string;
  /** 0..1 overall opacity for this shape. */
  opacity?: number;
}

export interface WatercolorParams {
  // --- Pigment -----------------------------------------------------------
  /** Overall pigment load. 1 reaches the nominal colour; above that it deepens. */
  intensity: number;
  /**
   * Kubelka-Munk scattering. Low is a transparent staining pigment,
   * high is a chalky opaque one that granulates.
   */
  scattering: number;
  /** Pigment body: scales both K and S, thickening the paint. */
  bodyStrength: number;

  // --- Edge --------------------------------------------------------------
  /** Low-frequency wander of the wash boundary, as a fraction of shape size. */
  edgeWobble: number;
  /** How many octaves of detail the boundary wander carries. */
  edgeDetail: number;
  /** Faceted, crystalline stepping of the boundary (cell-noise driven). */
  edgeCrystal: number;
  /** Edge transition width in output pixels. Below 1 reads as a sharp cut. */
  edgeSoftness: number;
  /** Extra pigment deposited in the rim where the wash dried. */
  edgeDarkening: number;
  /** Width of that rim, as a fraction of shape size. */
  edgeDarkeningWidth: number;
  /** How unevenly the rim varies around the perimeter. */
  edgeVariation: number;
  /**
   * How much more pigment strands along the downhill edge than the uphill
   * one. A wash drains under gravity before it dries.
   */
  edgeGravity: number;
  /** Paper fibres pinning the advancing edge: high-frequency edge noise. */
  fiberPinning: number;

  // --- Texture -----------------------------------------------------------
  /** Pigment settling into the paper tooth. Fine, high-contrast grain. */
  granulation: number;
  /** Broad tonal drift across the wash. */
  mottling: number;
  /** Size of the mottling cells, as a fraction of shape size. */
  mottleScale: number;
  /** Strength of back-run / cauliflower patches. */
  blooms: number;
  /** Size of the bloom cells, as a fraction of shape size. */
  bloomScale: number;
  /** Hardness of the bloom rims. */
  bloomEdge: number;

  // --- Shading -----------------------------------------------------------
  /** Strength of the form-following light-and-shade. */
  shading: number;
  /** Light direction in degrees, clockwise from 12 o'clock. */
  lightAngle: number;
  /** Light elevation in degrees. 90 is straight on, 0 is raking. */
  lightElevation: number;
  /** How far the implied form bulges: fraction of shape size used as relief. */
  formDepth: number;
  /** Softness of the implied form, as a fraction of shape size. */
  formSoftness: number;
  /** Pigment pooling in the concavities of the implied form. */
  ambientOcclusion: number;

  // --- Paper -------------------------------------------------------------
  /** Visibility of the paper grain in the final image. */
  paperTexture: number;
  /** Paper grain size in output pixels. */
  paperScale: number;

  // --- Fluid simulation (flavor: 'fluid') --------------------------------
  /** Number of simulation timesteps. */
  fluidSteps: number;
  /** Fluid viscosity: high damps flow into a stiller, more even wash. */
  fluidViscosity: number;
  /** Fluid drag against the paper. */
  fluidDrag: number;
  /** Rate at which suspended pigment is adsorbed by the paper. */
  fluidDeposition: number;
  /** Rate at which deposited pigment redissolves into the water. */
  fluidLift: number;
  /** How strongly the paper tooth grabs pigment during transfer. */
  fluidGranularity: number;
  /** Strength of the outward gradient that drives the edge-darkening rim. */
  fluidEdgePull: number;
  /** Capillary spread of water beyond the wet mask. */
  fluidCapillary: number;

  // --- Misc --------------------------------------------------------------
  /** Number of glaze passes for the 'layered' flavor. */
  layers: number;
  /** Amount of hue/temperature drift between light and shadow. */
  pigmentDrift: number;
  /**
   * How much deeper the neat pigment is than the colour you asked for.
   * 1 treats the input as the pigment itself; higher values treat it as a
   * dilute wash of a richer paint, which is what watercolour actually is.
   */
  pigmentDepth: number;
}

export interface RenderOptions {
  /** A single SVG path's `d` attribute. Shorthand for `shapes: [{ path }]`. */
  path?: string;
  /** Raw SVG source; every filled path in it is rendered. */
  svg?: string;
  /** Explicit list of shapes, taking precedence over `path` / `svg`. */
  shapes?: ShapeInput[];
  /** Fill colour used when a shape does not carry its own. */
  color?: string;
  /** Gradient fill used when a shape does not carry its own. */
  gradient?: GradientFill;
  /** Coordinate system of the incoming path data. Inferred when omitted. */
  viewBox?: { x: number; y: number; width: number; height: number };

  /** Output width in pixels, before `resolution`. */
  width?: number;
  /** Output height in pixels, before `resolution`. Derived from the shape when omitted. */
  height?: number;
  /** Output scale multiplier. 2 renders at twice the pixel size. */
  resolution?: number;
  /** Supersampling factor, 1-4. Higher is cleaner but quadratically slower. */
  supersample?: number;
  /** Margin around the shape, as a fraction of the output's smaller side. */
  padding?: number;
  /** Scale the shape to fit the output box, or use the viewBox mapping as-is. */
  fit?: 'contain' | 'none';
  /** What fills the output. A colour, or null for a transparent background. */
  background?: string | null;
  /**
   * The sheet the paint sits on.
   *
   * Distinct from `background`, which is only what fills the image. The paper
   * takes part in the physics: the pigment is solved against it, and every
   * layer composites over it. Defaults to `background` when that is a colour,
   * and to the library's own paper when the background is transparent - so
   * asking for transparency changes what surrounds the shape without also
   * changing the paint.
   */
  paper?: string;
  /**
   * With `background: null`, bake the paper colour in behind the pigment.
   *
   * A wash is genuinely translucent, so by default a transparent render hands
   * back that translucency: the pigment tints whatever ends up behind it, and
   * a pale passage is barely there. That is physically right and is usually
   * not what you want out of an export - drop the file on a dark page and the
   * painting turns into a colour filter over it.
   *
   * With this on, the paper goes in behind the pigment and the alpha channel
   * carries only the silhouette. The result is a cut-out: transparent outside
   * the shape, fully opaque within it, and identical to the on-paper render
   * wherever you place it. Ignored unless `background` is null.
   */
  bakePaper?: boolean;

  /** Randomisation seed. The same seed always yields the same image. */
  seed?: number | string;
  /** Which algorithm to use. */
  flavor?: Flavor;
  /** Parameter overrides, merged over the flavor's preset. */
  params?: Partial<WatercolorParams>;
}

export interface RenderResult {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, premultiplied by nothing (straight alpha). */
  data: Uint8ClampedArray<ArrayBuffer>;
  /** The seed actually used, so a random render can be reproduced. */
  seed: number | string;
  flavor: Flavor;
  /** Milliseconds spent in each stage, for the demo's readout. */
  timings: Record<string, number>;
}

export type ParamGroup = 'Pigment' | 'Edge' | 'Texture' | 'Shading' | 'Paper' | 'Fluid' | 'Misc';

export interface ParamSpec {
  key: keyof WatercolorParams;
  label: string;
  group: ParamGroup;
  min: number;
  max: number;
  step: number;
  /** Flavors this parameter affects. Undefined means all of them. */
  flavors?: Flavor[];
  hint?: string;
}

/** Slider metadata, consumed by the demo UI to build its controls. */
export const PARAM_SPECS: ParamSpec[] = [
  { key: 'intensity', label: 'Intensity', group: 'Pigment', min: 0, max: 2.5, step: 0.01, hint: 'Pigment load' },
  { key: 'scattering', label: 'Scattering', group: 'Pigment', min: 0.02, max: 2, step: 0.01, hint: 'Transparent staining vs chalky opaque' },
  { key: 'bodyStrength', label: 'Body', group: 'Pigment', min: 0.2, max: 3, step: 0.01 },
  { key: 'pigmentDrift', label: 'Pigment drift', group: 'Pigment', min: 0, max: 1, step: 0.01, hint: 'Hue shift between light and shadow' },
  { key: 'pigmentDepth', label: 'Pigment depth', group: 'Pigment', min: 1, max: 4, step: 0.05, hint: 'How much richer the neat paint is than the wash' },

  { key: 'edgeWobble', label: 'Edge wobble', group: 'Edge', min: 0, max: 0.06, step: 0.0005 },
  { key: 'edgeDetail', label: 'Edge detail', group: 'Edge', min: 1, max: 6, step: 1 },
  { key: 'edgeCrystal', label: 'Edge faceting', group: 'Edge', min: 0, max: 0.03, step: 0.0002 },
  { key: 'edgeSoftness', label: 'Edge softness', group: 'Edge', min: 0.3, max: 6, step: 0.05, hint: 'Output pixels' },
  { key: 'fiberPinning', label: 'Fibre pinning', group: 'Edge', min: 0, max: 0.02, step: 0.0002 },
  { key: 'edgeDarkening', label: 'Edge darkening', group: 'Edge', min: 0, max: 2, step: 0.01 },
  { key: 'edgeDarkeningWidth', label: 'Rim width', group: 'Edge', min: 0.002, max: 0.2, step: 0.001 },
  { key: 'edgeVariation', label: 'Rim variation', group: 'Edge', min: 0, max: 1, step: 0.01 },
  { key: 'edgeGravity', label: 'Rim gravity', group: 'Edge', min: 0, max: 1, step: 0.01, hint: 'Heavier deposit along the lower edge' },

  { key: 'granulation', label: 'Granulation', group: 'Texture', min: 0, max: 2, step: 0.01 },
  { key: 'mottling', label: 'Mottling', group: 'Texture', min: 0, max: 2, step: 0.01 },
  { key: 'mottleScale', label: 'Mottle scale', group: 'Texture', min: 0.02, max: 1.2, step: 0.005 },
  { key: 'blooms', label: 'Blooms', group: 'Texture', min: 0, max: 2, step: 0.01 },
  { key: 'bloomScale', label: 'Bloom scale', group: 'Texture', min: 0.03, max: 1, step: 0.005 },
  { key: 'bloomEdge', label: 'Bloom hardness', group: 'Texture', min: 0, max: 1, step: 0.01 },

  { key: 'shading', label: 'Shading', group: 'Shading', min: 0, max: 2, step: 0.01 },
  { key: 'lightAngle', label: 'Light angle', group: 'Shading', min: 0, max: 360, step: 1, hint: 'Degrees clockwise from top' },
  { key: 'lightElevation', label: 'Light elevation', group: 'Shading', min: 5, max: 90, step: 1 },
  { key: 'formDepth', label: 'Form depth', group: 'Shading', min: 0, max: 1.2, step: 0.01 },
  { key: 'formSoftness', label: 'Form softness', group: 'Shading', min: 0.01, max: 0.8, step: 0.005 },
  { key: 'ambientOcclusion', label: 'Occlusion', group: 'Shading', min: 0, max: 1.5, step: 0.01 },

  { key: 'paperTexture', label: 'Paper grain', group: 'Paper', min: 0, max: 1.5, step: 0.01 },
  { key: 'paperScale', label: 'Grain scale', group: 'Paper', min: 0.5, max: 12, step: 0.1, hint: 'Output pixels' },

  { key: 'fluidSteps', label: 'Sim steps', group: 'Fluid', min: 4, max: 160, step: 1, flavors: ['fluid'] },
  { key: 'fluidViscosity', label: 'Viscosity', group: 'Fluid', min: 0, max: 0.5, step: 0.005, flavors: ['fluid'] },
  { key: 'fluidDrag', label: 'Drag', group: 'Fluid', min: 0, max: 0.5, step: 0.005, flavors: ['fluid'] },
  { key: 'fluidDeposition', label: 'Deposition', group: 'Fluid', min: 0, max: 0.6, step: 0.005, flavors: ['fluid'] },
  { key: 'fluidLift', label: 'Re-dissolve', group: 'Fluid', min: 0, max: 0.4, step: 0.005, flavors: ['fluid'] },
  { key: 'fluidGranularity', label: 'Tooth grab', group: 'Fluid', min: 0, max: 2, step: 0.01, flavors: ['fluid'] },
  { key: 'fluidEdgePull', label: 'Edge pull', group: 'Fluid', min: 0, max: 0.5, step: 0.005, flavors: ['fluid'] },
  { key: 'fluidCapillary', label: 'Capillary', group: 'Fluid', min: 0, max: 1, step: 0.01, flavors: ['fluid'] },

  { key: 'layers', label: 'Glaze passes', group: 'Misc', min: 1, max: 6, step: 1, flavors: ['layered'] },
];

/**
 * Baseline parameters. Each flavor's preset is a delta on top of this, so a
 * parameter left alone behaves the same way everywhere.
 */
export const BASE_PARAMS: WatercolorParams = {
  intensity: 1,
  scattering: 0.42,
  bodyStrength: 1,
  pigmentDrift: 0.22,
  pigmentDepth: 2.2,

  edgeWobble: 0.002,
  edgeDetail: 5,
  edgeCrystal: 0.0035,
  edgeSoftness: 0.65,
  edgeDarkening: 0.32,
  edgeDarkeningWidth: 0.007,
  edgeVariation: 0.85,
  edgeGravity: 0.3,
  fiberPinning: 0.0022,

  granulation: 1.76,
  mottling: 0.71,
  mottleScale: 0.195,
  blooms: 0.67,
  bloomScale: 0.25,
  bloomEdge: 0.51,

  shading: 0.3,
  lightAngle: 35,
  lightElevation: 42,
  formDepth: 0.85,
  formSoftness: 0.21,
  ambientOcclusion: 0.52,

  paperTexture: 0.51,
  paperScale: 2.4,

  fluidSteps: 46,
  fluidViscosity: 0.11,
  fluidDrag: 0.06,
  fluidDeposition: 0.14,
  fluidLift: 0.045,
  fluidGranularity: 0.8,
  fluidEdgePull: 0.11,
  fluidCapillary: 0.35,

  layers: 3,
};

/**
 * Per-flavor deltas over `BASE_PARAMS`.
 *
 * These are what actually distinguish the six algorithms as *paint*. The code
 * paths differ too, but a flavor is only convincing when its parameters agree
 * with its physics: a granulating pigment has to be chalky (high scattering)
 * as well as speckled, and a staining one has to be transparent as well as
 * smooth.
 */
export const FLAVOR_PRESETS: Record<Flavor, Partial<WatercolorParams>> = {
  // `wash` deliberately overrides almost nothing: the baseline *is* the plain
  // wash, and the other five are described as departures from it. Only the
  // pigment differs - a wash is laid with a transparent staining colour rather
  // than a bodied one.
  wash: {
    scattering: 0.34,
  },
  granulate: {
    // Chalky, heavily scattering pigment: that is what granulation *is*.
    scattering: 0.85,
    granulation: 1.0,
    mottling: 0.4,
    mottleScale: 0.24,
    blooms: 0.06,
    shading: 0.34,
    edgeDarkening: 0.55,
    paperScale: 2.0,
    paperTexture: 0.62,
  },
  bloom: {
    scattering: 0.45,
    blooms: 0.7,
    bloomEdge: 0.68,
    bloomScale: 0.12,
    granulation: 0.3,
    mottling: 0.34,
    shading: 0.4,
    edgeCrystal: 0.006,
    edgeDarkening: 0.55,
  },
  fluid: {
    scattering: 0.5,
    granulation: 0.42,
    shading: 0.45,
    edgeDarkening: 0.3,
    // A stiller, longer-settling wash: the default drag and viscosity damped
    // the flow out within a dozen steps, leaving the simulation nothing to
    // redistribute and an image indistinguishable from the initial load.
    fluidViscosity: 0.06,
    fluidDrag: 0.025,
    fluidEdgePull: 0.16,
    fluidGranularity: 1.2,
    fluidLift: 0.06,
  },
  drybrush: {
    scattering: 0.6,
    granulation: 0.5,
    mottling: 0.45,
    shading: 0.3,
    edgeWobble: 0.009,
    fiberPinning: 0.007,
    edgeCrystal: 0.005,
    edgeDarkening: 0.3,
    paperScale: 2.8,
    paperTexture: 0.75,
  },
  layered: {
    scattering: 0.3,
    layers: 3,
    shading: 0.45,
    mottling: 0.42,
    granulation: 0.3,
    edgeDarkening: 0.5,
  },
};

export function resolveParams(flavor: Flavor, overrides?: Partial<WatercolorParams>): WatercolorParams {
  return { ...BASE_PARAMS, ...FLAVOR_PRESETS[flavor], ...(overrides ?? {}) };
}
