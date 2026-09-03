/**
 * Deterministic pseudo-random number generation.
 *
 * Everything stochastic in the renderer draws from here, so that a given
 * `seed` always reproduces exactly the same image on every machine.
 */

/** Hash an arbitrary string into four 32-bit words (cyrb128). */
export function hashString(str: string): [number, number, number, number] {
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [
    (h1 ^ h2 ^ h3 ^ h4) >>> 0,
    (h2 ^ h1) >>> 0,
    (h3 ^ h1) >>> 0,
    (h4 ^ h1) >>> 0,
  ];
}

/** Normalise any user-supplied seed into a 32-bit unsigned integer. */
export function normalizeSeed(seed: number | string): number {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
  return hashString(String(seed))[0] >>> 0;
}

/** Small, fast, well-distributed 32-bit generator (sfc32). */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number | string) {
    const [a, b, c, d] = typeof seed === 'number' && Number.isFinite(seed)
      ? hashString(`n:${seed >>> 0}`)
      : hashString(String(seed));
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    // Discard a short warm-up run so nearby seeds decorrelate.
    for (let i = 0; i < 12; i++) this.next();
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.a |= 0;
    this.b |= 0;
    this.c |= 0;
    this.d |= 0;
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n) % n;
  }

  /** Standard normal via Box-Muller (one value per call, second discarded). */
  gauss(): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Derive an independent stream, tagged by name, from this generator. */
  fork(tag: string): Rng {
    return new Rng(`${tag}:${(this.next() * 4294967296) >>> 0}`);
  }
}

/**
 * Stateless 2D integer hash -> [0,1). Used by the lattice noises so that
 * sampling is order-independent and tile-free.
 */
export function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Stateless 2D integer hash -> two independent values in [0,1). */
export function hash2v(x: number, y: number, seed: number, out: [number, number]): [number, number] {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  out[0] = (h >>> 0) / 4294967296;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  out[1] = (h >>> 0) / 4294967296;
  return out;
}
