import type { Rng } from './random';
import { fitHits } from './shared';
import type { StyleDef } from './styles';
import { STEPS_PER_BAR } from './types';

/**
 * A melodic idea that doesn't depend on key or chord: one bar of rhythm, with
 * each note's height given in scale steps from the first note. Phrases are
 * built by developing motifs (inverting, fragmenting, displacing…) and then
 * realising them over the harmony.
 */
export interface MotifNote {
  step: number;
  len: number;
  /** Scale steps above (or below) the motif's first note. */
  deg: number;
}

export type Motif = MotifNote[];

/** `riff`: repeated notes in two groups, the pitch changing once (see `riffShape`). */
export type ContourKind = 'repeat' | 'pedal' | 'turn' | 'leapBack' | 'zigzag' | 'arpUp' | 'stepDown' | 'octave' | 'arch' | 'call' | 'thirds' | 'riff';

/** Parses a one-bar rhythm: `x` starts a note, `-` holds it, `.` rests. */
export function parseCell(cell: string): { step: number; len: number }[] {
  const hits: { step: number; len: number }[] = [];
  [...cell].forEach((ch, step) => {
    if (ch === 'x') hits.push({ step, len: 1 });
    else if (ch === '-' && hits.length) hits[hits.length - 1].len += 1;
  });
  return hits;
}

/** Sorts, de-duplicates and trims notes so none overlap or leave the bar; first degree becomes 0. */
export function tidy(motif: Motif): Motif {
  const fitted = fitHits(motif, STEPS_PER_BAR);
  if (!fitted.length) return [{ step: 0, len: 2, deg: 0 }];
  const base = fitted[0].deg;
  return fitted.map((n) => ({ ...n, deg: n.deg - base }));
}

/** Pitch shape for `count` notes of a given kind. `octave` is scale steps per octave. */
export function contour(kind: ContourKind, count: number, rng: Rng, octave: number): number[] {
  const out: number[] = [0];
  const dir = rng.chance(0.5) ? 1 : -1;
  const upper = rng.pick([2, 3, 4]);
  const leap = rng.pick([3, 4, 5]);
  for (let i = 1; i < count; i++) {
    const prev = out[i - 1];
    switch (kind) {
      case 'repeat':
        out.push(rng.chance(0.7) ? prev : prev + rng.pick([-1, 1]));
        break;
      case 'pedal':
        out.push(i % 2 === 1 ? upper - (rng.chance(0.3) ? 1 : 0) : 0);
        break;
      case 'turn':
        out.push([0, 1, 0, -1][i % 4] * dir);
        break;
      case 'leapBack':
        if (i === 1) out.push(leap * dir);
        else if (prev !== 0 && Math.sign(prev) === dir) out.push(prev - dir);
        else out.push(prev + rng.pick([-1, 1]));
        break;
      case 'zigzag':
        out.push(prev + (i % 2 === 1 ? 2 : -1) * dir);
        break;
      case 'arpUp':
        out.push(i < 4 ? prev + 2 : prev - 2);
        break;
      case 'stepDown':
        out.push(prev - (rng.chance(0.8) ? 1 : -1));
        break;
      case 'octave':
        out.push(i % 2 === 1 ? octave - (rng.chance(0.25) ? 1 : 0) : rng.chance(0.75) ? 0 : 1);
        break;
      case 'arch':
        // Climbs to a peak halfway through, then comes down.
        out.push(i <= count / 2 ? prev + rng.pick([1, 1, 2]) : prev - rng.pick([1, 1, 2]));
        break;
      case 'call':
        // A leap up to open, then a stepwise fall back.
        out.push(i === 1 ? leap : prev - 1);
        break;
      case 'thirds':
        out.push(prev + 2 * dir * (i <= count / 2 ? 1 : -1));
        break;
      case 'riff':
        out.push(prev);
        break;
    }
  }
  // A little roughness so two motifs of the same kind never come out identical.
  const exact = kind === 'pedal' || kind === 'octave' || kind === 'thirds' || kind === 'riff';
  return out.map((d, i) => (i > 0 && !exact && rng.chance(0.15) ? d + rng.pick([-1, 1]) : d));
}

// ---------------------------------------------------------------------------
// Rhythm cells: idiomatic one-bar figures per style, mutated for variety.

export const CELLS: Record<StyleDef['id'], string[]> = {
  ukg: [
    'x-.x..x-..x-.x..',
    '..x-.x..x-.xx-..',
    'x..x..x.x..x..x.',
    'x-x-..x...x-x...',
    '...x..x-...x-.x-',
    'x.x..x.x..x.x...',
    'x-.x-...x-.x..x.',
  ],
  house: [
    // Riff grooves: straight eighths into a group pushed off the beat, or dotted eighths across the bar.
    'x-x-x..x-x--x-..',
    'x-.x-.x-.x-.x-..',
    'x-x-.x-.x-x-.x-.',
    'x-.x-.x-x-.x-.x-',
    '..x-..x-..x-..x-',
    'x-x-..x-x-..x-..',
    'x---..x-x---x-..',
    'x-.x-.x---x-x-..',
    'x-x-x-..x-..x-x-',
  ],
  deepHouse: [
    'x---..x-----x-..',
    'x-----x-..x---..',
    '..x---x-....x---',
    'x---x-..x-------',
    'x-.x---...x-----',
    'x-..x-..x---x---',
  ],
  melodicHouse: [
    'x---x---x---x---',
    'x-------x---x---',
    'x-x-x---x-x-x---',
    'x-----x-----x---',
    'x---x-x-x-------',
    'x-x---x-x---x-x-',
  ],
  rap: [
    'x--x--x-x-------',
    'x-----x---x-x---',
    'x--x--x---x--x--',
    '..x-..x-x-..x---',
    'x-x---x--x--x---',
    'x--x----x--x-x--',
  ],
};

/**
 * Less expected figures, offered as creativity rises: offbeat starts, 3+3+2 groupings, figures
 * that skip the downbeat.
 */
const BOLD_CELLS: Record<StyleDef['id'], string[]> = {
  ukg: ['.x-.x..x.x-..x-.', 'x..x.x..x-.x.x..', '..x..x-x..x..x-.'],
  house: ['.x-.x-.x-.x-..x-', 'x-.xx-.x..x-x-..', '..x-x-..x-..x-x-'],
  deepHouse: ['..x-----..x-x---', 'x--x--x---..x---', '.x---x---.x-----'],
  melodicHouse: ['x--x--x-x--x--x-', 'x-x-x--x-x-x--x-', '..x-x---..x-x---'],
  rap: ['.x-x..x-.x-..x--', 'x-.x.x..x--x.x..', 'x-x-x-..x--x-x--'],
};

const CONTOURS: Record<StyleDef['id'], [ContourKind, number][]> = {
  ukg: [['repeat', 2], ['pedal', 2], ['turn', 2], ['leapBack', 2], ['zigzag', 1.5], ['riff', 1.5]],
  house: [['riff', 3], ['pedal', 3], ['arpUp', 1.5], ['octave', 1.5], ['stepDown', 1], ['repeat', 2]],
  deepHouse: [['stepDown', 2.5], ['leapBack', 2.5], ['turn', 2], ['arpUp', 1.5], ['zigzag', 1.5], ['riff', 1]],
  melodicHouse: [['arpUp', 3], ['zigzag', 2], ['stepDown', 2], ['leapBack', 2], ['octave', 1], ['riff', 0.5]],
  rap: [['pedal', 2.5], ['repeat', 2], ['turn', 2], ['stepDown', 2], ['leapBack', 1.5], ['riff', 1.5]],
};

/** Contours offered as creativity rises. */
const BOLD_CONTOURS: Record<StyleDef['id'], [ContourKind, number][]> = {
  ukg: [['call', 1.5], ['arch', 1], ['thirds', 1]],
  house: [['arch', 1.5], ['call', 1], ['thirds', 1]],
  deepHouse: [['arch', 1.5], ['call', 1.5], ['thirds', 0.8]],
  melodicHouse: [['arch', 2], ['thirds', 1.5], ['call', 1]],
  rap: [['call', 1.5], ['thirds', 1]],
};

/** Onsets per bar the density asks for. */
export function targetCount(density: number): number {
  return 2.5 + density * 7;
}

function weightedRhythm(
  rng: Rng,
  style: StyleDef,
  density: number,
  avoid: ReadonlySet<number>,
  groove: readonly number[],
): { step: number; len: number }[] {
  const target = Math.max(2, Math.min(12, Math.round(targetCount(density) + rng.float(-1, 1))));
  const weights = style.melodyAccent.map(
    (w, s) => (s % 2 === 1 ? w * (0.35 + density) : w) * (avoid.has(s) ? 0.15 : 1) * (1 + GROOVE_PULL * (groove[s] ?? 0)),
  );
  const chosen = new Set<number>();
  while (chosen.size < target) {
    const free = weights.map((_, s) => s).filter((s) => !chosen.has(s));
    chosen.add(rng.weighted(free, free.map((s) => weights[s])));
  }
  const steps = [...chosen].sort((a, b) => a - b);
  // One articulation for the whole figure: held to the next note, or every note clipped alike.
  const gate = rng.chance(style.melodyRest) ? rng.float(0.35, 0.7) : 1;
  return steps.map((step, i) => {
    const gap = (steps[i + 1] ?? STEPS_PER_BAR) - step;
    const len = Math.min(gap, style.melodyMaxLen);
    return { step, len: len >= 2 ? Math.max(1, Math.round(len * gate)) : len };
  });
}

/** Adds or removes onsets until a cell is about as busy as the density asks. */
function fitDensity(rng: Rng, hits: { step: number; len: number }[], style: StyleDef, density: number) {
  const out = hits.map((h) => ({ ...h }));
  const target = Math.round(targetCount(density));
  while (out.length > Math.max(2, target + 1)) out.splice(rng.int(1, out.length - 1), 1);
  let guard = 0;
  while (out.length < target - 1 && guard++ < 20) {
    const taken = new Set(out.map((h) => h.step));
    const free = style.melodyAccent.map((_, s) => s).filter((s) => !taken.has(s));
    if (!free.length) break;
    out.push({ step: rng.weighted(free, free.map((s) => style.melodyAccent[s])), len: 1 });
  }
  return fitHits(out.sort((a, b) => a.step - b.step), STEPS_PER_BAR);
}

export interface MotifOptions {
  /** Steps the rhythm should steer away from (used to answer in the gaps). */
  avoid?: ReadonlySet<number>;
  contour?: ContourKind;
  /** 0–1: how often bolder rhythm cells and contours are used. */
  creativity?: number;
  /** How often the other parts start a note on each sixteenth (0–1); the rhythm leans toward it. */
  groove?: readonly number[];
}

/** How strongly a melody's rhythm is drawn to where the other parts hit. */
const GROOVE_PULL = 1.5;

/**
 * The pitch shape of a riff: repeated notes in two groups, the way a house riff works. The rhythm
 * carries it and the pitch changes once, on an offbeat or after a gap, so the change itself is
 * syncopated.
 */
export function riffShape(rhythm: readonly { step: number; len: number }[], rng: Rng): number[] {
  const offbeat = (i: number) => {
    const { step } = rhythm[i];
    const gap = rhythm[i - 1].step + rhythm[i - 1].len < step ? 2 : 1;
    return (step % 2 === 1 ? 2 : step % 4 !== 0 ? 1 : 0.4) * gap;
  };
  const splits = rhythm.map((_, i) => i).filter((i) => i > 0 && rhythm[i].step >= 4 && rhythm[i].step <= 12);
  const at = splits.length ? rng.weighted(splits, splits.map(offbeat)) : Math.ceil(rhythm.length / 2);
  const leap = rng.weighted([3, 2, 4, -2, -3, 1], [2.5, 2, 1.5, 1, 1, 0.5]);
  return rhythm.map((_, i) => (i < at ? 0 : leap));
}

/** A fresh motif in the style's idiom. */
export function makeMotif(rng: Rng, style: StyleDef, density: number, octave: number, options: MotifOptions = {}): Motif {
  const avoid = options.avoid ?? new Set<number>();
  const bold = options.creativity ?? 0;
  const groove = options.groove ?? [];
  const table = [...CONTOURS[style.id], ...BOLD_CONTOURS[style.id].map(([k, w]): [ContourKind, number] => [k, w * bold])];
  let kind = options.contour ?? rng.weighted(table.map(([k]) => k), table.map(([, w]) => w));
  // A riff needs a whole groove cell; an answer steering round the call's notes can't have one.
  if (kind === 'riff' && avoid.size) kind = 'repeat';
  const riff = kind === 'riff';
  const fromCell = riff || (!avoid.size && rng.chance(0.6));
  const cells = [...CELLS[style.id], ...BOLD_CELLS[style.id]];
  // Cells that share onsets with the other parts are favoured, so the parts move together. A riff
  // takes its cell as it is, so it also favours cells about as busy as the density asks.
  const cellWeights = cells.map((cell, i) => {
    const hits = parseCell(cell);
    const shared = hits.reduce((a, h) => a + (groove[h.step] ?? 0), 0) / hits.length;
    const fit = riff ? Math.exp(-0.5 * Math.abs(hits.length - targetCount(density))) : 1;
    return (i < CELLS[style.id].length ? 1 : bold * 0.8) * Math.exp(GROOVE_PULL * shared) * fit;
  });
  const cell = fromCell ? parseCell(rng.weighted(cells, cellWeights)) : null;
  const rhythm = cell ? (riff ? cell : fitDensity(rng, cell, style, density)) : weightedRhythm(rng, style, density, avoid, groove);
  const shape = riff ? riffShape(rhythm, rng) : contour(kind, rhythm.length, rng, octave);
  return tidy(rhythm.map((h, i) => ({ ...h, deg: shape[i] })));
}

// ---------------------------------------------------------------------------
// Development

export const invert = (m: Motif): Motif => m.map((n) => ({ ...n, deg: -n.deg }));

/** Same rhythm, a new pitch shape. */
export function reshape(m: Motif, shape: readonly number[]): Motif {
  return tidy(m.map((n, i) => ({ ...n, deg: shape[i] ?? n.deg })));
}

/** Same rhythm, pitches in reverse order. */
export function retrograde(m: Motif): Motif {
  const degs = m.map((n) => n.deg).reverse();
  return tidy(m.map((n, i) => ({ ...n, deg: degs[i] })));
}

/** The first half-bar, stated twice; the repeat optionally shifted. */
export function fragment(m: Motif, shift = 0): Motif {
  const head = m.filter((n) => n.step < 8);
  const source = head.length ? head : m.slice(0, 2);
  return tidy([...source, ...source.map((n) => ({ ...n, step: (n.step % 8) + 8, deg: n.deg + shift }))]);
}

/** The first half-bar at half speed. */
export function augment(m: Motif): Motif {
  const head = m.filter((n) => n.step < 8);
  return tidy((head.length ? head : m).map((n) => ({ step: n.step * 2, len: Math.min(8, n.len * 2), deg: n.deg })));
}

/** Shifted later by `by` steps; anything pushed past the bar is dropped. */
export function displace(m: Motif, by: number): Motif {
  return tidy(m.map((n) => ({ ...n, step: n.step + by })));
}

/** Keeps the first half-bar and gives it a new ending, joined to the head by a step of `join`. */
export function newTail(m: Motif, tailSource: Motif, join = -1): Motif {
  const head = m.filter((n) => n.step < 8);
  const last = head[head.length - 1]?.deg ?? 0;
  const tail = tailSource.filter((n) => n.step >= 8);
  const tailBase = tail[0]?.deg ?? 0;
  return tidy([...head, ...tail.map((n) => ({ ...n, deg: n.deg - tailBase + last + join }))]);
}

/** Notes on the beat (other than the first) nudged a sixteenth late, so the figure leans off the beat. */
export function syncopate(m: Motif): Motif {
  return tidy(m.map((n, i) => (i > 0 && n.step % 4 === 0 ? { ...n, step: n.step + 1, len: Math.max(1, n.len - 1) } : n)));
}

/** A grace note a sixteenth before some of the longer notes, from a step above or below. */
export function ornament(m: Motif, rng: Rng): Motif {
  const out: Motif = [];
  m.forEach((n, i) => {
    const prevEnd = i > 0 ? m[i - 1].step + m[i - 1].len : 0;
    if (i > 0 && n.len >= 3 && n.step - 1 >= prevEnd && rng.chance(0.6)) out.push({ step: n.step - 1, len: 1, deg: n.deg + rng.pick([-1, 1]) });
    out.push(n);
  });
  return tidy(out);
}

/**
 * Small rhythmic and melodic changes; `amount` 0–1. The first half of the bar is kept as it was,
 * so a varied repeat is still heard as the same idea; the change comes in the back half.
 */
export function vary(m: Motif, rng: Rng, amount: number): Motif {
  if (amount <= 0) return m.map((n) => ({ ...n }));
  const head = m.filter((n) => n.step < 8).map((n) => ({ ...n }));
  const tail: Motif = [];
  for (const n of m) {
    if (n.step < 8) continue;
    if (rng.chance(amount * 0.3)) continue;
    const step = rng.chance(amount * 0.25) ? n.step + rng.pick([-1, 1]) : n.step;
    const deg = rng.chance(amount * 0.45) ? n.deg + rng.pick([-1, 1]) : n.deg;
    tail.push({ ...n, step: Math.max(8, step), deg });
  }
  if (rng.chance(amount * 0.4) && tail.length) {
    const host = rng.pick(tail);
    if (host.len >= 2) tail.push({ step: host.step + Math.floor(host.len / 2), len: Math.ceil(host.len / 2), deg: host.deg + rng.pick([-1, 1]) });
  }
  return tidy([...head, ...tail]);
}

/** Highest minus lowest degree. */
export function span(m: Motif): number {
  const degs = m.map((n) => n.deg);
  return Math.max(...degs) - Math.min(...degs);
}

/** Net direction of the motif from first to last note. */
export function motion(m: Motif): number {
  return Math.sign(m[m.length - 1].deg - m[0].deg);
}
