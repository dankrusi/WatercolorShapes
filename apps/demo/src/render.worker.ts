/**
 * Render worker.
 *
 * A render is 50-800ms depending on size and flavor. On the main thread that
 * is enough to make every slider feel broken and to stall the animation
 * loop's own timing, so the whole pipeline runs here and the result comes back
 * as a transferred buffer - no copy, no jank.
 */

import { render, type RenderOptions, type RenderResult } from '@watercolor/shapes';

export interface RenderRequest {
  id: number;
  options: RenderOptions;
}

export interface RenderResponse {
  id: number;
  ok: true;
  width: number;
  height: number;
  data: ArrayBuffer;
  seed: number | string;
  timings: RenderResult['timings'];
}

export interface RenderError {
  id: number;
  ok: false;
  message: string;
}

self.addEventListener('message', (ev: MessageEvent<RenderRequest>) => {
  const { id, options } = ev.data;
  try {
    const result = render(options);
    const buffer = result.data.buffer as ArrayBuffer;
    const response: RenderResponse = {
      id,
      ok: true,
      width: result.width,
      height: result.height,
      data: buffer,
      seed: result.seed,
      timings: result.timings,
    };
    (self as unknown as Worker).postMessage(response, [buffer]);
  } catch (err) {
    const response: RenderError = {
      id,
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(response);
  }
});
