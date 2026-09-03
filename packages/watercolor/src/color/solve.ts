/**
 * Inverting the paint.
 *
 * The caller names the colour they want the wash to *be*. What the renderer
 * needs is the pigment that, laid at the nominal thickness over this
 * particular paper, composites to exactly that colour - and which then keeps
 * behaving like paint on either side of it, going richer and more saturated
 * as it thickens and fading towards the paper's own colour as it thins.
 *
 * Matching luminance alone is not enough. A pigment derived by simply
 * deepening the target is far more chromatic than the target, and a thin
 * layer of it lands on the right lightness with visibly too much saturation -
 * an ochre wash comes out egg-yolk yellow. So the neat colour is refined:
 * composite, compare against the target channel by channel, and pull the neat
 * colour in the direction that closes the gap. It converges in a handful of
 * rounds and costs nothing at render time, because it runs once per shape.
 */

import type { RGB } from './color.js';
import {
  compositePigment,
  deepenColor,
  pigmentFromColor,
  thicknessForLuminance,
  type Pigment,
} from './km.js';

export interface SolvedPigment {
  pigment: Pigment;
  /** Layer thickness at which the pigment composites to the target colour. */
  thickness: number;
  /** The neat pigment colour that was solved for, in linear light. */
  full: RGB;
}

const LUM: RGB = [0.2126, 0.7152, 0.0722];

function luminance(c: RGB): number {
  return LUM[0] * c[0] + LUM[1] * c[1] + LUM[2] * c[2];
}

/**
 * Solve for the pigment and nominal thickness reproducing `target` on `paper`.
 *
 * `depth` sets how much richer the neat paint is than the wash, and so how
 * fast the colour deepens as pigment piles up. It changes the behaviour of
 * the ramp, not the colour at nominal thickness - that is pinned to `target`
 * whatever `depth` is set to.
 */
export function solvePigment(
  target: RGB,
  paper: RGB,
  depth: number,
  scattering: number,
  bodyStrength: number,
  iterations = 10,
): SolvedPigment {
  const paperLum = luminance(paper);
  // A target at or above the paper's own lightness has no thickness that can
  // reach it; back it off so the solve stays well-posed.
  const targetLum = Math.min(luminance(target), paperLum - 1e-4);

  const full: RGB = deepenColor(target, depth);
  const probe: RGB = [0, 0, 0];
  let pigment = pigmentFromColor(full, scattering, bodyStrength);
  let thickness = thicknessForLuminance(pigment, paper, targetLum);

  // Block coordinate descent: bisect each channel's neat reflectance against
  // its target at the current thickness, then re-solve the thickness from
  // luminance, and repeat.
  //
  // A damped multiplicative correction is the obvious approach and does not
  // work. Near the operating point the composited channel is extremely steep
  // in the neat colour - for a saturated blue, a 2.5x change in the neat red
  // moves the composited red by a factor of fifteen - so any fixed gain
  // either crawls or oscillates across the target without ever landing on it.
  // Bisection does not care how steep the response is, only that it is
  // monotone, which it is: more reflectance in equals more reflectance out.
  const scratch: RGB = [0, 0, 0];
  const channelAt = (ch: number, value: number, th: number): number => {
    scratch[0] = full[0];
    scratch[1] = full[1];
    scratch[2] = full[2];
    scratch[ch] = value;
    compositePigment(pigmentFromColor(scratch, scattering, bodyStrength), th, paper, probe);
    return probe[ch];
  };

  for (let it = 0; it < iterations; it++) {
    for (let ch = 0; ch < 3; ch++) {
      let lo = 1e-5;
      let hi = 0.9995;
      const want = target[ch];
      // If even a perfectly reflective neat colour cannot get bright enough,
      // or a perfectly absorbing one cannot get dark enough, take the bound.
      if (channelAt(ch, hi, thickness) <= want) {
        full[ch] = hi;
        continue;
      }
      if (channelAt(ch, lo, thickness) >= want) {
        full[ch] = lo;
        continue;
      }
      for (let k = 0; k < 26; k++) {
        const mid = Math.sqrt(lo * hi); // geometric: the response is multiplicative
        if (channelAt(ch, mid, thickness) < want) lo = mid;
        else hi = mid;
      }
      full[ch] = Math.sqrt(lo * hi);
    }
    pigment = pigmentFromColor(full, scattering, bodyStrength);
    const next = thicknessForLuminance(pigment, paper, targetLum);
    const settled = Math.abs(next - thickness) < 1e-4 * Math.max(1, thickness);
    thickness = next;
    if (settled && it > 1) break;
  }

  pigment = pigmentFromColor(full, scattering, bodyStrength);
  return { pigment, thickness, full };
}
