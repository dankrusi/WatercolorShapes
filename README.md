# Watercolour Shapes

Turn an SVG path and a colour into a physically-motivated watercolour painting
of that shape.

Give it a path and `#ddb07c`; it gives you back a wash that averages to
`#ddb07c` and behaves like paint on paper — crisp along the edge but never
quite on the line, granulating into the tooth, pooling into a dried rim where
the water stalled, and shaded to the form of the shape itself. Everything is
deterministic in a seed, so the same inputs always give the same painting and
stepping the seed gives another take on the same shape.

```
packages/watercolor   @watercolor/shapes — the library (no dependencies)
apps/demo             the interactive demo (Vite)
tools/                reference-fitting and comparison harness
references/           the three paintings the renderer was fitted against
```

## Quick start

```bash
pnpm install
pnpm dev        # interactive demo on http://localhost:5173
pnpm test       # library and demo test suites
pnpm build      # library + demo
pnpm e2e        # browser check of the demo, against a running preview
```

```ts
import { render } from '@watercolor/shapes';

const { data, width, height, seed } = render({
  path: 'M4.5 94 A83.5 91 0 0 1 171.5 94 Z',
  color: '#ddb07c',
  width: 800,
  flavor: 'wash',
  seed: 7,          // omit for a random one; it comes back in the result
});
```

`data` is straight RGBA bytes, so the core runs anywhere. In a browser:

```ts
import { paintToCanvas, createRenderer } from '@watercolor/shapes';

paintToCanvas(myCanvas, { path, color: '#41403c', flavor: 'granulate' });

// For animation, reuse the buffers:
const r = createRenderer(myCanvas);
r.draw({ path, color: '#41403c', seed: Date.now() });
```

## The demo

`pnpm dev`. Drop an SVG anywhere on the page, or pick one of the samples.
Every parameter is a slider, the six algorithms are one click apart, and
**Animate 8fps** steps a random seed eight times a second so you can see the
spread of results a given parameter set produces rather than one sample of it.

Animation renders at a reduced width with supersampling off, because a frame
budget of 125ms is a fraction of what export quality costs. It measures each
frame and trims the pixel count towards the budget on its own; **Live quality**
is the ceiling it works below. Nothing else changes — same seeds, same
parameters — so what you watch is what you export. The size it settled on and
the measured frame rate are both in the footer.

Rendering runs in a worker, so dragging a slider never blocks the page.

### Workspaces

The tab bar holds as many workspaces as you like. Each one is a complete piece
of work — its own SVG, flavor, every parameter, seed and output settings — and
they are kept apart: switching tabs swaps the whole control panel over, and
nothing leaks between them.

- **+** adds one; **×** closes it; the last one cannot be closed.
- Double-click a tab to rename it, or use **Rename**. Until you do, the title
  follows whatever you load into it.
- Right-click a tab (or **Duplicate**) to fork it — handy for trying a second
  flavor against the same shape.

Everything is saved in this browser as you go, SVG included, so a reload picks
up where you left off. Writes are debounced, and storage being full or
unavailable is reported rather than failing silently.

**Export** writes the active workspace to a JSON file; **Import** adds one back
as a new tab. Import never overwrites what you have. Dropping an exported file
onto the page imports it too.

Exports carry *fully resolved* parameters rather than a diff against the flavor
preset — a diff gets silently reinterpreted whenever a preset is retuned, and
these presets were retuned repeatedly while the renderer was being fitted. An
exported workspace should still be the same painting a year later. Everything
arriving from a file or from storage is re-validated: unknown parameters are
dropped, known ones are clamped to the ranges the sliders declare, and one bad
field can never take the app down on start-up.

### Exporting a PNG

The PNG is always transparent outside the shape. **Bake paper** decides what
happens inside it:

- **on** (the default) — the paper colour goes in behind the pigment and the
  alpha channel carries only the silhouette. You get a flat cut-out: opaque
  wherever the shape is, and identical on any background.
- **off** — the wash keeps its real translucency, so it tints whatever ends up
  behind it. Physically truthful, and usually not what you want from an export:
  drop it on a dark page and the painting becomes a colour filter over it.

**Cut-out preview** shows the preview with that transparency, against the
checkerboard, so you can check the export without saving it.

## Input

Any of:

- `path` — a single SVG `d` string
- `svg` — a whole SVG document; every filled shape in it is painted, in order
- `shapes` — an explicit list, each with its own colour, gradient, fill rule,
  transform and opacity

Shapes carrying a **gradient fill** are shaded by that gradient rather than by
an invented light: the gradient's own light-to-dark run becomes the pigment
load, so a radial-gradient sphere comes out modelled the way the artwork asked
for, still granulating and edge-darkening on top. Solid fills get form shading
instead (see below).

## Output

`width` × `height` in pixels, multiplied by `resolution`. `supersample` (1–4)
trades time for edge quality — quadratically, so 1 for animation and 3 for
export.

`background` is what fills the image: a colour, or `null` for transparency.
`paper` is the sheet the paint sits on, which is a different thing — it takes
part in the physics, since the pigment is solved against it and every layer
composites over it. It defaults to `background` when that is a colour, so
asking for transparency changes what surrounds the shape without also changing
the paint.

With `background: null`, `bakePaper` chooses what the alpha channel means. On,
the paper goes in behind the pigment and the alpha is pure silhouette — a
cut-out that looks the same on any backdrop. Off, the alpha is the wash's own
hiding power, so the result stays translucent and tints what is behind it. One
alpha channel cannot carry three wavelength-dependent transmittances, so the
unbaked path picks the alpha that makes compositing over the paper exact in
every channel and degrades towards looking like a cut-out over darker
backdrops.

Changing `resolution` is a **zoom, not a re-roll**: the noise is sampled in
shape-relative coordinates, so rendering at 2× gives you the same painting with
more detail resolved, not a different one. The test suite pins this.

## The six flavors

Each is a different account of how the paint got onto the paper. They share all
the geometry, lighting and colour, and differ only in how pigment ends up
distributed — so switching flavor changes the paint, not the picture.

| flavor | what it is |
| --- | --- |
| `wash` | One graded wash laid wet-on-dry. Long smooth transitions, texture from uneven unloading and from the drying film breaking into islands. |
| `granulate` | A heavy, chalky pigment dropping into the paper tooth. Fine dense speckle whose contrast rises with the pigment load. |
| `bloom` | A wash disturbed while setting. Back-runs strand pigment in hard-rimmed lobes, leaving a patchwork of flat plateaux. |
| `fluid` | A shallow-water fluid simulation — the physical one. Pigment is advected, adsorbed onto the paper, re-dissolved, and wicked through the fibres. |
| `drybrush` | A thirsty brush skipping over the tooth. Broken coverage, ragged edge, paper showing through. |
| `layered` | Several transparent glazes, each drying before the next, building depth where they overlap and leaving its own soft contour. |

## How it works

The pipeline, in order: flatten the path → rasterise exact coverage → build a
signed distance field → displace that field to find the wash boundary → build
the implied form and light it → hand the fields to the chosen flavor, which
returns a pigment *thickness* → composite through Kubelka-Munk onto the paper →
resolve the supersampling.

A few of the decisions that matter most:

**Colour is inverted, not applied.** The colour you pass is what you want the
wash to *look like*, which is a dilute film of something richer. Given the
paper, the renderer solves for the neat pigment and the layer thickness that
composite to exactly your colour, then varies the thickness around that point.
Taking the input as the pigment itself instead puts the nominal thickness on
the flat top of the Kubelka-Munk curve, where a 40% swing in pigment load moves
the output by almost nothing — and granulation, mottling and shading are all
crushed out of the image.

**Kubelka-Munk, not opacity.** Layer reflectance and transmittance come from
the two-constant Kubelka-Munk equations, so a wash gains chroma as it thickens
instead of merely sliding towards black, and glazes compound the way glazes do.

**The edge is displaced, not blurred.** The advancing water front is pinned by
paper fibres and held by surface tension; it lands within a fraction of a
millimetre of the drawn line but never exactly on it. That is reproduced by
displacing the distance field — a blurred edge looks like print, a displaced
one looks like paint. Three terms: a low-frequency wander, a faceted stepping
from cell noise (the short straight runs visible along the references' edges),
and per-fibre pinning from the paper height.

**Shading follows the form.** The interior distance field is treated as a
height map and lit. The profile is mostly a linear ramp with a minority of
sphere: a pure sphere puts 44% of its height in the first tenth of the inset,
so all the shading lands in a thin band at the rim and reads as a vignette
rather than a lit form.

**One paper, shared.** The same height field decides where pigment settles,
where a dry brush skips, where the edge pins, and how much water a cell holds
in the simulation — which is what makes them read as one surface.

## Fitted against the references

`references/` holds three watercolour shapes. Their geometry was measured off
the bitmaps and solved for rather than eyeballed — the rounded diamond is a
137.2px square with a 32.6px corner radius turned 45°, which reproduces the
measured half-width at every sampled row to within a pixel.

`tools/compare.py` scores a render against a reference on the things that
actually separate a wash from a flat fill — coverage, tone and its spread, ink
colour and saturation, how texture energy is distributed across spatial scales,
the density profile against distance from the edge, and the 20–80% edge rise
distance. Per-pixel difference would be meaningless here: the noise is
*supposed* to differ.

`tools/search.py` fits parameters by coordinate descent against that score,
averaged over several seeds so the fit describes the distribution a parameter
set produces rather than one lucky noise field.

```bash
pnpm refs                                              # render every flavor
pnpm compare                                           # score them
python tools/search.py --case halfcircle1 --flavor wash
```

Best fit per reference, out of 100 — the fit is scored on the seeds it was
fitted with, and held out on three it has never seen:

| reference | flavor | fitted | held out |
| --- | --- | --- | --- |
| `halfcircle1` | `wash` | 98.0 | 96.9 – 97.4 |
| `halfcircle2` | `bloom` | 98.0 | 95.3 – 97.3 |
| `roundedsquare` | `granulate` | 98.9 | 97.6 – 98.5 |

Whatever all three fits agreed on was promoted into the library defaults; what
is left in `tools/tuning.mjs` is genuinely per-painting — how strongly each one
is modelled, how coarse its patches are, which way its light comes from.

Those overrides are *deltas*, so any parameter a fit inherited rather than set
moves underneath it whenever a default moves. Retuning the defaults therefore
means re-running the search, not just re-reading the score.

## Performance

Numbers from `pnpm bench` on the development machine, per frame, on a square
shape (the worst case for a given width):

| | wash | granulate | bloom | fluid | drybrush | layered |
| --- | --- | --- | --- | --- | --- | --- |
| 384px ss1 (animation) | 116ms | 79ms | 67ms | 522ms | 80ms | 91ms |
| 640px ss1 | 287ms | 184ms | 192ms | 659ms | 166ms | 197ms |
| 640px ss2 (default) | 752ms | 640ms | 674ms | 1011ms | 586ms | 686ms |
| 1024px ss3 (export) | 4.9s | 4.3s | 4.6s | 4.1s | 4.1s | 5.5s |

8fps means a 125ms budget, which no single fixed setting can meet across every
shape, flavor and machine — `fluid` alone is five times dearer than `bloom`. So
the demo measures the frame that just finished and trims the pixel count
towards the budget, degrading resolution rather than frame rate. The size it
settles on is in the footer.

The first version was 18 seconds at 512px. Three things fixed that: sampling
each texture on a grid matched to the finest scale it actually carries rather
than at every supersampled pixel, replacing the trigonometry in the gradient
noise with a direction table, and caching the rasterisation and distance
transform, which depend only on the geometry and so survive both a slider drag
and a seed step.

`fluid` is the outlier by design — it is running a fluid simulation. Lower
`fluidSteps` if you want it in an animation.

## API

`render(options)` is the whole surface. See `packages/watercolor/src/types.ts`
for every option and parameter, each documented in place; `PARAM_SPECS` carries
the slider metadata the demo builds its panel from, so the two cannot drift
apart. Also exported: `parseSvg`, the Kubelka-Munk primitives, the path
flattener and rasteriser, the paper generator, and `simulateWash` if you want
the fluid solver on its own.

## Licence

MIT.
