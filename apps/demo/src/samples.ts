/**
 * Built-in sample shapes.
 *
 * The first three are the geometry fitted to the reference paintings in
 * `references/`, so the demo opens on exactly what the renderer was tuned
 * against and any change is immediately visible against a known target.
 */

export interface Sample {
  name: string;
  svg: string;
  /** Suggested fill when the SVG does not carry one. */
  color: string;
}

const wrap = (viewBox: string, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;

export const SAMPLES: Sample[] = [
  {
    name: 'Half disc',
    color: '#ddb07c',
    svg: wrap('0 0 176 98', '<path d="M4.5 94 A83.5 91 0 0 1 171.5 94 Z" fill="#ddb07c"/>'),
  },
  {
    name: 'Half disc, inverted',
    color: '#c4b29d',
    svg: wrap('0 0 172 98', '<path d="M4 11 A82 82 0 0 0 168 11 Z" fill="#c4b29d"/>'),
  },
  {
    name: 'Rounded diamond',
    color: '#41403c',
    svg: wrap(
      '0 0 174 174',
      '<path transform="rotate(45 88 88)" fill="#41403c" d="M52 19.4 H124 A32.6 32.6 0 0 1 156.6 52 ' +
        'V124 A32.6 32.6 0 0 1 124 156.6 H52 A32.6 32.6 0 0 1 19.4 124 V52 A32.6 32.6 0 0 1 52 19.4 Z"/>',
    ),
  },
  {
    name: 'Leaf',
    color: '#5c7f52',
    svg: wrap(
      '0 0 200 200',
      '<path fill="#5c7f52" d="M100 12 C160 45 178 105 152 152 C126 188 74 188 48 152 C22 105 40 45 100 12 Z"/>',
    ),
  },
  {
    name: 'Blob',
    color: '#8a5a86',
    svg: wrap(
      '0 0 200 200',
      '<path fill="#8a5a86" d="M154 44 C182 72 190 118 166 148 C142 178 92 190 60 172 ' +
        'C28 154 10 112 20 76 C30 40 68 14 104 16 C126 17 138 28 154 44 Z"/>',
    ),
  },
  {
    name: 'Ring (even-odd)',
    color: '#2f5d7c',
    svg: wrap(
      '0 0 200 200',
      '<path fill="#2f5d7c" fill-rule="evenodd" d="M100 14 A86 86 0 1 1 99.9 14 Z ' +
        'M100 62 A38 38 0 1 0 100.1 62 Z"/>',
    ),
  },
  {
    name: 'Gradient sphere',
    color: '#b8503c',
    svg: wrap(
      '0 0 200 200',
      '<defs><radialGradient id="g" cx="0.36" cy="0.3" r="0.78">' +
        '<stop offset="0" stop-color="#f4c9a0"/>' +
        '<stop offset="0.55" stop-color="#d07a4a"/>' +
        '<stop offset="1" stop-color="#6d2a1e"/>' +
        '</radialGradient></defs>' +
        '<circle cx="100" cy="100" r="88" fill="url(#g)"/>',
    ),
  },
  {
    name: 'Gradient sweep',
    color: '#3d6b8a',
    svg: wrap(
      '0 0 220 140',
      '<defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#9fc7d8"/>' +
        '<stop offset="0.5" stop-color="#3d6b8a"/>' +
        '<stop offset="1" stop-color="#1d2f45"/>' +
        '</linearGradient></defs>' +
        '<rect x="8" y="8" width="204" height="124" rx="34" fill="url(#lg)"/>',
    ),
  },
  {
    name: 'Two shapes',
    color: '#7a3b3b',
    svg: wrap(
      '0 0 220 160',
      '<circle cx="82" cy="80" r="64" fill="#7a3b3b" fill-opacity="0.9"/>' +
        '<circle cx="146" cy="80" r="64" fill="#2f5d7c" fill-opacity="0.75"/>',
    ),
  },
];
