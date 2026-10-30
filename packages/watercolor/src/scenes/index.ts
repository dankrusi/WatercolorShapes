/**
 * Built-in scenes.
 *
 * A scene turns a moment in time into a list of shapes; the renderer paints
 * them as it paints anything else. See `types.ts` for the contract and
 * `plant.ts` for the first one.
 */

import { plantScene } from './plant.js';
import type { Scene } from './types.js';

export const SCENES: Scene[] = [plantScene];

export function getScene(id: string): Scene | undefined {
  return SCENES.find((s) => s.id === id);
}

export { plantScene };
export { resolveSceneOptions } from './options.js';
export type { Scene };
export type { SceneOptionSpec, SceneOptions } from './options.js';
