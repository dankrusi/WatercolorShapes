import type { ShapeInput } from '../types.js';
import type { SceneOptionSpec, SceneOptions } from './options.js';

/**
 * A scene: something that is drawn differently at every moment of a running
 * time, as a list of shapes for the renderer.
 *
 * The renderer paints a frame exactly as it paints any other list of shapes -
 * the same flavor, the same parameters, each shape its own colour or
 * gradient, all of them washes on one sheet. A scene only decides what the
 * shapes are at a given moment. It is pure: the same time and layout seed
 * always give the same shapes, so a frame can be re-rendered on its own.
 */
export interface Scene {
  /** Stable identifier, used in saved workspaces. */
  id: string;
  name: string;
  blurb: string;
  /** Coordinate system of the shapes. Fixed for the whole scene so every frame frames alike. */
  viewBox: { x: number; y: number; width: number; height: number };
  /** Nominal running time in seconds; a frame count divided by this is the frame rate. */
  duration: number;
  /** The scene's own knobs, as slider metadata. Absent when it has none. */
  options?: SceneOptionSpec[];
  /**
   * The shapes at `time`, from 0 (the start) to 1 (the end). `layoutSeed`
   * varies whatever the scene leaves to chance in its layout; it is not the
   * paint seed, which the renderer takes separately so the two can be
   * stepped apart. `options` are the scene's knobs; anything missing takes
   * its default. `seed` is the paint seed of this frame: a scene may let
   * something flutter with it, so that whatever is redrawn between repaints
   * is redrawn in step with the paint.
   */
  frame(
    time: number,
    layoutSeed?: number,
    options?: Partial<SceneOptions>,
    seed?: number,
  ): ShapeInput[];
}
