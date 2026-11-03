import { formatSeed } from './random';
import type { Hit } from './styles';
import { STEP, STEPS_PER_BAR, TICKS_PER_BAR, TRACK_IDS, type Chord, type NoteEvent, type TrackId } from './types';

/** Pitch ranges each part is written in. */
export const REGISTERS: Record<TrackId, { low: number; high: number }> = {
  melody: { low: 64, high: 83 },
  counter: { low: 50, high: 67 },
  brass: { low: 50, high: 76 },
  chords: { low: 50, high: 74 },
  bass: { low: 36, high: 55 },
};

const ID_PREFIX: Record<TrackId, string> = { melody: 'm', counter: 'c', brass: 'r', chords: 'h', bass: 'b' };

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const pc = (p: number) => ((p % 12) + 12) % 12;
export const velocity = (v: number) => clamp(Math.round(v), 1, 127);

export function noteId(track: TrackId, seed: number, index: number): string {
  return `${ID_PREFIX[track]}${formatSeed(seed).toLowerCase()}-${index}`;
}

export function sortNotes(notes: NoteEvent[]): NoteEvent[] {
  return notes.sort(
    (a, b) => a.start - b.start || TRACK_IDS.indexOf(a.track) - TRACK_IDS.indexOf(b.track) || a.pitch - b.pitch,
  );
}

export function chordAt(progression: readonly Chord[], tick: number): Chord {
  for (const chord of progression) {
    if (tick >= chord.start && tick < chord.start + chord.duration) return chord;
  }
  return progression[progression.length - 1];
}

/** The last bar of each four-bar phrase, and of the loop: where fills and changes go, so the bars before it can repeat. */
export const isTurnaround = (bar: number, bars: number) => bar === bars - 1 || bar % 4 === 3;

/** How often each sixteenth of the bar starts a note in `notes` (0–1). A chord counts once. */
export function onsetProfile(notes: readonly NoteEvent[], bars: number): number[] {
  const out = new Array<number>(STEPS_PER_BAR).fill(0);
  for (const start of new Set(notes.map((n) => n.start))) out[Math.floor((start % TICKS_PER_BAR) / STEP)] += 1 / bars;
  return out.map((v) => Math.min(1, v));
}

/** How well a one-bar rhythm sits on a groove: the groove's average weight under its onsets. */
export function lockTo(hits: readonly Hit[], groove: readonly number[]): number {
  return hits.length ? hits.reduce((a, h) => a + (groove[h.step] ?? 0), 0) / hits.length : 0;
}

/** The hits of a one-bar pattern that fall in a chord `span` steps long starting `offset` steps into the bar, from its start. */
export function hitsAt<T extends Hit>(pattern: readonly T[], offset: number, span: number): T[] {
  return fitHits(
    pattern.filter((h) => h.step >= offset && h.step < offset + span).map((h) => ({ ...h, step: h.step - offset })),
    span,
  );
}

/** Clips each hit so it never runs into the next one or past `span` steps. */
export function fitHits<T extends Hit>(hits: readonly T[], span: number): T[] {
  const inSpan = hits.filter((h) => h.step >= 0 && h.step < span).sort((a, b) => a.step - b.step);
  const unique = inSpan.filter((h, i) => i === 0 || h.step !== inSpan[i - 1].step);
  return unique.map((hit, i) => {
    const next = unique[i + 1]?.step ?? span;
    return { ...hit, len: Math.max(1, Math.min(hit.len, next - hit.step)) };
  });
}

/** Index into `pool` of the pitch nearest `pitch`. */
export function nearestIndex(pool: readonly number[], pitch: number): number {
  let best = 0;
  for (let i = 1; i < pool.length; i++) if (Math.abs(pool[i] - pitch) < Math.abs(pool[best] - pitch)) best = i;
  return best;
}

/** Index of the nearest pool pitch whose pitch class passes `accept`, searching `dir` first. */
export function nearestWhere(pool: readonly number[], index: number, dir: number, accept: (pitch: number) => boolean): number {
  const first = dir < 0 ? -1 : 1;
  for (let d = 0; d < pool.length; d++) {
    for (const s of d === 0 ? [0] : [first * d, -first * d]) {
      const i = index + s;
      if (i >= 0 && i < pool.length && accept(pool[i])) return i;
    }
  }
  return index;
}

/**
 * Moves a pitch onto the chord's own scale when it brings one (a borrowed chord or a secondary
 * dominant), a semitone toward one of its tones where possible; otherwise leaves it.
 */
export function fitToChord(pitch: number, chord: Chord): number {
  const { scale, tones } = chord;
  if (!scale || scale.includes(pc(pitch))) return pitch;
  const options = [pitch - 1, pitch + 1].filter((p) => scale.includes(pc(p)));
  return options.find((p) => tones.includes(pc(p))) ?? options[0] ?? pitch;
}

export function snapToChordTone(pool: readonly number[], tones: readonly number[], index: number, dir: number): number {
  return nearestWhere(pool, index, dir, (p) => tones.includes(pc(p)));
}
