/**
 * Demo test suite. Run with `pnpm test` (tsx, no test framework).
 *
 * Covers the workspace model: the round trip through an export file, and the
 * validation that stands between arbitrary JSON and the running app. Import
 * and storage are the two places where a bad value arrives from outside and
 * fails silently much later, so they get the coverage.
 *
 * The store itself is not exercised here - it needs a browser - but every
 * function it leans on is.
 */

import { BASE_PARAMS, resolveParams, SCENES } from '@watercolor/shapes';

import {
  cloneWorkspace,
  createWorkspace,
  exportFileName,
  exportWorkspace,
  isSvgSource,
  MAX_FRAMES,
  MAX_SVG_CHARS,
  normalizeHex,
  normalizeParams,
  normalizeWorkspace,
  parseImport,
  WorkspaceError,
  type Workspace,
} from '../src/workspaces.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    process.stdout.write('.');
  } catch (err) {
    failed++;
    failures.push(`${name}\n    ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write('x');
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function throws(fn: () => unknown, match: RegExp, msg: string): void {
  try {
    fn();
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    assert(match.test(text), `${msg}: threw "${text}", expected ${match}`);
    return;
  }
  throw new Error(`${msg}: did not throw`);
}

const SVG = '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#123456"/></svg>';

// ------------------------------------------------------------- new sheets --

test('a new workspace is complete and valid', () => {
  const ws = createWorkspace(0);
  assert(isSvgSource(ws.svg), 'has an SVG');
  assert(ws.id.length > 4, 'has an id');
  assert(ws.titleAuto === true, 'starts with an automatic title');
  assert(ws.bakePaper === true, 'bakes the paper by default');
  for (const key of Object.keys(BASE_PARAMS)) {
    assert(key in ws.params, `params missing ${key}`);
  }
});

test('new workspaces get distinct ids', () => {
  const ids = new Set(Array.from({ length: 50 }, () => createWorkspace(0).id));
  assert(ids.size === 50, `only ${ids.size} distinct ids out of 50`);
});

test('a duplicate is independent of its original', () => {
  const a = createWorkspace(0);
  const b = cloneWorkspace(a);
  assert(b.id !== a.id, 'gets a new id');
  assert(b.titleAuto === false, 'a copy keeps the name it was given');
  b.params.intensity = 1.9;
  assert(a.params.intensity !== 1.9, 'parameters were shared with the original');
});

// ------------------------------------------------------------- round trip --

test('an exported workspace imports back identically', () => {
  const ws = createWorkspace(2);
  ws.title = 'Study 4';
  ws.titleAuto = false;
  ws.flavor = 'bloom';
  ws.params = resolveParams('bloom');
  ws.params.intensity = 1.37;
  ws.params.blooms = 1.02;
  ws.seed = 123456;
  ws.width = 900;
  ws.supersample = 3;
  ws.padding = 0.11;
  ws.paper = '#eee0d0';
  ws.previewTransparent = true;
  ws.bakePaper = false;
  ws.overrideColor = true;
  ws.color = '#2f5d7c';
  ws.liveQuality = 0.45;

  const [back] = parseImport(JSON.stringify(exportWorkspace(ws)));
  for (const key of Object.keys(ws) as (keyof Workspace)[]) {
    if (key === 'id' || key === 'params') continue;
    assert(
      JSON.stringify(back[key]) === JSON.stringify(ws[key]),
      `${key}: ${JSON.stringify(back[key])} vs ${JSON.stringify(ws[key])}`,
    );
  }
  for (const key of Object.keys(ws.params) as (keyof typeof ws.params)[]) {
    assert(back.params[key] === ws.params[key], `params.${key} did not survive`);
  }
});

test('an export carries every parameter, not a diff against the preset', () => {
  // A diff would be reinterpreted the next time a flavor preset is retuned.
  const ws = createWorkspace(0);
  const payload = exportWorkspace(ws);
  const params = payload.workspace['params'] as Record<string, unknown>;
  for (const key of Object.keys(BASE_PARAMS)) {
    assert(key in params, `export omitted ${key}`);
  }
});

test('an import survives the flavor presets moving underneath it', () => {
  const ws = createWorkspace(0);
  ws.flavor = 'granulate';
  ws.params = resolveParams('granulate');
  const text = JSON.stringify(exportWorkspace(ws));
  // Simulate a retuned preset by asking for a value the preset does not have.
  const edited = JSON.parse(text) as Record<string, Record<string, Record<string, number>>>;
  edited.workspace.params.granulation = 0.123;
  const [back] = parseImport(JSON.stringify(edited));
  assert(back.params.granulation === 0.123, `got ${back.params.granulation}`);
});

test('the export file name is derived from the title', () => {
  const ws = createWorkspace(0);
  ws.title = 'Half Disc / Study #2';
  assert(exportFileName(ws) === 'half-disc-study-2.watercolour.json', exportFileName(ws));
  ws.title = '///';
  assert(exportFileName(ws) === 'workspace.watercolour.json', exportFileName(ws));
});

// ------------------------------------------------------------- validation --

test('an import without an SVG is rejected', () => {
  throws(() => parseImport('{"workspace":{"title":"x"}}'), /no SVG/i, 'missing svg');
  throws(() => parseImport('{}'), /No workspace/i, 'empty object');
  throws(() => parseImport('not json'), /not valid JSON/i, 'garbage');
});

test('an oversized SVG is refused with its size in the message', () => {
  const huge = `<svg>${'x'.repeat(MAX_SVG_CHARS + 10)}</svg>`;
  throws(
    () => normalizeWorkspace({ svg: huge }),
    /over the .*kB a workspace can store/i,
    'oversized svg',
  );
});

test('out-of-range parameters are clamped, not accepted', () => {
  const p = normalizeParams(
    { intensity: 1e9, shading: -50, mottleScale: 0, bogus: 5, granulation: 'nope' },
    'wash',
  );
  assert(p.intensity <= 2.5, `intensity was ${p.intensity}`);
  assert(p.shading >= 0, `shading was ${p.shading}`);
  assert(p.mottleScale > 0, `mottleScale was ${p.mottleScale}`);
  assert(!('bogus' in p), 'an unknown parameter was kept');
  assert(p.granulation === resolveParams('wash').granulation, 'a non-numeric value was kept');
});

test('an unknown flavor falls back rather than reaching the renderer', () => {
  const ws = normalizeWorkspace({ svg: SVG, flavor: 'watercolour-deluxe' });
  assert(ws.flavor === 'wash', `got ${ws.flavor}`);
});

test('nonsense output settings are coerced into range', () => {
  const ws = normalizeWorkspace({
    svg: SVG,
    seed: 'abc',
    output: { width: -400, supersample: 99, padding: 5, paper: 'not-a-colour' },
    liveQuality: 12,
  });
  assert(ws.width >= 32, `width was ${ws.width}`);
  assert(ws.supersample === 4, `supersample was ${ws.supersample}`);
  assert(ws.padding <= 0.45, `padding was ${ws.padding}`);
  assert(ws.paper === '#f7efe8', `paper was ${ws.paper}`);
  assert(Number.isInteger(ws.seed), `seed was ${ws.seed}`);
  assert(ws.liveQuality <= 1, `liveQuality was ${ws.liveQuality}`);
});

test('colours are coerced to the six-digit hex a colour input needs', () => {
  assert(normalizeHex('#ABC', '#000000') === '#aabbcc', normalizeHex('#ABC', '#000000'));
  assert(normalizeHex('#a1b2c3', '#000000') === '#a1b2c3', 'six digit');
  assert(normalizeHex('rgb(255, 0, 0)', '#000000') === '#ff0000', normalizeHex('rgb(255, 0, 0)', '#000000'));
  assert(normalizeHex('chartreuse', '#123456') === '#123456', 'unrecognised falls back');
  assert(normalizeHex(42, '#123456') === '#123456', 'non-string falls back');
});

test('an older file using the previous key names still loads', () => {
  // `background` was renamed to `paper` once it stopped being merely what
  // fills the image; files written before that must not lose their settings.
  const ws = normalizeWorkspace({
    svg: SVG,
    output: { background: '#ddccbb', transparent: true },
  });
  assert(ws.paper === '#ddccbb', `paper was ${ws.paper}`);
  assert(ws.previewTransparent === true, 'transparent flag was dropped');
});

test('a bare workspace object imports, as does a list', () => {
  const ws = createWorkspace(0);
  const bare = exportWorkspace(ws).workspace;
  assert(parseImport(JSON.stringify(bare)).length === 1, 'bare object');
  assert(parseImport(JSON.stringify([bare, bare])).length === 2, 'array');
  assert(parseImport(JSON.stringify({ workspaces: [bare] })).length === 1, 'workspaces field');
});

test('imported workspaces get fresh ids so they cannot collide', () => {
  const ws = createWorkspace(0);
  const payload = exportWorkspace(ws);
  const a = parseImport(JSON.stringify(payload))[0];
  const b = parseImport(JSON.stringify(payload))[0];
  assert(a.id !== b.id, 'two imports of the same file shared an id');
});

test('a title is taken from the file but bounded', () => {
  const long = 'x'.repeat(500);
  const ws = normalizeWorkspace({ svg: SVG, title: long });
  assert(ws.title.length <= 60, `title was ${ws.title.length} characters`);
  assert(normalizeWorkspace({ svg: SVG, title: '   ' }, 'Fallback').title === 'Fallback', 'blank');
});

test('WorkspaceError is what import failures throw', () => {
  try {
    parseImport('{}');
  } catch (err) {
    assert(err instanceof WorkspaceError, `threw ${err?.constructor?.name}`);
    return;
  }
  throw new Error('did not throw');
});

// -------------------------------------------------------------- animation --

test('a new workspace is a still, with its animation settings ready', () => {
  const ws = createWorkspace(0);
  assert(ws.mode === 'svg', `mode was ${ws.mode}`);
  assert(ws.scene === SCENES[0].id, `scene was ${ws.scene}`);
  assert(ws.time === 1, 'starts on the finished scene');
  assert(ws.frameCount === 120 && ws.repaintEvery === 1, 'frame defaults');
});

test('animation settings survive a round trip', () => {
  const ws = createWorkspace(0);
  ws.mode = 'scene';
  ws.scene = SCENES[0].id;
  ws.time = 0.37;
  ws.frameCount = 240;
  ws.repaintEvery = 3;
  ws.layoutSeed = 99;
  const [back] = parseImport(JSON.stringify(exportWorkspace(ws)));
  assert(back.mode === 'scene', 'mode');
  assert(back.scene === ws.scene, 'scene');
  assert(back.time === 0.37, `time was ${back.time}`);
  assert(back.frameCount === 240, `frameCount was ${back.frameCount}`);
  assert(back.repaintEvery === 3, `repaintEvery was ${back.repaintEvery}`);
  assert(back.layoutSeed === 99, `layoutSeed was ${back.layoutSeed}`);
});

test('an unknown scene falls back to the SVG rather than an empty stage', () => {
  const ws = normalizeWorkspace({ svg: SVG, mode: 'scene', animation: { scene: 'cathedral' } });
  assert(ws.mode === 'svg', `mode was ${ws.mode}`);
  assert(ws.scene === SCENES[0].id, `scene was ${ws.scene}`);
});

test('animation settings are coerced into range', () => {
  const ws = normalizeWorkspace({
    svg: SVG,
    mode: 'scene',
    animation: { scene: SCENES[0].id, time: 7, frameCount: 1e9, repaintEvery: 0, layoutSeed: -5 },
  });
  assert(ws.mode === 'scene', 'a known scene is kept');
  assert(ws.time === 1, `time was ${ws.time}`);
  assert(ws.frameCount === MAX_FRAMES, `frameCount was ${ws.frameCount}`);
  assert(ws.repaintEvery === 1, `repaintEvery was ${ws.repaintEvery}`);
  assert(ws.layoutSeed === 0, `layoutSeed was ${ws.layoutSeed}`);
});

// ------------------------------------------------------------------ done --

process.stdout.write('\n');
if (failures.length) {
  console.error(`\n${failed} failed:\n`);
  for (const f of failures) console.error(`  - ${f}\n`);
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
