/**
 * Workspaces: the demo's unit of saved work.
 *
 * A workspace is everything needed to reproduce one painting exactly - the
 * SVG source, the flavor, every parameter, the seed and the output settings -
 * plus a title. They live in the tab bar, persist to browser storage, and
 * round-trip through a JSON file one workspace at a time.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * Everything that crosses a trust boundary is re-validated. Browser storage
 * survives across library versions and an imported file is arbitrary JSON, so
 * `normalizeWorkspace` treats both as untrusted: unknown parameters are
 * dropped, known ones are clamped to the ranges the sliders declare, and
 * anything missing falls back to a default. A single bad field can then never
 * take the app down on start-up, which is the worst possible failure for
 * something whose whole job is to remember your work.
 *
 * Exports carry *fully resolved* parameters rather than a diff against the
 * flavor preset. A diff is smaller and reads better, but it silently
 * reinterprets an old file whenever a preset is retuned - and the presets in
 * this project were retuned repeatedly while it was being fitted to the
 * references. An exported workspace should still be the same painting a year
 * later.
 */

import {
  FLAVORS,
  PARAM_SPECS,
  parseColor,
  resolveParams,
  type Flavor,
  type WatercolorParams,
} from '@watercolor/shapes';

import { SAMPLES } from './samples.js';

/** Bumped when the stored shape changes incompatibly. */
export const STORAGE_VERSION = 1;
export const STORAGE_KEY = 'watercolor-shapes/workspaces/v1';
export const EXPORT_FORMAT = 'watercolor-shapes-workspace';
export const EXPORT_VERSION = 1;

/**
 * Largest SVG a workspace will accept, in characters.
 *
 * Browser storage is a handful of megabytes for the whole origin, shared by
 * every workspace, and stores UTF-16 - so a megabyte of markup can cost two.
 * Refusing a huge file with a clear message beats accepting it and silently
 * failing to save every workspace from then on.
 */
export const MAX_SVG_CHARS = 1_000_000;

export interface Workspace {
  id: string;
  title: string;
  /** True until the user renames the tab, after which the title is theirs. */
  titleAuto: boolean;
  svg: string;
  /** File or sample name the SVG came from. */
  sourceName: string;
  flavor: Flavor;
  params: WatercolorParams;
  seed: number;
  width: number;
  supersample: number;
  padding: number;
  /** The sheet the paint sits on, and what gets baked in behind a cut-out. */
  paper: string;
  /** Preview the export's transparency instead of showing the paper. */
  previewTransparent: boolean;
  /** Bake the paper in behind the pigment, making the export a flat cut-out. */
  bakePaper: boolean;
  overrideColor: boolean;
  color: string;
  liveQuality: number;
}

export interface Session {
  version: number;
  workspaces: Workspace[];
  activeId: string;
}

export function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** A workspace seeded from one of the built-in samples. */
export function createWorkspace(sampleIndex = 0, title?: string): Workspace {
  const sample = SAMPLES[Math.min(Math.max(0, sampleIndex), SAMPLES.length - 1)];
  return {
    id: newId(),
    title: title ?? sample.name,
    titleAuto: title === undefined,
    svg: sample.svg,
    sourceName: sample.name,
    flavor: 'wash',
    params: resolveParams('wash'),
    seed: 1880459961,
    width: 640,
    supersample: 2,
    padding: 0.06,
    paper: '#f7efe8',
    previewTransparent: false,
    bakePaper: true,
    overrideColor: false,
    color: sample.color,
    liveQuality: 0.7,
  };
}

export function cloneWorkspace(ws: Workspace, title?: string): Workspace {
  return {
    ...ws,
    params: { ...ws.params },
    id: newId(),
    title: title ?? `${ws.title} copy`,
    titleAuto: false,
  };
}

// --------------------------------------------------------------- coercion --

function num(value: unknown, fallback: number, lo: number, hi: number): number {
  const v = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function str(value: unknown, fallback: string, maxLength = 200): string {
  if (typeof value !== 'string') return fallback;
  const s = value.trim();
  return s.length ? s.slice(0, maxLength) : fallback;
}

/**
 * Coerce to `#rrggbb`, which is the only form a colour input will display.
 * Anything that is not recognisably a colour falls back rather than being run
 * through the parser, which answers black for unrecognised input.
 */
export function normalizeHex(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const s = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase();
  }
  if (!/^(#|rgba?\(|hsla?\()/i.test(s)) return fallback;
  const { rgb } = parseColor(s);
  if (!rgb.every((c) => Number.isFinite(c))) return fallback;
  const hex = rgb
    .map((c) =>
      Math.round(Math.min(1, Math.max(0, c)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
  return `#${hex}`;
}

/** Clamp and filter a parameter bag against the library's own slider specs. */
export function normalizeParams(raw: unknown, flavor: Flavor): WatercolorParams {
  const out = resolveParams(flavor);
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const spec of PARAM_SPECS) {
    const v = src[spec.key];
    if (v === undefined) continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) continue;
    out[spec.key] = Math.min(spec.max, Math.max(spec.min, n));
  }
  return out;
}

export function isSvgSource(value: unknown): value is string {
  return typeof value === 'string' && /<svg[\s>]/i.test(value);
}

export class WorkspaceError extends Error {}

/**
 * Validate an arbitrary object into a Workspace, or throw with a message fit
 * to show the user.
 */
export function normalizeWorkspace(raw: unknown, fallbackTitle = 'Untitled'): Workspace {
  if (!raw || typeof raw !== 'object') {
    throw new WorkspaceError('That file does not contain a workspace.');
  }
  const src = raw as Record<string, unknown>;
  const svg = src['svg'];
  if (!isSvgSource(svg)) {
    throw new WorkspaceError('That workspace has no SVG in it.');
  }
  if (svg.length > MAX_SVG_CHARS) {
    throw new WorkspaceError(
      `That SVG is ${Math.round(svg.length / 1000)}kB, over the ${Math.round(
        MAX_SVG_CHARS / 1000,
      )}kB a workspace can store.`,
    );
  }

  const flavorRaw = src['flavor'];
  const flavor: Flavor =
    typeof flavorRaw === 'string' && (FLAVORS as string[]).includes(flavorRaw)
      ? (flavorRaw as Flavor)
      : 'wash';

  // Accept both the flat shape used in storage and the grouped shape used by
  // the export file, so a hand-edited file still loads.
  const output = (src['output'] ?? src) as Record<string, unknown>;
  const fill = (src['fill'] ?? src) as Record<string, unknown>;

  const seedRaw = src['seed'];
  const seedNum = typeof seedRaw === 'number' ? seedRaw : Number(seedRaw);

  return {
    id: typeof src['id'] === 'string' && src['id'] ? (src['id'] as string) : newId(),
    title: str(src['title'], fallbackTitle, 60),
    titleAuto: bool(src['titleAuto'], false),
    svg,
    sourceName: str(src['sourceName'], 'imported.svg', 120),
    flavor,
    params: normalizeParams(src['params'], flavor),
    seed: Number.isFinite(seedNum) ? seedNum >>> 0 : 7,
    width: Math.round(num(output['width'], 640, 32, 4096)),
    supersample: Math.round(num(output['supersample'], 2, 1, 4)),
    padding: num(output['padding'], 0.06, 0, 0.45),
    // `background` is accepted as an alias so a hand-edited or older file
    // still loads; the name changed once the paper stopped being merely what
    // fills the image.
    paper: normalizeHex(output['paper'] ?? output['background'], '#f7efe8'),
    previewTransparent: bool(output['previewTransparent'] ?? output['transparent'], false),
    bakePaper: bool(output['bakePaper'], true),
    overrideColor: bool(fill['overrideColor'], false),
    color: normalizeHex(fill['color'], '#c07a3e'),
    liveQuality: num(src['liveQuality'], 0.7, 0.15, 1),
  };
}

// ----------------------------------------------------------- import/export --

export interface ExportPayload {
  format: string;
  version: number;
  exportedAt: string;
  workspace: Record<string, unknown>;
}

export function exportWorkspace(ws: Workspace): ExportPayload {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    workspace: {
      title: ws.title,
      sourceName: ws.sourceName,
      svg: ws.svg,
      flavor: ws.flavor,
      seed: ws.seed,
      // Fully resolved, not a diff against the flavor preset: an exported
      // workspace has to reproduce the same painting even if the presets move.
      params: { ...ws.params },
      output: {
        width: ws.width,
        supersample: ws.supersample,
        padding: ws.padding,
        paper: ws.paper,
        previewTransparent: ws.previewTransparent,
        bakePaper: ws.bakePaper,
      },
      fill: {
        overrideColor: ws.overrideColor,
        color: ws.color,
      },
      liveQuality: ws.liveQuality,
    },
  };
}

export function exportFileName(ws: Workspace): string {
  const slug =
    ws.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'workspace';
  return `${slug}.watercolour.json`;
}

/**
 * Parse an exported file. Accepts a single workspace, a bare workspace object,
 * or a list, so a hand-assembled file of several still imports.
 */
export function parseImport(text: string): Workspace[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new WorkspaceError('That file is not valid JSON.');
  }
  const list = collectWorkspaceCandidates(data);
  if (list.length === 0) {
    throw new WorkspaceError('No workspace found in that file.');
  }
  return list.map((w, i) => normalizeWorkspace(w, `Imported ${i + 1}`));
}

function collectWorkspaceCandidates(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  const o = data as Record<string, unknown>;
  if (Array.isArray(o['workspaces'])) return o['workspaces'];
  if (o['workspace'] && typeof o['workspace'] === 'object') return [o['workspace']];
  // A bare workspace object, e.g. one lifted out of a stored session.
  if (isSvgSource(o['svg'])) return [o];
  return [];
}

// ------------------------------------------------------------------ store --

/**
 * Browser-storage backing for the session.
 *
 * Writes are debounced because state changes on every slider frame, and
 * serialising several SVGs at 60Hz would cost more than the rendering does.
 * Storage being unavailable or full is reported once and then tolerated: the
 * app keeps working in memory rather than failing.
 */
export class WorkspaceStore {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Session | null = null;
  private available: boolean;
  private lastError: string | null = null;

  constructor(private readonly onError: (message: string | null) => void) {
    this.available = probeStorage();
    if (!this.available) {
      this.report('Browser storage is unavailable, so workspaces will not be remembered.');
    }
  }

  load(): Session | null {
    if (!this.available) return null;
    let text: string | null = null;
    try {
      text = localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
    if (!text) return null;
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      const rawList = Array.isArray(data['workspaces']) ? data['workspaces'] : [];
      const workspaces: Workspace[] = [];
      for (const raw of rawList) {
        // One corrupt workspace must not cost the user the others.
        try {
          workspaces.push(normalizeWorkspace(raw));
        } catch {
          /* skip */
        }
      }
      if (workspaces.length === 0) return null;
      const activeRaw = data['activeId'];
      const activeId =
        typeof activeRaw === 'string' && workspaces.some((w) => w.id === activeRaw)
          ? activeRaw
          : workspaces[0].id;
      return { version: STORAGE_VERSION, workspaces, activeId };
    } catch {
      return null;
    }
  }

  save(session: Session): void {
    if (!this.available) return;
    this.pending = session;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 400);
  }

  flush(): void {
    if (!this.available || !this.pending) return;
    const session = this.pending;
    this.pending = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      this.report(null);
    } catch (err) {
      const quota =
        err instanceof DOMException &&
        (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
      this.report(
        quota
          ? 'Browser storage is full, so this change was not saved. Close a workspace or use a smaller SVG.'
          : 'Could not write to browser storage, so this change was not saved.',
      );
    }
  }

  private report(message: string | null): void {
    if (message === this.lastError) return;
    this.lastError = message;
    this.onError(message);
  }
}

function probeStorage(): boolean {
  try {
    const key = `${STORAGE_KEY}/probe`;
    localStorage.setItem(key, '1');
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
