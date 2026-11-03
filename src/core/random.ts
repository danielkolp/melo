/** Small seedable PRNG (mulberry32) plus helpers. Same seed, same sequence. */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  float(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    float: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new Error('pick() from an empty list');
      return items[Math.floor(next() * items.length)];
    },
    weighted: (items, weights) => {
      if (items.length === 0) throw new Error('weighted() from an empty list');
      let total = 0;
      for (const w of weights) total += Math.max(0, w);
      if (total <= 0) return items[Math.floor(next() * items.length)];
      let r = next() * total;
      for (let i = 0; i < items.length; i++) {
        r -= Math.max(0, weights[i] ?? 0);
        if (r < 0) return items[i];
      }
      return items[items.length - 1];
    },
  };
}

/** FNV-1a 32-bit string hash. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Derive an independent, stable sub-seed from a seed and a label. */
export function deriveSeed(seed: number, label: string): number {
  let h = (seed ^ hashString(label)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A fresh non-deterministic seed. Only the UI layer should call this. */
export function randomSeed(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] >>> 0;
}

export function formatSeed(seed: number): string {
  return (seed >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

/** Parses an 8-digit hex seed; returns null for anything else. */
export function parseSeed(text: string): number | null {
  const clean = text.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,8}$/i.test(clean)) return null;
  return parseInt(clean, 16) >>> 0;
}
