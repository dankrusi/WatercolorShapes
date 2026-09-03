/**
 * Colour parsing and sRGB transfer functions.
 *
 * All mixing in the renderer happens in linear light; sRGB is only ever the
 * encoding at the two ends of the pipeline.
 */

export type RGB = [number, number, number];

const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  gray: '#808080',
  grey: '#808080',
  orange: '#ffa500',
  purple: '#800080',
  brown: '#a52a2a',
  pink: '#ffc0cb',
  navy: '#000080',
  teal: '#008080',
  olive: '#808000',
  maroon: '#800000',
  lime: '#00ff00',
  indigo: '#4b0082',
  transparent: '#00000000',
};

/** Parse a CSS colour string into sRGB components in [0,1] plus alpha. */
export function parseColor(input: string): { rgb: RGB; alpha: number } {
  let s = String(input).trim().toLowerCase();
  if (NAMED[s]) s = NAMED[s];
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    const expand = (c: string) => parseInt(c + c, 16) / 255;
    if (hex.length === 3 || hex.length === 4) {
      return {
        rgb: [expand(hex[0]), expand(hex[1]), expand(hex[2])],
        alpha: hex.length === 4 ? expand(hex[3]) : 1,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      const b = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
      return { rgb: [b(0), b(2), b(4)], alpha: hex.length === 8 ? b(6) : 1 };
    }
  }
  let m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter((p) => p.length);
    const num = (p: string, scale: number) =>
      p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / scale;
    return {
      rgb: [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255)],
      alpha: parts.length > 3 ? num(parts[3], 1) : 1,
    };
  }
  m = /^hsla?\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter((p) => p.length);
    const h = ((parseFloat(parts[0]) % 360) + 360) % 360;
    const sat = parseFloat(parts[1]) / 100;
    const li = parseFloat(parts[2]) / 100;
    const a = parts.length > 3 ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    return { rgb: hslToRgb(h, sat, li), alpha: a };
  }
  return { rgb: [0, 0, 0], alpha: 1 };
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0,
    g = 0,
    b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function toLinear(rgb: RGB): RGB {
  return [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])];
}

export function toSrgb(rgb: RGB): RGB {
  return [linearToSrgb(rgb[0]), linearToSrgb(rgb[1]), linearToSrgb(rgb[2])];
}

export function luminance(rgb: RGB): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
