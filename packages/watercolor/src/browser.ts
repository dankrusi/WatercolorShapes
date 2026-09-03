/**
 * Browser conveniences.
 *
 * The core renderer has no DOM dependency - it returns raw RGBA - so these
 * are thin wrappers, plus a small reusable renderer that keeps one canvas and
 * one ImageData alive across frames. That matters for the animated mode:
 * allocating a fresh ImageData 12 times a second is enough garbage to show up
 * as stutter.
 */

import { render } from './render.js';
import type { RenderOptions, RenderResult } from './types.js';

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Render and return an ImageData. */
export function toImageData(options: RenderOptions): ImageData {
  const r = render(options);
  return new ImageData(r.data, r.width, r.height);
}

/** Render straight into an existing canvas, resizing it to match. */
export function paintToCanvas(canvas: AnyCanvas, options: RenderOptions): RenderResult {
  const r = render(options);
  canvas.width = r.width;
  canvas.height = r.height;
  const ctx = (canvas as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('watercolor-shapes: could not acquire a 2D context');
  ctx.putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
  return r;
}

/** Render into a freshly created canvas. */
export function toCanvas(options: RenderOptions): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  paintToCanvas(canvas, options);
  return canvas;
}

/** Render to a PNG data URL. */
export function toDataURL(options: RenderOptions, type = 'image/png', quality?: number): string {
  return toCanvas(options).toDataURL(type, quality);
}

/** Render to a Blob. */
export function toBlob(options: RenderOptions, type = 'image/png', quality?: number): Promise<Blob> {
  const canvas = toCanvas(options);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('watercolor-shapes: toBlob produced nothing'))),
      type,
      quality,
    );
  });
}

export interface Renderer {
  /** Render with the given options, reusing the internal buffers. */
  draw(options: RenderOptions): RenderResult;
  readonly canvas: HTMLCanvasElement;
  dispose(): void;
}

/**
 * A canvas-backed renderer that reuses its ImageData between frames.
 */
export function createRenderer(canvas?: HTMLCanvasElement): Renderer {
  const target = canvas ?? document.createElement('canvas');
  const ctx = target.getContext('2d');
  if (!ctx) throw new Error('watercolor-shapes: could not acquire a 2D context');
  let image: ImageData | null = null;

  return {
    canvas: target,
    draw(options: RenderOptions): RenderResult {
      const r = render(options);
      if (target.width !== r.width || target.height !== r.height) {
        target.width = r.width;
        target.height = r.height;
        image = null;
      }
      if (!image || image.width !== r.width || image.height !== r.height) {
        image = ctx.createImageData(r.width, r.height);
      }
      image.data.set(r.data);
      ctx.putImageData(image, 0, 0);
      return r;
    },
    dispose(): void {
      image = null;
    },
  };
}
