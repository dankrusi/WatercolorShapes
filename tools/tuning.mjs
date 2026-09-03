/**
 * Per-case parameter overrides used by the reference harness.
 *
 * These were fitted by `tools/search.py`, not hand-picked: coordinate descent
 * over the render parameters, scored by `tools/compare.py` against the
 * reference bitmap and averaged over three seeds so the fit describes the
 * distribution a parameter set produces rather than one lucky noise field.
 *
 * `'*'` applies to every flavor for that case; a flavor key overrides it.
 *
 * Refitted after the library defaults were retuned. That matters more than it
 * sounds: these are *deltas*, so a parameter a fit happened to inherit rather
 * than set moves underneath it whenever a default moves. Re-running the search
 * is the only honest way to keep the recorded scores meaning what they say.
 *
 * What is left here is genuinely per-painting: how strongly each one is
 * modelled, how coarse its patches are, and which way its light comes from.
 */

export const TUNING = {
  // A modelled dome: a long graduation, coarse drying patches, and a heavy rim
  // along the flat bottom edge. Best matched by `wash` - 97.99.
  halfcircle1: {
    '*': {
      intensity: 1.155,
      pigmentDepth: 2.219,
      lightAngle: 75,
      shading: 0.4,
      formDepth: 1.02,
      ambientOcclusion: 0.113,
      mottling: 0.88,
      mottleScale: 0.202,
      granulation: 1.229,
      edgeDarkening: 0.525,
      edgeDarkeningWidth: 0.0131,
      edgeWobble: 0.0046,
      edgeSoftness: 0.35,
      paperScale: 3.48,
    },
  },

  // Flatter, and visibly built from small overlapping lobes. Best matched by
  // `bloom` - 98.00.
  halfcircle2: {
    '*': {
      intensity: 1.05,
      pigmentDepth: 1.886,
      lightAngle: 115,
      formDepth: 0.612,
      blooms: 1.26,
      mottleScale: 0.179,
      granulation: 0.768,
      edgeDarkening: 0.688,
      edgeWobble: 0.0034,
      edgeSoftness: 0.42,
      paperTexture: 0.816,
    },
  },

  // Nearly unmodelled: an even dark passage carried entirely by granulation.
  // Best matched by `granulate` - 98.89.
  roundedsquare: {
    '*': {
      shading: 0.196,
      formDepth: 0.5,
      ambientOcclusion: 0.063,
      mottling: 0.144,
      mottleScale: 0.207,
      granulation: 0.216,
      edgeDarkening: 0.119,
      edgeDarkeningWidth: 0.0108,
      edgeWobble: 0.0022,
      edgeCrystal: 0.00088,
      edgeSoftness: 0.803,
      paperTexture: 0.372,
    },
  },
};
