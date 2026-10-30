/**
 * watercolor-shapes
 *
 * Turns an SVG path plus a colour into a physically-motivated watercolour
 * rendering of that shape: crisp where a brush edge is crisp, irregular where
 * paper and water make it irregular, shaded to the form, and granulating,
 * blooming and edge-darkening the way pigment on wet paper actually does.
 *
 * Everything is deterministic in `seed`, so the same inputs always give the
 * same image, and stepping the seed gives a new take on the same shape.
 */

export { render, clearGeometryCache } from './render.js';
export {
  toCanvas,
  toImageData,
  paintToCanvas,
  toDataURL,
  toBlob,
  createRenderer,
  type Renderer,
} from './browser.js';

export type {
  Flavor,
  GradientFill,
  GradientStop,
  LinearGradient,
  RadialGradient,
  ParamGroup,
  ParamSpec,
  RenderOptions,
  RenderResult,
  ShapeInput,
  WatercolorParams,
} from './types.js';

export {
  BASE_PARAMS,
  FLAVORS,
  FLAVOR_INFO,
  FLAVOR_PRESETS,
  PARAM_SPECS,
  resolveParams,
} from './types.js';

export { parseSvg, type ParsedSvg } from './svg/document.js';
export {
  SCENES,
  getScene,
  plantScene,
  resolveSceneOptions,
  type Scene,
  type SceneOptionSpec,
  type SceneOptions,
} from './scenes/index.js';
export {
  strokePath,
  polygonPath,
  cubicBezier,
  arcLengths,
  pointAlong,
  cutPolyline,
  bendTip,
  ovoid,
  type Pt,
} from './scenes/stroke.js';
export { Rng, normalizeSeed, hashString } from './rng.js';
export { parseColor, toLinear, toSrgb, linearToSrgb, srgbToLinear, type RGB } from './color/color.js';
export { pigmentFromColor, layerRT, compositePigment, PigmentLut, type Pigment } from './color/km.js';
export { makePaper } from './paper.js';
export { flattenPath, contourBounds, parseTransform, type Contour, type Matrix } from './path/parse.js';
export { rasterize, signedDistance } from './path/raster.js';
export { simulateWash, type FluidOptions, type FluidResult } from './sim/fluid.js';
