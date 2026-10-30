/**
 * Scene options: the few knobs a scene exposes, as slider metadata.
 *
 * Declared the same way the renderer declares its parameters, so a control
 * panel can be built from them and cannot drift from what the scene reads.
 */

export interface SceneOptionSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  hint?: string;
}

export type SceneOptions = Record<string, number>;

/**
 * Coerce an arbitrary bag into a scene's options: unknown keys dropped,
 * known ones clamped to their declared range, missing ones defaulted.
 */
export function resolveSceneOptions(
  specs: SceneOptionSpec[] | undefined,
  raw?: Record<string, unknown> | null,
): SceneOptions {
  const out: SceneOptions = {};
  for (const spec of specs ?? []) {
    const v = raw ? raw[spec.key] : undefined;
    const n = typeof v === 'number' ? v : Number(v);
    out[spec.key] = Number.isFinite(n) ? Math.min(spec.max, Math.max(spec.min, n)) : spec.default;
  }
  return out;
}
