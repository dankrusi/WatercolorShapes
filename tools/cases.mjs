/**
 * The three reference cases, reconstructed as SVG geometry.
 *
 * The paths were fitted to the reference bitmaps rather than guessed: each
 * one's silhouette was measured row by row and solved for. `roundedsquare` is
 * a 137.2px square with a 32.6px corner radius turned 45 degrees, which
 * reproduces the measured half-widths at every sampled row to within a pixel.
 * Fitting them properly matters, because otherwise a comparison against the
 * references would be measuring the wrong shape, not the wrong paint.
 */

export const CASES = [
  {
    name: 'halfcircle1',
    reference: 'references/halfcircle1.png',
    width: 176,
    height: 98,
    viewBox: { x: 0, y: 0, width: 176, height: 98 },
    path: 'M4.5 94 A83.5 91 0 0 1 171.5 94 Z',
    // The colour is the wash's mean appearance, measured off the reference.
    // The renderer works out the neat pigment behind it.
    color: '#ddb07c',
    paper: '#f6efe8',
  },
  {
    name: 'halfcircle2',
    reference: 'references/halfcircle2.png',
    width: 172,
    height: 98,
    viewBox: { x: 0, y: 0, width: 172, height: 98 },
    path: 'M4 11 A82 82 0 0 0 168 11 Z',
    color: '#c4b29d',
    paper: '#f7efe8',
  },
  {
    name: 'roundedsquare',
    reference: 'references/roundedsquare.png',
    width: 174,
    height: 174,
    viewBox: { x: 0, y: 0, width: 174, height: 174 },
    path:
      'M52 19.4 H124 A32.6 32.6 0 0 1 156.6 52 V124 A32.6 32.6 0 0 1 124 156.6 ' +
      'H52 A32.6 32.6 0 0 1 19.4 124 V52 A32.6 32.6 0 0 1 52 19.4 Z',
    transform: 'rotate(45 88 88)',
    color: '#41403c',
    paper: '#f7efe8',
  },
];
