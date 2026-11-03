import { drumPattern } from './beat';
import { resolveForm } from './melody';
import { contour, type ContourKind } from './motif';
import { createRng, deriveSeed, type Rng } from './random';
import { REGISTERS, chordAt, clamp, fitToChord, isTurnaround, lerp, lockTo, nearestIndex, noteId, onsetProfile, pc, snapToChordTone, velocity } from './shared';
import { SCALES, pitchesInRange, scalePitchClasses } from './theory';
import { STEP, STEPS_PER_BAR, TICKS_PER_BAR, type Chord, type CompositionSettings, type NoteEvent, type StyleId } from './types';

/**
 * The brass: a horn section whose job changes from loop to loop. It punches stabs into the groove,
 * answers the melody in its gaps, swells under the chord changes, or doubles the hook underneath.
 * The part's seed decides which, where in the loop it comes in, and whether it plays in harmony.
 * It is written last, around the other parts, and stays under the melody wherever they meet.
 */

export type BrassKind = 'stabs' | 'answer' | 'swells' | 'double';
/** Where the brass plays: every bar, the second half of the loop, or the last bar of each phrase. */
export type BrassEntry = 'all' | 'late' | 'ends';

export interface BrassPlan {
  kind: BrassKind;
  entry: BrassEntry;
  /** For answers and doubles: a second horn this many scale steps below the first (2 = thirds, 5 = sixths), or 0 for one line. */
  harmony: 0 | 2 | 5;
}

export const BRASS_KINDS: Record<BrassKind, string> = {
  stabs: 'Stabs',
  answer: 'Answers',
  swells: 'Swells',
  double: 'Doubles',
};

export const BRASS_ENTRIES: Record<BrassEntry, string> = {
  all: 'every bar',
  late: 'second half',
  ends: 'phrase ends',
};

const KINDS: Record<StyleId, [BrassKind, number][]> = {
  ukg: [['stabs', 2], ['answer', 2], ['double', 1], ['swells', 0.8]],
  house: [['stabs', 3], ['answer', 2], ['swells', 1], ['double', 1]],
  deepHouse: [['swells', 2.5], ['answer', 1.5], ['stabs', 1], ['double', 0.6]],
  melodicHouse: [['swells', 2.5], ['double', 1.5], ['answer', 1], ['stabs', 0.6]],
  rap: [['stabs', 3], ['swells', 1.5], ['answer', 1.5], ['double', 1]],
};

const ENTRIES: Record<BrassKind, [BrassEntry, number][]> = {
  stabs: [['all', 2], ['ends', 1.5], ['late', 1]],
  answer: [['all', 2], ['late', 1.5], ['ends', 0.7]],
  swells: [['all', 2], ['late', 1]],
  double: [['late', 2], ['all', 1]],
};

/** What the brass does in this loop. In a trade the counter-melody already answers the melody, so the brass doesn't. */
export function brassPlan(settings: Pick<CompositionSettings, 'style' | 'trackSeeds' | 'phrase'>): BrassPlan {
  const rng = createRng(deriveSeed(settings.trackSeeds.brass, 'plan'));
  const trade = resolveForm(settings) === 'trade';
  const kinds = KINDS[settings.style].map(([k, w]): [BrassKind, number] => [k, k === 'answer' && trade ? 0 : w]);
  const kind = rng.weighted(kinds.map(([k]) => k), kinds.map(([, w]) => w));
  const entries = ENTRIES[kind];
  const entry = rng.weighted(entries.map(([e]) => e), entries.map(([, w]) => w));
  const harmony = rng.weighted([0, 2, 5] as const, [1.5, 2, 1]);
  return { kind, entry, harmony };
}

/** Whether the brass plays in a bar. */
function plays(entry: BrassEntry, bar: number, bars: number): boolean {
  if (entry === 'late') return bar >= bars / 2;
  if (entry === 'ends') return isTurnaround(bar, bars);
  return true;
}

/**
 * A horn-section voicing of a chord: a top note from the chord, nearest `near` and no higher than
 * `ceiling`, with up to `size - 1` chord tones stacked close below it, at least a minor third apart.
 */
export function hornVoicing(chord: Chord, near: number, size: number, ceiling = REGISTERS.brass.high): number[] {
  const { low } = REGISTERS.brass;
  const triad = chord.tones.slice(0, 3);
  let top = -1;
  for (let p = Math.min(ceiling, REGISTERS.brass.high); p >= low + 4; p--) {
    if (triad.includes(pc(p)) && (top < 0 || Math.abs(p - near) < Math.abs(top - near))) top = p;
  }
  if (top < 0) return [];
  const out = [top];
  for (let p = top - 3; p >= low && out.length < size; p--) {
    if (chord.tones.includes(pc(p)) && out[out.length - 1] - p >= 3) out.push(p);
  }
  return out;
}

/** For each sixteenth of the bar, how often a part is sounding there across the loop (0–1). */
function busyness(notes: readonly NoteEvent[], bars: number): number[] {
  const busy = new Array<number>(STEPS_PER_BAR).fill(0);
  const seen = new Set<string>();
  for (const n of notes) {
    for (let s = Math.floor(n.start / STEP); s < Math.ceil((n.start + n.duration) / STEP); s++) {
      if (seen.has(`${s}`)) continue;
      seen.add(`${s}`);
      busy[s % STEPS_PER_BAR] += 1 / bars;
    }
  }
  return busy.map((b) => Math.min(1, b));
}

const quiet = (busy: readonly number[], from: number, to: number) => {
  let sum = 0;
  for (let s = from; s < to; s++) sum += 1 - busy[s % STEPS_PER_BAR];
  return sum / Math.max(1, to - from);
};

/** The lowest melody note sounding anywhere in [start, end), or Infinity. */
function melodyFloor(melody: readonly NoteEvent[], start: number, end: number): number {
  let floor = Infinity;
  for (const n of melody) if (n.start < end && n.start + n.duration > start) floor = Math.min(floor, n.pitch);
  return floor;
}

/** Horn hits, as `x` for a hit, `-` to hold it and `.` to rest: pushes, off-beat stabs, pickups into the next bar. */
const STAB_CELLS = [
  'x-.x-.x-........',
  '......x-..x-....',
  'x-......x-.x-...',
  '..x-..x-..x-..x-',
  '............x-x-',
  'x---......x-....',
  '....x-.x-.......',
  'x-.......x-.x-..',
  '..x-......x-x-..',
  '......x.x-......',
];

const parse = (cell: string) => {
  const hits: { step: number; len: number }[] = [];
  [...cell].forEach((ch, step) => {
    if (ch === 'x') hits.push({ step, len: 1 });
    else if (ch === '-' && hits.length) hits[hits.length - 1].len++;
  });
  return hits;
};

interface Ctx {
  settings: CompositionSettings;
  progression: readonly Chord[];
  rng: Rng;
  plan: BrassPlan;
  melody: readonly NoteEvent[];
  /** The melody and counter-melody together: where the brass should leave room. */
  busy: number[];
  push: (pitch: number, start: number, duration: number, accent: number) => void;
}

/** Stabs: one rhythm, chosen for how it locks to the groove and how much room the melody leaves it, played every bar it plays. */
function stabs(ctx: Ctx, around: readonly NoteEvent[]): void {
  const { settings, progression, rng, plan, melody, busy, push } = ctx;
  const kick = new Set(drumPattern(settings).kick);
  const groove = onsetProfile(around, settings.bars).map((v, s) => Math.max(v, kick.has(s) ? 0.5 : 0));
  const cells = STAB_CELLS.map(parse);
  const cell = rng.weighted(
    cells,
    cells.map((c) => Math.exp(2 * lockTo(c, groove)) * (quiet(busy, c[0].step, c[c.length - 1].step + 1) ** 2 + 0.05)),
  );
  const size = rng.pick([2, 3, 3]);
  let near = rng.int(66, 72);
  for (let bar = 0; bar < settings.bars; bar++) {
    if (!plays(plan.entry, bar, settings.bars)) continue;
    cell.forEach((hit, i) => {
      const start = (bar * STEPS_PER_BAR + hit.step) * STEP;
      const duration = hit.len * STEP;
      const chord = chordAt(progression, start);
      const voicing = hornVoicing(chord, near, size, melodyFloor(melody, start, start + duration) - 2);
      if (!voicing.length) return;
      near = voicing[0];
      for (const pitch of voicing) push(pitch, start, duration, i === 0 || hit.step % 4 === 0 ? 100 : 92);
    });
  }
}

/** Swells: each chord held by the section, coming in on the downbeat or a beat late, and letting go just before the next. */
function swells(ctx: Ctx): void {
  const { settings, progression, rng, plan, melody, push } = ctx;
  const late = rng.chance(0.4) ? 4 : 0;
  const size = rng.pick([2, 3]);
  let near = rng.int(62, 68);
  for (const chord of progression) {
    const bar = Math.floor(chord.start / TICKS_PER_BAR);
    if (!plays(plan.entry, bar, settings.bars)) continue;
    const offset = chord.duration > STEP * 8 ? late * STEP : 0;
    const start = chord.start + offset;
    const duration = chord.duration - offset - STEP * 2;
    if (duration < STEP * 2) continue;
    const voicing = hornVoicing(chord, near, size, melodyFloor(melody, start, start + duration) - 2);
    if (!voicing.length) continue;
    near = voicing[0];
    for (const pitch of voicing) push(pitch, start, duration, 74);
  }
}

const ANSWER_CONTOURS: [ContourKind, number][] = [['stepDown', 2], ['repeat', 1.5], ['turn', 1.5], ['call', 1], ['arch', 1]];

/** Answers: a short figure in the quietest part of the bar, built on each chord's guide tone, in one line or two. */
function answers(ctx: Ctx, pool: readonly number[]): void {
  const { settings, progression, rng, plan, melody, busy, push } = ctx;
  const count = clamp(Math.round(lerp(2, 4.4, settings.density) + rng.float(-0.6, 0.6)), 2, 5);
  const space = rng.pick(count > 3 ? [1, 2, 2] : [2, 2, 3]);
  const span = space * (count - 1);
  const starts = Array.from({ length: STEPS_PER_BAR - span }, (_, s) => s);
  const s0 = rng.weighted(starts, starts.map((s) => quiet(busy, s, s + span + 1) ** 4 + 0.01));
  const gate = rng.pick([1, space, space]);
  const steps = Array.from({ length: count }, (_, i) => s0 + i * space);
  const octave = SCALES[settings.scale].intervals.length;
  const shape = contour(rng.weighted(ANSWER_CONTOURS.map(([k]) => k), ANSWER_CONTOURS.map(([, w]) => w)), count, rng, octave);
  let near = rng.int(64, 70);
  for (let bar = 0; bar < settings.bars; bar++) {
    if (!plays(plan.entry, bar, settings.bars)) continue;
    const first = chordAt(progression, (bar * STEPS_PER_BAR + steps[0]) * STEP);
    const guide = hornVoicing(first, near, 1)[0];
    if (guide === undefined) continue;
    near = guide;
    const anchor = nearestIndex(pool, guide);
    steps.forEach((step, i) => {
      const start = (bar * STEPS_PER_BAR + step) * STEP;
      const duration = Math.max(1, Math.min(gate, space)) * STEP;
      const chord = chordAt(progression, start);
      let index = clamp(anchor + shape[i], 0, pool.length - 1);
      if (step % 4 === 0) index = snapToChordTone(pool, chord.tones, index, Math.sign(shape[i] - (shape[i - 1] ?? shape[i])));
      let pitch = fitToChord(pool[index], chord, REGISTERS.brass);
      const floor = melodyFloor(melody, start, start + duration);
      if (pitch > floor - 2) pitch -= 12;
      if (pitch < REGISTERS.brass.low || pitch > floor - 2) return;
      push(pitch, start, duration, step % 4 === 0 ? 92 : 86);
      if (plan.harmony) {
        const below = fitToChord(pool[clamp(nearestIndex(pool, pitch) - plan.harmony, 0, pool.length - 1)], chord, REGISTERS.brass);
        if (below >= REGISTERS.brass.low && below < pitch - 2) push(below, start, duration, 80);
      }
    });
  }
}

/** Doubles: the melody's own notes underneath it, an octave down, or in thirds or sixths below. Its chromatic passing notes are left to the melody. */
function doubles(ctx: Ctx, pool: readonly number[]): void {
  const { settings, progression, plan, melody, push } = ctx;
  const { low, high } = REGISTERS.brass;
  const key = new Set(pool.map(pc));
  for (const n of melody) {
    if (!plays(plan.entry, Math.floor(n.start / TICKS_PER_BAR), settings.bars)) continue;
    const chord = chordAt(progression, n.start);
    if (!key.has(pc(n.pitch)) && !(chord.scale ?? chord.tones).includes(pc(n.pitch))) continue;
    let pitch = plan.harmony ? fitToChord(pool[clamp(nearestIndex(pool, n.pitch) - plan.harmony, 0, pool.length - 1)], chord, REGISTERS.brass) : n.pitch - 12;
    while (pitch > high || pitch > n.pitch - 3) pitch -= 12;
    while (pitch < low) pitch += 12;
    if (pitch > high || pitch > n.pitch - 3) continue;
    push(pitch, n.start, n.duration, Math.max(60, n.velocity - 8));
  }
}

/**
 * The brass part. `melody` and `counter` are what it leaves room for; `around` (the chords and
 * bass) is the groove its stabs lock to.
 */
export function generateBrass(
  settings: CompositionSettings,
  progression: readonly Chord[],
  melody: readonly NoteEvent[],
  counter: readonly NoteEvent[],
  around: readonly NoteEvent[],
): NoteEvent[] {
  const seed = settings.trackSeeds.brass;
  const rng = createRng(seed);
  const plan = brassPlan(settings);
  const { low, high } = REGISTERS.brass;
  const pool = pitchesInRange(scalePitchClasses(settings.key, settings.scale), low - 12, high);
  const notes: NoteEvent[] = [];
  const taken = new Set<string>();
  const push = (pitch: number, start: number, duration: number, accent: number) => {
    const key = `${pitch}:${start}`;
    if (taken.has(key) || pitch < low || pitch > high) return;
    taken.add(key);
    notes.push({ id: noteId('brass', seed, notes.length), track: 'brass', pitch, start, duration, velocity: velocity(accent + rng.float(-4, 4)) });
  };
  const ctx: Ctx = { settings, progression, rng, plan, melody, busy: busyness([...melody, ...counter], settings.bars), push };
  if (plan.kind === 'stabs') stabs(ctx, around);
  if (plan.kind === 'swells') swells(ctx);
  if (plan.kind === 'answer') answers(ctx, pool);
  if (plan.kind === 'double') doubles(ctx, pool);
  // Nothing found room (a busy melody low in its register, say): the section holds the chords instead.
  if (!notes.length && plan.kind !== 'swells') swells(ctx);
  if (!notes.length) swells({ ...ctx, plan: { ...plan, entry: 'all' } });
  return notes.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
}
