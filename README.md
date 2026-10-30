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
  src/scenes/         animations: shapes as a function of time (the growing plant)
apps/demo             the interactive demo (Vite)
tools/                reference-fitting, comparison and scene-rendering harness
references/           the three paintings the renderer was fitted against
```

## Quick start

```bash
pnpm install
pnpm dev        # interactive demo on http://localhost:5173
pnpm test       # library and demo test suites
pnpm build      # library + demo
pnpm e2e        # browser check of the demo, against a running preview
pnpm scene      # render the plant animation's frames to out-scene/
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

### Animations

Under **Animations** in the Source menu is **Plant growing**: a ten-second
scene in which a seed swells, puts a pale root down and a hooked shoot up,
rides the shoot a little way and is shed; the shoot straightens into a stem
while the taproot branches and branches again; a bud at the tip opens into a
large ochre leaf, then a dark leaf and a small pale one open lower down; and
the last second holds on the finished plant.

A scene is drawn afresh at every moment as a list of shapes - a hundred of
them by the end, each root, leaf and vein its own stroke in its own shade -
and that list goes through the renderer exactly as an SVG does. The flavor,
every slider, the paper, the seed: all of it applies to the whole frame, and
all of the frame's shapes are washes on one sheet. Where strokes cross they
glaze, the paper goes in once underneath them all, and the paper grain goes
on once over them all at the end.

The **Animation** group appears when a scene is loaded:

- **Time** scrubs through the scene. The footer shows which export frame
  that moment falls on.
- **Play** steps through the export frames in order, each rendered at full
  quality - exactly what the export will write. It holds the scene's own pace
  on a machine that can render that fast and simply runs slower on one that
  cannot; nothing is trimmed and no frame is skipped. The footer's fps shows
  the pace it is managing.
- **frames** is how many frames an export writes, spread evenly from the
  start to the end; the last frame is always the finished scene. 120 frames
  of a 10 s scene is 12 fps, 240 is 24 fps. The group shows the rate.
- **repaint every** holds each paint seed for that many frames. 1 repaints
  every frame, the hand-drawn boil the seed animation has; 2 or 3 at 24 fps
  gives the look of animation drawn on twos or threes.
- **Layout seed** moves what the scene leaves to chance - where the roots
  branch - without touching the paint. The stem and the three leaves are
  drawn to a reference and do not move.
- Below those, the scene's own knobs: how many main roots leave the crown,
  how much they branch, how wide and how deep they go, the stem height, how
  many of the three leaves open, their size, the strength of the veins, and
  **root stability**: at 1 the roots hold still; lower, they are redrawn a
  little differently each time the paint seed changes, so they boil with the
  paint on the same *repaint every* cadence, the tips most and the crown not
  at all. A scene declares these as slider metadata, so the panel is built
  from them and they travel with the workspace; **Reset plant** puts them
  back.

**Save animation frames…** asks for a folder and renders the whole scene at
export quality, one numbered PNG per frame, transparent outside the painting
with Bake paper honoured inside it. It renders at full quality, one frame at a
time, so a long sequence at a large size takes a while; the status line
counts the frames and the button cancels. Assemble the sequence with
anything that reads numbered files, for example:

```bash
ffmpeg -framerate 12 -i plant-growing-wash-%04d.png -c:v libvpx-vp9 -pix_fmt yuva420p plant.webm
```

Every one of these settings is part of the workspace, so it is saved, exported
and imported with everything else. A workspace that names a scene this build
does not have falls back to its SVG rather than to an empty stage.

The same thing from the command line, with a contact sheet to check the motion
at a glance:

```bash
node --import tsx tools/render-scene.ts --frames 24 --width 480 --contact 6 --out out-scene
```

A scene is a small object - an id, a viewBox, a duration, and a pure function
from a time in 0..1 to a shape list - so another one is a file in
`packages/watercolor/src/scenes/` and an entry in its registry. The stroke
helpers that outline a centreline with a width profile are exported too.

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

Two optional fields matter for shapes that change between frames. A shape's
paint is normally seeded from its position in the list, so adding one ahead
of it repaints it; `seed` gives a shape a seed of its own, stable for as long
as the render seed is held. And the texture is normally scaled to the shape's
bounding box, so a growing shape's mottling zooms with it and its edge crawls;
`noiseSize` pins that scale, in the shape's own units, to what the shape will
finally be. The plant scene sets both on every stroke.

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

**One sheet, many washes.** A frame of any number of shapes is painted onto a
single sheet in order. Each shape is worked in a window just large enough to
hold it and every effect that reaches past its outline, and its textures are
evaluated only where its paint will land, so the cost of a frame follows the
paint rather than the paper: a hundred root hairs cost a hundred root hairs,
not a hundred canvases. Later washes composite through Kubelka-Munk against
whatever the earlier ones left, and against the lookup table wherever the
paper is still bare. The paper colour goes in once underneath everything and
the grain once over it, at the end.

**Thin shapes are not small discs.** The edge effects are scaled to the shape
size, and the bounding box of a root hair or a stroke of lettering says it is
large. Scaled to that, the wobble is wider than the shape and breaks it into
beads. Below a quarter inscribed-diameter-to-size, the edge effects scale down
with the square root of that ratio instead; every solid shape sits above the
knee and is untouched.

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

A frame of the finished plant - 99 strokes, most of them a few pixels wide -
is about 1.1 s at 640px ss2 and 0.4 s at the demo's live size, which is what
the per-shape windows and the masked texture evaluation buy: the same frame
cost 3 s and 1.5 s with every shape textured across its whole window, and
would cost a hundred times a single shape without the windows. A full export
of 120 frames at 1024px ss2 is a coffee's worth of waiting, by design: it
renders at full quality, one frame at a time.

## API

`render(options)` is the whole surface. See `packages/watercolor/src/types.ts`
for every option and parameter, each documented in place; `PARAM_SPECS` carries
the slider metadata the demo builds its panel from, so the two cannot drift
apart. Also exported: `parseSvg`, the Kubelka-Munk primitives, the path
flattener and rasteriser, the paper generator, and `simulateWash` if you want
the fluid solver on its own.

Scenes: `SCENES`, `getScene(id)`, `plantScene` and the `Scene` type, plus the
stroke helpers (`strokePath`, `cubicBezier`, `arcLengths`, `pointAlong`,
`cutPolyline`, `bendTip`, `ovoid`) for building more. A frame is
`render({ shapes: scene.frame(t, layoutSeed), viewBox: scene.viewBox, ... })`.

## Licence

MIT.
