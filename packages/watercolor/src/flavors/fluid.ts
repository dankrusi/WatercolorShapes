/**
 * Flavor: `fluid`.
 *
 * Runs the shallow-water simulation and turns its deposited-pigment field
 * into a thickness map.
 *
 * The simulation runs on its own coarser grid. That is not only for speed:
 * the physical scale of the flow features in a real wash is millimetres, not
 * paper fibres, so simulating at output resolution would spend most of its
 * work resolving structure finer than the phenomenon actually has. The
 * silhouette and the tooth-scale grain are added back at full resolution
 * afterwards, which is what keeps the edge crisp while the interior stays
 * physically derived.
 */

import { sampleBilinear } from '../path/raster.js';
import { simulateWash } from '../sim/fluid.js';
import { clamp01 } from '../noise.js';
import { shadeFactor, textureFactor, type FieldContext } from './common.js';

/** Longest side of the simulation grid. */
const SIM_MAX = 320;

export function fluidField(ctx: FieldContext): Float32Array {
  const { width, height, params: p, mask, tex } = ctx;
  const n = width * height;

  const scale = Math.min(1, SIM_MAX / Math.max(width, height));
  const sw = Math.max(16, Math.round(width * scale));
  const sh = Math.max(16, Math.round(height * scale));

  // Downsample the inputs the simulation needs.
  const simMask = resample(mask, width, height, sw, sh);
  const simPaper = resample(ctx.paper, width, height, sw, sh);

  // Initial pigment load: what the brush put down before any water moved.
  // The form shading goes in here rather than being applied afterwards, so
  // the simulation gets to redistribute it the way a real wash would.
  const load = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (mask[i] <= 0.0006) continue;
    let t = shadeFactor(ctx, i, 1.7);
    if (ctx.gradientThickness) t *= ctx.gradientThickness[i];
    load[i] = Math.max(0, t);
  }
  const simLoad = resample(load, width, height, sw, sh);
  for (let i = 0; i < sw * sh; i++) simLoad[i] *= simMask[i] > 0.5 ? 1 : 0;

  const sim = simulateWash({
    width: sw,
    height: sh,
    mask: simMask,
    paper: simPaper,
    pigment: simLoad,
    steps: p.fluidSteps,
    viscosity: p.fluidViscosity,
    drag: p.fluidDrag,
    deposition: p.fluidDeposition,
    lift: p.fluidLift,
    granularity: p.fluidGranularity,
    edgePull: p.fluidEdgePull,
    capillary: p.fluidCapillary,
    seed: ctx.seed,
  });

  // Normalise so that `intensity` keeps meaning the same thing regardless of
  // how many steps ran or how much pigment the simulation chose to strand.
  let sum = 0;
  let count = 0;
  for (let i = 0; i < sw * sh; i++) {
    if (simMask[i] > 0.5) {
      sum += sim.deposited[i];
      count++;
    }
  }
  const meanDep = count > 0 ? sum / count : 1;
  const norm = meanDep > 1e-6 ? 1 / meanDep : 1;

  const out = new Float32Array(n);
  const clump = tex.grainClump;
  const invScaleX = sw / width;
  const invScaleY = sh / height;
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const m = mask[i];
      if (m <= 0.0006) {
        out[i] = 0;
        continue;
      }
      let t = sampleBilinear(sim.deposited, sw, sh, (x + 0.5) * invScaleX - 0.5, (y + 0.5) * invScaleY - 0.5) * norm;
      // Paper-scale grain, which the coarse grid cannot represent.
      t *= textureFactor(p.granulation, tex.granulationAt(i, clump) * 0.45);
      // A touch of the analytic rim on top: the simulated rim is real but
      // lands on the coarse grid, so it arrives at full resolution too soft
      // to read as a dried edge.
      t += p.edgeDarkening * ctx.rim[i] * 0.35;
      out[i] = clamp01(t / 4) * 4 * m;
    }
  }
  return out;
}

/** Area-weighted resample of a field to a different grid. */
function resample(
  src: Float32Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Float32Array {
  const out = new Float32Array(dw * dh);
  if (sw === dw && sh === dh) {
    out.set(src);
    return out;
  }
  const rx = sw / dw;
  const ry = sh / dh;
  let i = 0;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * ry);
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.floor((y + 1) * ry)));
    for (let x = 0; x < dw; x++, i++) {
      const x0 = Math.floor(x * rx);
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.floor((x + 1) * rx)));
      let acc = 0;
      let cnt = 0;
      for (let sy = y0; sy < y1; sy++) {
        const row = sy * sw;
        for (let sx = x0; sx < x1; sx++) {
          acc += src[row + sx];
          cnt++;
        }
      }
      out[i] = cnt > 0 ? acc / cnt : 0;
    }
  }
  return out;
}
