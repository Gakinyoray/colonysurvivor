// Seeded RNG + small geometry helpers.
// The original used a Mersenne Twister; for a faithful "feels random but
// reproducible" experience we use a fast seedable PRNG (mulberry32).

let _state = 0x9e3779b9 >>> 0;

export function seed(value) {
  if (typeof value === 'string') {
    let h = 1779033703 ^ value.length;
    for (let i = 0; i < value.length; i++) {
      h = Math.imul(h ^ value.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    _state = h >>> 0;
  } else if (typeof value === 'number') {
    _state = value >>> 0;
  } else {
    _state = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  }
}

export function random() {
  _state |= 0;
  _state = (_state + 0x6d2b79f5) | 0;
  let t = Math.imul(_state ^ (_state >>> 15), 1 | _state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// integer in [0, n)
export function rand(n) {
  return Math.floor(random() * n);
}

// pick by integer weights -> index
export function weightedIndex(weights) {
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) return 0;
  let r = rand(total);
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

export function choice(arr) {
  return arr[rand(arr.length)];
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Point
// ---------------------------------------------------------------------------
export class Point {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  clone() {
    return new Point(this.x, this.y);
  }
  equals(p) {
    return p && this.x === p.x && this.y === p.y;
  }
  static equal(a, b) {
    return a.x === b.x && a.y === b.y;
  }
  static adjacent(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
  }
  static dist(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }
  key() {
    return this.x * 100000 + this.y;
  }
}

// Cardinal directions: N, E, S, W  (delta order matches original dirDeltas)
export const DIRS = [
  new Point(0, -1), // N
  new Point(1, 0), // E
  new Point(0, 1), // S
  new Point(-1, 0), // W
];

export function angleBetween(a, b) {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}
