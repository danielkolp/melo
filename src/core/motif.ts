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

/**
 * `riff`: repeated notes in two groups, the pitch changing once (see `riffShape`). `anchor`: one
 * home note repeated, with a single signature move away and back, the way a vocal chop works.
 */
export type ContourKind =
  | 'repeat'
  | 'pedal'
  | 'turn'
  | 'leapBack'
  | 'zigzag'
  | 'arpUp'
  | 'stepDown'
  | 'octave'
  | 'arch'
  | 'call'
  | 'thirds'
  | 'riff'
  | 'anchor';

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
  if (kind === 'anchor') {
    const out = new Array<number>(count).fill(0);
    if (count < 2) return out;
    // The move comes late in the figure, after the home note has been heard.
    const slots = Array.from({ length: count - 1 }, (_, i) => i + 1);
    const at = rng.weighted(slots, slots.map((i) => 0.5 + i / count));
    const jump = rng.weighted([2, 3, 4, -1, -2], [2, 2, 1.2, 1.5, 1]);
    out[at] = jump;
    if (at + 1 < count && rng.chance(0.5)) out[at + 1] = jump - Math.sign(jump);
    return out;
  }
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
  // A little roughness so two motifs of the same kind differ, kept small so the shape still reads.
  const exact = kind === 'pedal' || kind === 'octave' || kind === 'thirds' || kind === 'riff' || kind === 'repeat';
  return out.map((d, i) => (i > 0 && !exact && rng.chance(0.08) ? d + rng.pick([-1, 1]) : d));
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
  ukg: [['anchor', 3], ['repeat', 2], ['pedal', 2], ['turn', 2], ['leapBack', 2], ['zigzag', 1], ['riff', 1.5]],
  house: [['riff', 3], ['pedal', 3], ['anchor', 1.5], ['arpUp', 1.5], ['octave', 1.5], ['stepDown', 1], ['repeat', 2]],
  deepHouse: [['stepDown', 2.5], ['leapBack', 2.5], ['turn', 2], ['anchor', 1], ['arpUp', 1.5], ['zigzag', 1.5], ['riff', 1]],
  melodicHouse: [['arpUp', 3], ['zigzag', 2], ['stepDown', 2], ['leapBack', 2], ['octave', 1], ['anchor', 0.5], ['riff', 0.5]],
  rap: [['anchor', 2.5], ['pedal', 2.5], ['repeat', 2], ['turn', 2], ['stepDown', 2], ['leapBack', 1.5], ['riff', 1.5]],
};

/** Contours offered as creativity rises. */
const BOLD_CONTOURS: Record<StyleDef['id'], [ContourKind, number][]> = {
  ukg: [['call', 1.5], ['arch', 1], ['thirds', 1]],
  house: [['arch', 1.5], ['call', 1], ['thirds', 1]],
  deepHouse: [['arch', 1.5], ['call', 1.5], ['thirds', 0.8]],
  melodicHouse: [['arch', 2], ['thirds', 1.5], ['call', 1]],
  rap: [['call', 1.5], ['thirds', 1]],
};

/**
 * Onsets per bar the density asks for, by style. UKG and deep house toplines leave space, the
 * way a vocal does; house and melodic house riffs run a little busier.
 */
const NOTES: Record<StyleDef['id'], [number, number]> = {
  ukg: [2, 5.5],
  house: [2.5, 6.5],
  deepHouse: [2, 6],
  melodicHouse: [2.5, 6.5],
  rap: [2.5, 6],
};

export function targetCount(density: number, style: StyleDef['id'] = 'house'): number {
  const [base, span] = NOTES[style];
  return base + density * span;
}

function weightedRhythm(
  rng: Rng,
  style: StyleDef,
  density: number,
  avoid: ReadonlySet<number>,
  groove: readonly number[],
): { step: number; len: number }[] {
  const target = Math.max(2, Math.min(12, Math.round(targetCount(density, style.id) + rng.float(-1, 1))));
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

/**
 * Brings a cell to about the busyness the density asks for without losing its shape: the weakest
 * hits make way (never the first), or the longest note splits into a repeated pair.
 */
function fitDensity(hits: { step: number; len: number }[], style: StyleDef, density: number) {
  let out = hits.map((h) => ({ ...h }));
  const target = Math.round(targetCount(density, style.id));
  while (out.length > Math.max(2, target + 1)) {
    let weakest = 1;
    for (let i = 2; i < out.length; i++) if (style.melodyAccent[out[i].step] < style.melodyAccent[out[weakest].step]) weakest = i;
    out.splice(weakest, 1);
  }
  for (let guard = 0; out.length < target - 1 && guard < 8; guard++) {
    let longest = -1;
    out.forEach((h, i) => {
      if (h.len >= 2 && (longest < 0 || h.len > out[longest].len)) longest = i;
    });
    if (longest < 0) break;
    const h = out[longest];
    const half = Math.ceil(h.len / 2);
    out = [...out.slice(0, longest), { step: h.step, len: half }, { step: h.step + half, len: h.len - half }, ...out.slice(longest + 1)];
  }
  return fitHits(out, STEPS_PER_BAR);
}

/**
 * One small, seeded change to a style cell, so two loops that draw the same cell still get their
 * own rhythm: a hit nudged a sixteenth (never the first), a note split into a repeated pair, or a
 * hit tied over into the next. The figure is made once per motif, so it stays the loop's own.
 */
function personalise(rng: Rng, hits: { step: number; len: number }[]): { step: number; len: number }[] {
  if (!rng.chance(0.7) || hits.length < 2) return hits;
  const taken = new Set(hits.map((h) => h.step));
  const move = rng.weighted(['nudge', 'split', 'tie'] as const, [2, 1, 1]);
  if (move === 'nudge') {
    const i = rng.int(1, hits.length - 1);
    const to = hits[i].step + rng.pick([-1, 1]);
    if (to <= hits[i - 1].step || to >= STEPS_PER_BAR || taken.has(to)) return hits;
    return fitHits(hits.map((h, k) => (k === i ? { step: to, len: h.len } : k === i - 1 ? { ...h, len: Math.min(h.len, to - h.step) } : h)), STEPS_PER_BAR);
  }
  if (move === 'split') {
    const long = hits.map((_, i) => i).filter((i) => hits[i].len >= 2);
    if (!long.length) return hits;
    const i = rng.pick(long);
    const half = Math.ceil(hits[i].len / 2);
    return fitHits([...hits.slice(0, i), { step: hits[i].step, len: half }, { step: hits[i].step + half, len: hits[i].len - half }, ...hits.slice(i + 1)], STEPS_PER_BAR);
  }
  const i = rng.int(0, hits.length - 2);
  const merged = { step: hits[i].step, len: hits[i + 1].step + hits[i + 1].len - hits[i].step };
  return hits.length > 2 ? fitHits([...hits.slice(0, i), merged, ...hits.slice(i + 2)], STEPS_PER_BAR) : hits;
}

/**
 * A half-bar figure stated twice, the second time a little changed: a sixteenth later, cut short,
 * or with one note added. Repetition inside the bar is what makes a line easy to remember.
 */
function echoRhythm(rng: Rng, style: StyleDef, density: number): { step: number; len: number }[] {
  const per = Math.max(1, Math.min(5, Math.round(targetCount(density, style.id) / 2)));
  const weights = style.melodyAccent.slice(0, 8);
  const chosen = new Set<number>([rng.weighted([0, 1, 2, 3], weights.slice(0, 4))]);
  while (chosen.size < per) {
    const free = [0, 1, 2, 3, 4, 5, 6, 7].filter((s) => !chosen.has(s));
    chosen.add(rng.weighted(free, free.map((s) => weights[s] + 0.05)));
  }
  const head = [...chosen].sort((a, b) => a - b);
  let tail = head.map((s) => s + 8);
  const change = rng.weighted(['same', 'shift', 'trim', 'add'] as const, [3, 1.5, 1.5, 1]);
  if (change === 'shift') tail = tail.map((s, i) => (i === tail.length - 1 && s + 1 < STEPS_PER_BAR ? s + 1 : s));
  if (change === 'trim' && tail.length > 1) tail = tail.slice(0, -1);
  if (change === 'add') {
    const free = [9, 10, 11, 12, 13, 14, 15].filter((s) => !tail.includes(s));
    if (free.length) tail = [...tail, rng.pick(free)].sort((a, b) => a - b);
  }
  const steps = [...head, ...tail];
  const gate = rng.chance(style.melodyRest) ? rng.float(0.4, 0.75) : 1;
  return steps.map((step, i) => {
    const gap = (steps[i + 1] ?? STEPS_PER_BAR) - step;
    const len = Math.min(gap, style.melodyMaxLen);
    return { step, len: len >= 2 ? Math.max(1, Math.round(len * gate)) : len };
  });
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
  // A style cell, or a half-bar figure echoed; free onsets only for answers that must steer round the call.
  const fromCell = riff || (!avoid.size && rng.chance(0.55));
  const echo = !fromCell && !avoid.size && rng.chance(0.8);
  const cells = [...CELLS[style.id], ...BOLD_CELLS[style.id]];
  // Cells that share onsets with the other parts are favoured, so the parts move together. A riff
  // takes its cell as it is, so it also favours cells about as busy as the density asks.
  const cellWeights = cells.map((cell, i) => {
    const hits = parseCell(cell);
    const shared = hits.reduce((a, h) => a + (groove[h.step] ?? 0), 0) / hits.length;
    const fit = riff ? Math.exp(-0.5 * Math.abs(hits.length - targetCount(density, style.id))) : 1;
    return (i < CELLS[style.id].length ? 1 : bold * 0.8) * Math.exp(GROOVE_PULL * shared) * fit;
  });
  const cell = fromCell ? parseCell(rng.weighted(cells, cellWeights)) : null;
  const rhythm = cell
    ? riff
      ? cell
      : personalise(rng, fitDensity(cell, style, density))
    : echo
      ? echoRhythm(rng, style, density)
      : weightedRhythm(rng, style, density, avoid, groove);
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
