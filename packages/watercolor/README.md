# @watercolor/shapes

Physically-motivated watercolour rendering of SVG shapes. No dependencies; the
core returns raw RGBA and runs in the browser, in a worker, or in Node.

```ts
import { render } from '@watercolor/shapes';

const result = render({
  path: 'M100 12 A88 88 0 1 1 99.9 12 Z',
  color: '#2f5d7c',
  width: 800,
  flavor: 'granulate',
  seed: 42,
});
// result: { width, height, data: Uint8ClampedArray, seed, flavor, timings }
```

Full documentation, including how the renderer works and how it was fitted to
its reference paintings, is in the [repository README](../../README.md).

## Options

```ts
render({
  // --- input: one of these ---
  path,          // a single SVG `d` string
  svg,           // a whole SVG document; every filled shape is painted
  shapes,        // [{ path, color?, gradient?, fillRule?, transform?, opacity? }]

  color,         // fill for shapes that carry none. The colour the wash will
                 // average to, not the neat pigment.
  gradient,      // gradient fill; drives the shading in place of the light
  viewBox,       // coordinate system of the incoming path data

  // --- output ---
  width, height, // pixels
  resolution,    // scale multiplier; a zoom, not a re-roll
  supersample,   // 1-4. 1 for animation, 3 for export
  padding,       // margin as a fraction of the smaller side
  fit,           // 'contain' (default) or 'none'
  background,    // what fills the image: a colour, or null for transparency
  paper,         // the sheet the paint sits on; defaults to `background`
  bakePaper,     // with a transparent background, put the paper behind the
                 // pigment so the result is a flat cut-out rather than a
                 // translucent wash

  // --- look ---
  seed,          // number or string; omit for random, it comes back in the result
  flavor,        // 'wash' | 'granulate' | 'bloom' | 'fluid' | 'drybrush' | 'layered'
  params,        // overrides on the flavor's preset; see PARAM_SPECS
});
```

## Browser helpers

```ts
import { paintToCanvas, toDataURL, toBlob, createRenderer } from '@watercolor/shapes';
```

`createRenderer(canvas)` keeps one `ImageData` alive across frames, which is
what you want for animation.

## Also exported

`parseSvg` (DOM-free, so it behaves identically in Node and the browser), the
Kubelka-Munk primitives (`pigmentFromColor`, `layerRT`, `compositePigment`,
`PigmentLut`), the path flattener and rasteriser (`flattenPath`, `rasterize`,
`signedDistance`), `makePaper`, and `simulateWash` if you want the shallow-water
solver on its own.

## Licence

MIT.
