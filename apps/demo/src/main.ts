/**
 * Watercolour Shapes - interactive demo.
 *
 * Drop in an SVG, watch it repaint as you move the sliders, and step the seed
 * to see the spread of results one parameter set produces. Rendering happens
 * in a worker; this file owns the workspace session, the control panel, and
 * the animation clock.
 *
 * Every control is registered in `syncControls` as well as being built, so
 * that switching workspaces pushes the new state back into all of them. A
 * control that can be driven but not read back is the standard way a tabbed
 * editor ends up showing one workspace's settings over another's painting.
 */

import {
  BASE_PARAMS,
  FLAVORS,
  FLAVOR_INFO,
  getScene,
  normalizeSeed,
  PARAM_SPECS,
  parseSvg,
  resolveParams,
  resolveSceneOptions,
  SCENES,
  type Flavor,
  type ParamGroup,
  type RenderOptions,
  type Scene,
  type ShapeInput,
  type WatercolorParams,
} from '@watercolor/shapes';

import { button, el, group, slider, subgroup, toggle, type SliderHandle } from './controls.js';
import { SAMPLES } from './samples.js';
import type { RenderError, RenderRequest, RenderResponse } from './render.worker.js';
import { createTabBar } from './tabbar.js';
import {
  cloneWorkspace,
  createWorkspace,
  exportFileName,
  exportWorkspace,
  isSvgSource,
  MAX_FRAMES,
  MAX_REPAINT,
  MAX_SVG_CHARS,
  parseImport,
  WorkspaceError,
  WorkspaceStore,
  type Session,
  type Workspace,
} from './workspaces.js';
import './style.css';

/** Labels of the frame-sequence export button while it is idle. */
const FRAMES_LABEL = 'Save PNG frames…';
const ANIMATION_FRAMES_LABEL = 'Save animation frames…';

/** Frames per second for the animated mode. */
const ANIMATION_FPS = 8;
const FRAME_BUDGET_MS = 1000 / ANIMATION_FPS;

// --------------------------------------------------------------- session --

const store = new WorkspaceStore((message) => {
  if (message) showError(message);
});

const session: Session = store.load() ?? {
  version: 1,
  workspaces: [createWorkspace(0)],
  activeId: '',
};
if (!session.workspaces.some((w) => w.id === session.activeId)) {
  session.activeId = session.workspaces[0].id;
}

function active(): Workspace {
  return session.workspaces.find((w) => w.id === session.activeId) ?? session.workspaces[0];
}

/** Record a change to the active workspace and schedule a save. */
function edit(fn: (ws: Workspace) => void): void {
  fn(active());
  store.save(session);
}

// Animation is a property of the session you are in, not of the painting you
// are making, so it is deliberately not part of a workspace. The same goes
// for a scene being played: the workspace remembers where in the scene you
// are, not whether it was moving.
let animating = false;
let playing = false;

/**
 * Whether frames are being produced on a clock. Only the seed animation
 * trims its quality to hold its rate; a playing scene renders every frame at
 * full quality and takes as long as that takes.
 */
function live(): boolean {
  return animating || playing;
}

// ---------------------------------------------------------------- layout --

const app = document.getElementById('app')!;

const canvas = el('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const canvasWrap = el('div', { class: 'canvas-wrap' }, [canvas]);

const statSize = el('b', {}, ['-']);
const statTime = el('b', {}, ['-']);
const statFps = el('b', {}, ['-']);
const statSeed = el('b', {}, ['-']);
const statShapes = el('b', {}, ['-']);
const statFrame = el('b', {}, ['-']);
const statFrameWrap = el('span', {}, ['frame ', statFrame]);
const errLine = el('p', { class: 'err' });
errLine.style.display = 'none';

const stageTitle = el('h1', {}, ['']);
const stageSource = el('p', {}, ['']);

const stage = el('div', { class: 'stage' }, [
  el('div', { class: 'stage-head' }, [stageTitle, stageSource]),
  canvasWrap,
  el('div', { class: 'stage-foot' }, [
    el('span', {}, ['size ', statSize]),
    el('span', {}, ['render ', statTime]),
    el('span', {}, ['fps ', statFps]),
    el('span', {}, ['seed ', statSeed]),
    el('span', {}, ['shapes ', statShapes]),
    statFrameWrap,
  ]),
  errLine,
  el('div', { class: 'drop-hint' }, ['Release to load']),
]);

const panel = el('aside', { class: 'panel' });

const tabBar = createTabBar({
  onSelect: (id) => setActiveWorkspace(id),
  onAdd: addWorkspace,
  onClose: closeWorkspace,
  onRename: (id, title) => {
    const ws = session.workspaces.find((w) => w.id === id);
    if (!ws) return;
    ws.title = title;
    ws.titleAuto = false;
    store.save(session);
    refreshTabs();
    syncHeader();
  },
  onDuplicate: (id) => {
    const ws = session.workspaces.find((w) => w.id === id);
    if (ws) duplicateWorkspace(ws);
  },
  onImport: () => importInput.click(),
  onExport: exportActive,
});

app.append(tabBar.root, stage, panel);

// ---------------------------------------------------------------- worker --

const worker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' });

let nextId = 1;
let inFlight = 0;
/** Set when a render is requested while one is already running. */
let pendingRender = false;
let lastFrameAt = 0;
let fpsAvg = 0;
/**
 * Automatic quality trim while animating, on top of the `liveQuality` ceiling.
 *
 * A fixed reduction cannot hold the frame rate: the cost depends on the
 * shape's aspect, the flavor and the machine, and `fluid` is an order of
 * magnitude dearer than `bloom`. Measuring the frame that just finished and
 * nudging the pixel count keeps the rate where it can be held, and degrades
 * resolution rather than frame rate where it cannot.
 */
let liveScale = 1;

// A worker that fails to load or throws during module evaluation is otherwise
// completely silent: the page just never paints.
worker.addEventListener('error', (ev) => {
  showError(`Render worker failed: ${ev.message || 'unknown error'}`);
  inFlight = 0;
});
worker.addEventListener('messageerror', () => {
  showError('Render worker sent a message that could not be deserialised.');
  inFlight = 0;
});

worker.addEventListener('message', (ev: MessageEvent<RenderResponse | RenderError>) => {
  const msg = ev.data;
  if (msg.id !== inFlight) return;
  inFlight = 0;
  if (!msg.ok) {
    showError(msg.message);
    return;
  }
  showError(null);
  paint(msg);
  if (animating) {
    const ms = msg.timings.total ?? 0;
    if (ms > FRAME_BUDGET_MS * 0.9) liveScale = Math.max(0.3, liveScale * 0.85);
    else if (ms < FRAME_BUDGET_MS * 0.55) liveScale = Math.min(1, liveScale * 1.06);
  }
  const now = performance.now();
  // Only meaningful while animating: between two manual renders the gap is
  // however long you took to move the slider, which is not a frame rate.
  if (live() && lastFrameAt) {
    const fps = 1000 / Math.max(1, now - lastFrameAt);
    // Smoothed, because a single frame's timing bounces around too much to read.
    fpsAvg = fpsAvg ? fpsAvg * 0.75 + fps * 0.25 : fps;
    statFps.textContent = fpsAvg.toFixed(1);
  }
  lastFrameAt = now;
  if (pendingRender) {
    pendingRender = false;
    requestRender();
  }
});

function paint(msg: RenderResponse): void {
  if (canvas.width !== msg.width || canvas.height !== msg.height) {
    canvas.width = msg.width;
    canvas.height = msg.height;
  }
  // Pin the displayed size to the configured output size regardless of what
  // the frame was actually rendered at, so entering animated mode softens the
  // preview instead of visibly shrinking it.
  const shown = active().width;
  const displayH = Math.round((shown * msg.height) / Math.max(1, msg.width));
  canvas.style.width = `${shown}px`;
  canvas.style.height = `${displayH}px`;
  const image = new ImageData(new Uint8ClampedArray(msg.data), msg.width, msg.height);
  ctx.putImageData(image, 0, 0);
  statSize.textContent = `${msg.width}x${msg.height}`;
  statTime.textContent = `${Math.round(msg.timings.total ?? 0)}ms`;
  statSeed.textContent = String(msg.seed);
}

function showError(message: string | null): void {
  errLine.classList.remove('info');
  if (message) {
    errLine.textContent = message;
    errLine.style.display = '';
  } else {
    errLine.style.display = 'none';
  }
}

/** Progress and outcomes, on the same line as errors but not in red. */
function showStatus(message: string): void {
  showError(message);
  errLine.classList.add('info');
}

// ---------------------------------------------------------------- render --

/** The scene a workspace is showing, if it is showing one. */
function sceneOf(ws: Workspace): Scene | null {
  return ws.mode === 'scene' ? (getScene(ws.scene) ?? null) : null;
}

/** Which frame of an export the preview time falls on. */
function frameIndexOf(time: number, frameCount: number): number {
  return Math.round(time * Math.max(0, frameCount - 1));
}

/**
 * The paint seed for one frame of an animation: the workspace seed, stepped
 * once per `repaintEvery` frames. Derived rather than incremented so any frame
 * can be re-rendered on its own, and so the preview at a given time shows the
 * exact frame the export will write.
 */
function frameSeed(ws: Workspace, frameIndex: number): number {
  return normalizeSeed(`${ws.seed}:frame:${Math.floor(frameIndex / Math.max(1, ws.repaintEvery))}`);
}

/** The shapes, viewBox and seed for a frame of a workspace. */
function frameInput(
  ws: Workspace,
  time: number,
  frameIndex: number,
): { shapes: ShapeInput[]; viewBox: RenderOptions['viewBox']; seed: number } {
  const scene = sceneOf(ws);
  let shapes: ShapeInput[];
  let viewBox: RenderOptions['viewBox'];
  let seed = ws.seed;
  if (scene) {
    seed = frameSeed(ws, frameIndex);
    shapes = scene.frame(time, ws.layoutSeed, ws.sceneOptions, seed);
    viewBox = scene.viewBox;
  } else {
    const parsed = parseSvg(ws.svg);
    shapes = parsed.shapes;
    viewBox = parsed.viewBox ?? undefined;
  }
  if (ws.overrideColor) {
    // Strip whatever the source said, so the picker is authoritative.
    shapes = shapes.map((s) => ({ ...s, color: ws.color, gradient: undefined }));
  }
  return { shapes, viewBox, seed };
}

function buildOptions(overrides: Partial<RenderOptions> = {}): RenderOptions {
  const ws = active();
  const index = frameIndexOf(ws.time, ws.frameCount);
  const { shapes, viewBox, seed } = frameInput(ws, ws.time, index);
  statShapes.textContent = String(shapes.length);
  const scene = sceneOf(ws);
  statFrameWrap.style.display = scene ? '' : 'none';
  if (scene) {
    statFrame.textContent = `${index + 1}/${ws.frameCount} (${(ws.time * scene.duration).toFixed(2)}s)`;
  }
  // Animation renders at a reduced quality. The frame budget is not negotiable
  // if the mode is to run at its stated rate, and at export quality a single
  // frame costs several times that; cutting pixels is the only lever that does
  // not change what the image *is*. The seed sequence and every parameter stay
  // identical, so what you watch is what you will export.
  const trimmed = animating && overrides.width === undefined;
  const width = trimmed ? Math.max(96, Math.round(ws.width * ws.liveQuality * liveScale)) : ws.width;
  return {
    shapes,
    viewBox,
    color: ws.color,
    width,
    supersample: trimmed ? 1 : ws.supersample,
    padding: ws.padding,
    paper: ws.paper,
    background: ws.previewTransparent ? null : ws.paper,
    bakePaper: ws.bakePaper,
    seed,
    flavor: ws.flavor,
    params: ws.params,
    ...overrides,
  };
}

function requestRender(): void {
  if (inFlight) {
    // Coalesce: one render in flight, at most one queued. Queuing every slider
    // event instead would build a backlog and make the UI lag further behind
    // the further you drag.
    pendingRender = true;
    return;
  }
  let options: RenderOptions;
  try {
    options = buildOptions();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    return;
  }
  inFlight = nextId++;
  worker.postMessage({ id: inFlight, options } satisfies RenderRequest);
}

// ------------------------------------------------------------- animation --

let animTimer: number | null = null;

function setAnimating(on: boolean): void {
  animating = on;
  if (animTimer !== null) {
    clearInterval(animTimer);
    animTimer = null;
  }
  liveScale = 1;
  if (!on) {
    fpsAvg = 0;
    lastFrameAt = 0;
    statFps.textContent = '-';
    // Back to full quality now that the frame budget no longer applies.
    requestRender();
    return;
  }
  requestRender();
  animTimer = window.setInterval(() => {
    // Skip the tick entirely if the previous frame has not landed. Queuing it
    // would only push the backlog further out; dropping keeps the seed
    // stepping in real time at whatever rate the machine can actually manage.
    if (inFlight) return;
    edit((ws) => {
      ws.seed = (Math.random() * 0xffffffff) >>> 0;
    });
    seedField.value = String(active().seed);
    requestRender();
  }, FRAME_BUDGET_MS);
}

// -------------------------------------------------------------- playback --

let playTimer: number | null = null;
/** When the frame now showing (or rendering) was asked for. */
let playRequestedAt = 0;
/** Pause on the finished scene before it starts over. */
const LOOP_HOLD_MS = 900;

/**
 * Play the scene: step through its export frames in order, each rendered at
 * full quality - exactly the frames an export would write. The next frame is
 * asked for when the previous one has landed and the scene's own frame
 * interval has passed, so playback holds the stated pace on a machine that
 * can render that fast and simply runs slower on one that cannot. No frame
 * is ever skipped and nothing is ever trimmed.
 */
function setPlaying(on: boolean): void {
  playing = on;
  playToggle.set(on);
  if (playTimer !== null) {
    clearInterval(playTimer);
    playTimer = null;
  }
  liveScale = 1;
  if (!on) {
    fpsAvg = 0;
    lastFrameAt = 0;
    statFps.textContent = '-';
    return;
  }
  // Pressing play on the finished scene starts it over.
  if (active().time >= 0.999) {
    edit((ws) => {
      ws.time = 0;
    });
    timeSlider.set(0);
  }
  playRequestedAt = performance.now();
  requestRender();
  playTimer = window.setInterval(() => {
    if (inFlight) return;
    const ws = active();
    const scene = sceneOf(ws);
    if (!scene) {
      setPlaying(false);
      return;
    }
    const count = Math.max(1, ws.frameCount);
    const interval = (scene.duration * 1000) / Math.max(1, count - 1);
    const since = performance.now() - playRequestedAt;
    let index = frameIndexOf(ws.time, count) + 1;
    if (index >= count) {
      if (since < interval + LOOP_HOLD_MS) return;
      index = 0;
    } else if (since < interval) {
      return;
    }
    const t = count > 1 ? index / (count - 1) : 1;
    edit((w) => {
      w.time = t;
    });
    timeSlider.set(t);
    playRequestedAt = performance.now();
    requestRender();
  }, 25);
}

// ------------------------------------------------------------ workspaces --

function refreshTabs(): void {
  tabBar.render(session.workspaces, session.activeId);
}

function syncHeader(): void {
  const ws = active();
  stageTitle.textContent = ws.title;
  const scene = sceneOf(ws);
  if (scene) {
    stageSource.textContent = scene.name === ws.title ? scene.blurb : `${scene.name} — ${scene.blurb}`;
    return;
  }
  // The source line is only worth the space when it says something the title
  // does not, which it does not while the title is still following the source.
  const redundant = ws.sourceName.replace(/\.svg$/i, '') === ws.title;
  stageSource.textContent = redundant ? '' : ws.sourceName;
}

function setActiveWorkspace(id: string): void {
  if (!session.workspaces.some((w) => w.id === id)) return;
  session.activeId = id;
  store.save(session);
  // Anything queued belongs to the workspace you just left, and so does a
  // scene that was playing: time is the workspace's, the clock is not.
  pendingRender = false;
  liveScale = 1;
  if (playing) setPlaying(false);
  refreshTabs();
  syncControls();
  requestRender();
}

function addWorkspace(): void {
  const ws = createWorkspace(0, `Workspace ${session.workspaces.length + 1}`);
  ws.titleAuto = true;
  session.workspaces.push(ws);
  setActiveWorkspace(ws.id);
}

function duplicateWorkspace(ws: Workspace): void {
  const copy = cloneWorkspace(ws);
  session.workspaces.splice(session.workspaces.indexOf(ws) + 1, 0, copy);
  setActiveWorkspace(copy.id);
}

function closeWorkspace(id: string): void {
  const index = session.workspaces.findIndex((w) => w.id === id);
  // Always leave one: an empty tab bar has no way back.
  if (index < 0 || session.workspaces.length <= 1) return;
  session.workspaces.splice(index, 1);
  if (session.activeId === id) {
    setActiveWorkspace(session.workspaces[Math.min(index, session.workspaces.length - 1)].id);
  } else {
    store.save(session);
    refreshTabs();
  }
}

function adoptSource(svg: string, sourceName: string, color?: string): void {
  if (playing) setPlaying(false);
  edit((ws) => {
    ws.mode = 'svg';
    ws.svg = svg;
    ws.sourceName = sourceName;
    if (color) ws.color = color;
    // An auto title follows the source; once you have named the tab it is
    // yours, and loading a different file will not quietly rename it.
    if (ws.titleAuto) ws.title = sourceName.replace(/\.svg$/i, '');
  });
  refreshTabs();
  syncControls();
  requestRender();
}

/** Switch the workspace to a scene. Its SVG is kept, so picking a sample again loses nothing. */
function adoptScene(scene: Scene): void {
  if (playing) setPlaying(false);
  edit((ws) => {
    ws.mode = 'scene';
    if (ws.scene !== scene.id) ws.sceneOptions = resolveSceneOptions(scene.options);
    ws.scene = scene.id;
    ws.sourceName = scene.name;
    if (ws.titleAuto) ws.title = scene.name;
  });
  refreshTabs();
  syncControls();
  requestRender();
}

// --------------------------------------------------------- import/export --

function exportActive(): void {
  const ws = active();
  const blob = new Blob([JSON.stringify(exportWorkspace(ws), null, 2)], {
    type: 'application/json',
  });
  download(blob, exportFileName(ws));
}

async function importFiles(files: File[]): Promise<void> {
  let lastId: string | null = null;
  let added = 0;
  for (const file of files) {
    try {
      for (const ws of parseImport(await file.text())) {
        // Imports always arrive as new workspaces. Replacing the active one
        // would make a mis-click destructive, and there is no undo here.
        session.workspaces.push(ws);
        lastId = ws.id;
        added++;
      }
    } catch (err) {
      showError(
        err instanceof WorkspaceError
          ? `${file.name}: ${err.message}`
          : `${file.name}: could not be imported.`,
      );
      return;
    }
  }
  if (lastId) {
    setActiveWorkspace(lastId);
    showError(added > 1 ? `Imported ${added} workspaces.` : null);
  }
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------------------ panel --

const sliders = new Map<keyof WatercolorParams, SliderHandle>();
const flavorButtons = new Map<Flavor, HTMLButtonElement>();
const flavorBlurb = el('p', { class: 'blurb' });

function setFlavor(f: Flavor, resetParams: boolean): void {
  edit((ws) => {
    ws.flavor = f;
    if (resetParams) ws.params = resolveParams(f);
  });
  syncFlavorControls();
  requestRender();
}

function syncFlavorControls(): void {
  const ws = active();
  flavorButtons.forEach((b, f) => b.setAttribute('aria-pressed', String(f === ws.flavor)));
  flavorBlurb.textContent = FLAVOR_INFO[ws.flavor].blurb;
  for (const [key, handle] of sliders) handle.set(ws.params[key]);
  updateParamVisibility();
}

const flavorGrid = el('div', { class: 'flavors' });
for (const f of FLAVORS) {
  const b = button(FLAVOR_INFO[f].label, () => setFlavor(f, true), 'toggle');
  b.title = FLAVOR_INFO[f].blurb;
  flavorButtons.set(f, b);
  flavorGrid.append(b);
}

// --- source ---------------------------------------------------------------

const fileInput = el('input', { type: 'file', accept: '.svg,image/svg+xml' }) as HTMLInputElement;
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void loadFile(f);
  // Cleared so re-picking the same file fires `change` again.
  fileInput.value = '';
});

const importInput = el('input', {
  type: 'file',
  accept: '.json,application/json',
  multiple: '',
}) as HTMLInputElement;
importInput.addEventListener('change', () => {
  if (importInput.files?.length) void importFiles(Array.from(importInput.files));
  importInput.value = '';
});

const CUSTOM_OPTION = '— uploaded —';
const SCENE_PREFIX = 'scene:';
const sampleSelect = el('select') as HTMLSelectElement;
sampleSelect.append(el('option', { value: CUSTOM_OPTION, disabled: '' }, [CUSTOM_OPTION]));
const shapeGroup = el('optgroup', { label: 'Shapes' });
for (const s of SAMPLES) shapeGroup.append(el('option', { value: s.name }, [s.name]));
const sceneGroup = el('optgroup', { label: 'Animations' });
for (const sc of SCENES) sceneGroup.append(el('option', { value: SCENE_PREFIX + sc.id }, [sc.name]));
sampleSelect.append(shapeGroup, sceneGroup);
sampleSelect.addEventListener('change', () => {
  const v = sampleSelect.value;
  if (v.startsWith(SCENE_PREFIX)) {
    const sc = getScene(v.slice(SCENE_PREFIX.length));
    if (sc) adoptScene(sc);
    return;
  }
  const s = SAMPLES.find((x) => x.name === v);
  if (s) adoptSource(s.svg, s.name, s.color);
});

async function loadFile(file: File): Promise<void> {
  try {
    const text = await file.text();
    // Dropping an exported workspace should import it rather than fail as a
    // malformed SVG.
    if (/\.json$/i.test(file.name) || text.trimStart().startsWith('{')) {
      await importFiles([file]);
      return;
    }
    if (!isSvgSource(text)) throw new WorkspaceError('That file does not look like an SVG.');
    if (text.length > MAX_SVG_CHARS) {
      throw new WorkspaceError(
        `That SVG is ${Math.round(text.length / 1000)}kB, over the ${Math.round(
          MAX_SVG_CHARS / 1000,
        )}kB a workspace can store.`,
      );
    }
    if (parseSvg(text).shapes.length === 0) {
      throw new WorkspaceError(
        'No filled shapes found in that SVG. Strokes alone cannot be washed.',
      );
    }
    showError(null);
    adoptSource(text, file.name);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

const colorInput = el('input', { type: 'color' }) as HTMLInputElement;
colorInput.addEventListener('input', () => {
  edit((ws) => {
    ws.color = colorInput.value;
  });
  if (active().overrideColor) requestRender();
});

const paperInput = el('input', { type: 'color' }) as HTMLInputElement;
paperInput.addEventListener('input', () => {
  edit((ws) => {
    ws.paper = paperInput.value;
  });
  requestRender();
});

const seedField = el('input', { type: 'number', min: '0', step: '1', 'aria-label': 'Seed' }) as HTMLInputElement;
seedField.style.width = '108px';
seedField.addEventListener('change', () => {
  const v = Number(seedField.value);
  if (!Number.isFinite(v)) return;
  edit((ws) => {
    ws.seed = v >>> 0;
  });
  requestRender();
});

// --- controls -------------------------------------------------------------

const animateToggle = toggle(`Animate ${ANIMATION_FPS}fps`, false, setAnimating);

const overrideToggle = toggle('Override fill', false, (on) => {
  edit((ws) => {
    ws.overrideColor = on;
  });
  requestRender();
});

const bakeToggle = toggle(
  'Bake paper',
  true,
  (on) => {
    edit((ws) => {
      ws.bakePaper = on;
    });
    if (active().previewTransparent) requestRender();
  },
  'Put the paper colour behind the pigment, so the export is a flat cut-out',
);

const previewTransparentToggle = toggle(
  'Cut-out preview',
  false,
  (on) => {
    edit((ws) => {
      ws.previewTransparent = on;
    });
    requestRender();
  },
  'Preview the transparency the PNG will be exported with',
);

const widthSlider = slider({
  label: 'Width',
  min: 128,
  max: 2048,
  step: 16,
  value: 640,
  onInput: (v) => {
    edit((ws) => {
      ws.width = v;
    });
    requestRender();
  },
});

const supersampleSlider = slider({
  label: 'Supersampling',
  min: 1,
  max: 4,
  step: 1,
  value: 2,
  hint: 'Cost grows with the square. 1 for animation, 3 for export.',
  onInput: (v) => {
    edit((ws) => {
      ws.supersample = v;
    });
    requestRender();
  },
});

const paddingSlider = slider({
  label: 'Padding',
  min: 0,
  max: 0.3,
  step: 0.005,
  value: 0.06,
  onInput: (v) => {
    edit((ws) => {
      ws.padding = v;
    });
    requestRender();
  },
});

const framesButton = button(FRAMES_LABEL, () => void savePngFrames());

const timeSlider = slider({
  label: 'Time',
  min: 0,
  max: 1,
  step: 0.001,
  value: 1,
  hint: 'Where in the scene the preview sits. The export spreads its frames evenly over this range',
  format: (v) => {
    const scene = sceneOf(active());
    return scene ? `${(v * scene.duration).toFixed(2)}s` : v.toFixed(3);
  },
  onInput: (v) => {
    if (playing) setPlaying(false);
    edit((ws) => {
      ws.time = v;
    });
    requestRender();
  },
});

const playToggle = toggle(
  'Play',
  false,
  setPlaying,
  'Step through the export frames at full quality, looping; as fast as the scene runs if the machine can, slower if not',
);

function numberField(
  label: string,
  min: number,
  max: number,
  width: string,
  onChange: (v: number) => void,
): HTMLInputElement {
  const input = el('input', {
    type: 'number',
    min: String(min),
    max: String(max),
    step: '1',
    'aria-label': label,
  }) as HTMLInputElement;
  input.style.width = width;
  input.addEventListener('change', () => {
    const v = Math.round(Number(input.value));
    if (!Number.isFinite(v)) return;
    const clamped = Math.min(max, Math.max(min, v));
    input.value = String(clamped);
    onChange(clamped);
  });
  return input;
}

const framesField = numberField('Frames', 1, MAX_FRAMES, '76px', (v) => {
  edit((ws) => {
    ws.frameCount = v;
  });
  syncModeControls();
  requestRender();
});

const repaintField = numberField('Repaint every', 1, MAX_REPAINT, '60px', (v) => {
  edit((ws) => {
    ws.repaintEvery = v;
  });
  requestRender();
});

const layoutSeedField = numberField('Layout seed', 0, 0xffffffff, '96px', (v) => {
  edit((ws) => {
    ws.layoutSeed = v;
  });
  requestRender();
});

const frameRate = el('span', { class: 'hint-inline' }, ['']);

// The scene's own knobs, built from the metadata it declares, the same way
// the renderer's sliders are built from PARAM_SPECS.
const sceneOptionBox = el('div', { class: 'scene-options' });
const sceneOptionSliders = new Map<string, SliderHandle>();
let builtOptionsFor: string | null = null;

function buildSceneOptions(scene: Scene): void {
  if (builtOptionsFor === scene.id) return;
  builtOptionsFor = scene.id;
  sceneOptionSliders.clear();
  sceneOptionBox.replaceChildren();
  const specs = scene.options ?? [];
  if (specs.length === 0) return;
  const ws = active();
  for (const spec of specs) {
    const handle = slider({
      label: spec.label,
      min: spec.min,
      max: spec.max,
      step: spec.step,
      value: ws.sceneOptions[spec.key] ?? spec.default,
      hint: spec.hint,
      onInput: (v) => {
        edit((w) => {
          w.sceneOptions = { ...w.sceneOptions, [spec.key]: v };
        });
        requestRender();
      },
    });
    sceneOptionSliders.set(spec.key, handle);
    sceneOptionBox.append(handle.root);
  }
  sceneOptionBox.append(
    el('div', { class: 'row' }, [
      button('Reset plant', () => {
        edit((w) => {
          w.sceneOptions = resolveSceneOptions(scene.options);
        });
        syncModeControls();
        requestRender();
      }),
    ]),
  );
}

function seekTo(time: number): void {
  if (playing) setPlaying(false);
  edit((ws) => {
    ws.time = time;
  });
  timeSlider.set(time);
  requestRender();
}

const animationGroup = group('Animation', [
  timeSlider.root,
  el('div', { class: 'row' }, [
    playToggle.root,
    button('⏮', () => seekTo(0), 'icon'),
    button('⏭', () => seekTo(1), 'icon'),
    el('span', { class: 'spacer' }),
    frameRate,
  ]),
  el('div', { class: 'row' }, [
    el('label', { class: 'inline' }, [framesField, 'frames']),
    el('label', { class: 'inline' }, [repaintField, 'repaint every']),
  ]),
  el('div', { class: 'row' }, [
    el('label', { class: 'inline' }, [layoutSeedField, 'Layout seed']),
    button('Randomise', () => {
      edit((ws) => {
        ws.layoutSeed = (Math.random() * 0xffffffff) >>> 0;
      });
      layoutSeedField.value = String(active().layoutSeed);
      requestRender();
    }),
  ]),
  sceneOptionBox,
  el('p', { class: 'hint' }, [
    'A scene is drawn afresh at every moment: any number of shapes, each in its own ' +
      'shade, all painted with the settings below on one sheet. Play steps through the ' +
      'export frames at full quality, never trimmed: at the scene\'s own pace when the ' +
      'machine keeps up, slower when it does not. Frames sets how many the export ' +
      'writes across the whole scene. Repaint every holds the paint seed for that many ' +
      'frames: 1 repaints every frame, as the seed animation does; 2 or 3 at a higher ' +
      'frame rate gives the look of animation drawn on twos. The layout seed moves what ' +
      'the scene leaves to chance, such as where the roots branch.',
  ]),
]);

const framesHint = el('p', { class: 'hint' });
const FRAMES_HINT_SVG =
  'Save PNG frames asks for a folder and a frame count, then renders each frame ' +
  'at export quality with a fresh random seed. Each file name carries its seed. ' +
  'Browsers without folder access download the frames one by one instead.';
const FRAMES_HINT_SCENE =
  'Save animation frames asks for a folder, then renders the scene from start to end ' +
  'at export quality, one numbered file per frame, transparent outside the painting ' +
  'with the paper baked in behind it as the toggles above decide. The last frame is ' +
  'the finished scene. Browsers without folder access download the frames one by one.';

const liveQualitySlider = slider({
  label: 'Live quality',
  min: 0.15,
  max: 1,
  step: 0.05,
  value: 0.7,
  hint: 'Ceiling on the width used while animating; the frame rate is held by trimming below it',
  onInput: (v) => {
    edit((ws) => {
      ws.liveQuality = v;
    });
    if (animating) requestRender();
  },
});

panel.append(
  group('Source', [
    el('div', { class: 'row' }, [
      button('Open SVG…', () => fileInput.click()),
      sampleSelect,
      fileInput,
      importInput,
    ]),
    el('p', { class: 'hint' }, ['Gradient fills drive the shading; solid fills get form shading.']),
  ]),

  animationGroup,

  group('Algorithm', [flavorGrid, flavorBlurb]),

  group('Seed', [
    el('div', { class: 'row' }, [
      seedField,
      button('Randomise', () => {
        edit((ws) => {
          ws.seed = (Math.random() * 0xffffffff) >>> 0;
        });
        seedField.value = String(active().seed);
        requestRender();
      }),
      animateToggle.root,
    ]),
    liveQualitySlider.root,
    el('p', { class: 'hint' }, [
      'The same seed always reproduces the same painting. Animating steps it at ' +
        `${ANIMATION_FPS} frames a second, trimming the render size as far as it has ` +
        'to in order to hold that rate. The footer shows what it settled on.',
    ]),
  ]),

  group('Output', [
    widthSlider.root,
    supersampleSlider.root,
    paddingSlider.root,
    el('div', { class: 'row' }, [
      el('label', { class: 'inline' }, [paperInput, 'Paper']),
      el('label', { class: 'inline' }, [colorInput, overrideToggle.root]),
    ]),
    el('div', { class: 'row' }, [bakeToggle.root, previewTransparentToggle.root]),
    el('div', { class: 'row' }, [
      button('Save PNG', () => void savePng(), 'primary'),
      framesButton,
      el('span', { class: 'spacer' }),
      button('Copy JSON', copySettings),
    ]),
    el('p', { class: 'hint' }, [
      'The PNG is always transparent outside the shape. Bake paper decides what ' +
        'happens inside it: on, the paper goes in behind the pigment and the shape ' +
        'is a flat cut-out that looks the same on any background; off, the wash ' +
        'keeps its real translucency and tints whatever is behind it.',
    ]),
    framesHint,
  ]),
);

// Parameter sliders, generated from the library's own specification.
const GROUP_ORDER: ParamGroup[] = ['Pigment', 'Edge', 'Shading', 'Texture', 'Paper', 'Fluid', 'Misc'];
const paramSections = new Map<ParamGroup, HTMLElement>();
const specRows = new Map<keyof WatercolorParams, HTMLElement>();

for (const g of GROUP_ORDER) {
  const specs = PARAM_SPECS.filter((s) => s.group === g);
  if (specs.length === 0) continue;
  const rows: HTMLElement[] = [];
  for (const spec of specs) {
    const handle = slider({
      label: spec.label,
      min: spec.min,
      max: spec.max,
      step: spec.step,
      value: BASE_PARAMS[spec.key],
      hint: spec.hint,
      onInput: (v) => {
        edit((ws) => {
          ws.params = { ...ws.params, [spec.key]: v };
        });
        requestRender();
      },
    });
    sliders.set(spec.key, handle);
    specRows.set(spec.key, handle.root);
    rows.push(handle.root);
  }
  const section = subgroup(g, rows, g === 'Pigment' || g === 'Shading');
  paramSections.set(g, section);
  panel.append(section);
}

function updateParamVisibility(): void {
  const ws = active();
  for (const spec of PARAM_SPECS) {
    const row = specRows.get(spec.key);
    if (!row) continue;
    // A parameter that does nothing for the current flavor is hidden rather
    // than disabled: a slider that moves and changes nothing is worse than one
    // that is not there.
    const applies = !spec.flavors || spec.flavors.includes(ws.flavor);
    row.style.display = applies ? '' : 'none';
  }
  for (const [g, section] of paramSections) {
    const any = PARAM_SPECS.some(
      (s) => s.group === g && (!s.flavors || s.flavors.includes(ws.flavor)),
    );
    section.style.display = any ? '' : 'none';
  }
}

panel.append(
  group('Workspace', [
    el('div', { class: 'row' }, [
      button('Rename', () => tabBar.beginRename(session.activeId)),
      button('Duplicate', () => duplicateWorkspace(active())),
      button('Export…', exportActive),
      button('Import…', () => importInput.click()),
    ]),
    el('div', { class: 'row' }, [
      button('Reset flavor', () => setFlavor(active().flavor, true)),
      button('Reset all', () => {
        edit((ws) => {
          ws.params = { ...BASE_PARAMS };
        });
        syncFlavorControls();
        requestRender();
      }),
    ]),
    el('p', { class: 'hint' }, [
      'Workspaces are kept in this browser. Export writes one of them - the SVG, ' +
        'the flavor, every parameter and the seed - to a JSON file; importing adds ' +
        'it back as a new tab.',
    ]),
  ]),
);

// ------------------------------------------------------------------- sync --

/** Push the active workspace into every control. */
function syncControls(): void {
  const ws = active();
  syncHeader();
  colorInput.value = ws.color;
  paperInput.value = ws.paper;
  seedField.value = String(ws.seed);
  overrideToggle.set(ws.overrideColor);
  previewTransparentToggle.set(ws.previewTransparent);
  bakeToggle.set(ws.bakePaper);
  animateToggle.set(animating);
  widthSlider.set(ws.width);
  supersampleSlider.set(ws.supersample);
  paddingSlider.set(ws.padding);
  liveQualitySlider.set(ws.liveQuality);
  timeSlider.set(ws.time);
  playToggle.set(playing);
  framesField.value = String(ws.frameCount);
  repaintField.value = String(ws.repaintEvery);
  layoutSeedField.value = String(ws.layoutSeed);
  syncModeControls();
  syncFlavorControls();
}

/** Show the animation controls only when there is an animation. */
function syncModeControls(): void {
  const ws = active();
  const scene = sceneOf(ws);
  animationGroup.style.display = scene ? '' : 'none';
  if (!frameJob) framesButton.textContent = scene ? ANIMATION_FRAMES_LABEL : FRAMES_LABEL;
  framesHint.textContent = scene ? FRAMES_HINT_SCENE : FRAMES_HINT_SVG;
  if (scene) {
    const fps = ws.frameCount / scene.duration;
    frameRate.textContent = `${scene.duration}s at ${fps.toFixed(fps % 1 ? 1 : 0)} fps`;
    buildSceneOptions(scene);
    for (const [key, handle] of sceneOptionSliders) {
      if (key in ws.sceneOptions) handle.set(ws.sceneOptions[key]);
    }
  }
  sampleSelect.value = scene
    ? SCENE_PREFIX + scene.id
    : SAMPLES.some((s) => s.name === ws.sourceName)
      ? ws.sourceName
      : CUSTOM_OPTION;
}

// --------------------------------------------------------------- commands --

/** Options for an export render. */
function exportOptions(): RenderOptions {
  const ws = active();
  // Always exported with transparency outside the shape, whatever the preview
  // happens to be showing. Bake paper decides only whether the pigment itself
  // carries that transparency too.
  return buildOptions({ background: null, width: ws.width, supersample: ws.supersample });
}

/**
 * Render once, outside the live queue.
 *
 * The id is never `inFlight`, so the preview's own handler ignores the reply
 * and an export can share the worker with whatever is being previewed.
 */
function renderOnce(options: RenderOptions): Promise<RenderResponse> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const once = (ev: MessageEvent<RenderResponse | RenderError>): void => {
      if (ev.data.id !== id) return;
      worker.removeEventListener('message', once);
      if (ev.data.ok) resolve(ev.data);
      else reject(new Error(ev.data.message));
    };
    worker.addEventListener('message', once);
    worker.postMessage({ id, options } satisfies RenderRequest);
  });
}

function encodePng(msg: RenderResponse): Promise<Blob> {
  const off = document.createElement('canvas');
  off.width = msg.width;
  off.height = msg.height;
  off
    .getContext('2d')!
    .putImageData(new ImageData(new Uint8ClampedArray(msg.data), msg.width, msg.height), 0, 0);
  return new Promise((resolve, reject) => {
    off.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed.'))), 'image/png');
  });
}

function exportBase(ws: Workspace): string {
  return `${exportFileName(ws).replace(/\.watercolour\.json$/, '')}-${ws.flavor}`;
}

async function savePng(): Promise<void> {
  const ws = active();
  try {
    const msg = await renderOnce(exportOptions());
    const tag = sceneOf(ws) ? `t${ws.time.toFixed(3)}-${msg.seed}` : String(ws.seed);
    download(await encodePng(msg), `${exportBase(ws)}-${tag}.png`);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

/** The File System Access entry point, which only Chromium browsers have. */
type DirectoryPicker = (options?: {
  id?: string;
  mode?: 'read' | 'readwrite';
}) => Promise<FileSystemDirectoryHandle>;

let lastFrameCount = 24;
/** The running frame export, if any. Its button doubles as the cancel. */
let frameJob: { cancelled: boolean } | null = null;

async function savePngFrames(): Promise<void> {
  if (frameJob) {
    frameJob.cancelled = true;
    return;
  }

  // The folder is asked for first: the picker needs the click's user
  // activation, and a prompt in front of it can outlast that.
  const picker = (window as unknown as { showDirectoryPicker?: DirectoryPicker })
    .showDirectoryPicker;
  let dir: FileSystemDirectoryHandle | null = null;
  if (picker) {
    try {
      dir = await picker({ id: 'watercolour-frames', mode: 'readwrite' });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      showError(err instanceof Error ? err.message : String(err));
      return;
    }
  }

  const scene = sceneOf(active());
  const answer = window.prompt(
    scene ? `How many frames for the whole ${scene.duration}s scene?` : 'How many frames?',
    String(scene ? active().frameCount : lastFrameCount),
  );
  if (answer === null) return;
  const count = Number(answer.trim());
  if (!Number.isInteger(count) || count < 1 || count > MAX_FRAMES) {
    showError(`Enter a whole number of frames from 1 to ${MAX_FRAMES}.`);
    return;
  }
  if (scene) {
    edit((w) => {
      w.frameCount = count;
    });
    framesField.value = String(count);
    syncModeControls();
  } else {
    lastFrameCount = count;
  }
  if (playing) setPlaying(false);

  // Everything is fixed up front, so switching tabs or moving a slider while
  // the frames render cannot change what ends up in the folder.
  const ws: Workspace = { ...active(), params: { ...active().params }, frameCount: count };
  let options: RenderOptions;
  try {
    options = exportOptions();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    return;
  }
  const base = exportBase(ws);
  const digits = Math.max(4, String(count).length);

  // What frame i is. A still is repainted with a fresh random seed each
  // time; a scene is advanced through its time, with the paint seed stepped
  // as the workspace says.
  const frameAt = (i: number): { options: RenderOptions; name: string } => {
    const index = String(i + 1).padStart(digits, '0');
    if (scene) {
      const time = count > 1 ? i / (count - 1) : 1;
      const input = frameInput(ws, time, i);
      return {
        options: { ...options, shapes: input.shapes, viewBox: input.viewBox, seed: input.seed },
        name: `${base}-${index}.png`,
      };
    }
    const seed = (Math.random() * 0xffffffff) >>> 0;
    // Numbered for anything that assembles a sequence, seeded so any single
    // frame can be dialled back in and re-rendered.
    return { options: { ...options, seed }, name: `${base}-${index}-${seed}.png` };
  };

  const job = { cancelled: false };
  frameJob = job;
  framesButton.textContent = 'Cancel frames';
  let saved = 0;
  try {
    while (saved < count && !job.cancelled) {
      showStatus(`Rendering frame ${saved + 1} of ${count}…`);
      const frame = frameAt(saved);
      const blob = await encodePng(await renderOnce(frame.options));
      const name = frame.name;
      if (dir) {
        const file = await dir.getFileHandle(name, { create: true });
        const out = await file.createWritable();
        await out.write(blob);
        await out.close();
      } else {
        download(blob, name);
      }
      saved++;
    }
    const where = dir ? ` to ${dir.name}` : '';
    showStatus(
      job.cancelled
        ? `Stopped after ${saved} of ${count} frames${where}.`
        : `Saved ${count} frames${where}.`,
    );
  } catch (err) {
    showError(`Frame ${saved + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    frameJob = null;
    framesButton.textContent = sceneOf(active()) ? ANIMATION_FRAMES_LABEL : FRAMES_LABEL;
  }
}

async function copySettings(): Promise<void> {
  // Only the parameters that differ from the flavor's preset, so the snippet
  // stays readable. The workspace *export* carries them in full instead,
  // because that one has to survive the presets being retuned.
  const ws = active();
  const preset = resolveParams(ws.flavor);
  const diff: Partial<WatercolorParams> = {};
  for (const key of Object.keys(ws.params) as (keyof WatercolorParams)[]) {
    if (ws.params[key] !== preset[key]) diff[key] = ws.params[key];
  }
  const payload = {
    flavor: ws.flavor,
    seed: ws.seed,
    width: ws.width,
    supersample: ws.supersample,
    padding: ws.padding,
    paper: ws.paper,
    background: null,
    bakePaper: ws.bakePaper,
    ...(Object.keys(diff).length ? { params: diff } : {}),
    ...(ws.mode === 'scene'
      ? {
          scene: ws.scene,
          time: ws.time,
          frameCount: ws.frameCount,
          repaintEvery: ws.repaintEvery,
          layoutSeed: ws.layoutSeed,
          options: ws.sceneOptions,
        }
      : {}),
  };
  const text = JSON.stringify(payload, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    showError(null);
  } catch {
    showError('Clipboard blocked; settings logged to the console instead.');
    console.log(text);
  }
}

// ------------------------------------------------------------ drag & drop --

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  stage.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    stage.classList.remove('dragging');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  stage.classList.remove('dragging');
  const file = e.dataTransfer?.files?.[0];
  if (file) void loadFile(file);
});

// Anything still queued has to reach storage before the tab goes away.
window.addEventListener('pagehide', () => store.flush());

// ------------------------------------------------------------------ start --

refreshTabs();
syncControls();
requestRender();
