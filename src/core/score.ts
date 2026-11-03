import { drumPattern } from './beat';
import { BASS_FEEL, CHORD_FEEL } from './plan';
import { chordAt, pc } from './shared';
import { STEP, STEPS_PER_BAR, TICKS_PER_BAR, type Chord, type Composition, type CompositionSettings, type NoteEvent, type StyleId, type TrackId } from './types';

/**
 * Structural measurements of a loop: how its parts repeat, move, meet the harmony and sit with
 * each other. They are proxies for what makes a part work, not a verdict on how it sounds. The
 * evaluation harness reports them across many seeds; the generator scores its takes with them.
 */

const byStart = (notes: readonly NoteEvent[]) => [...notes].sort((a, b) => a.start - b.start || b.pitch - a.pitch);
const stepOf = (tick: number) => Math.floor(tick / STEP);
const barOf = (tick: number) => Math.floor(tick / TICKS_PER_BAR);
const inBar = (tick: number) => stepOf(tick) % STEPS_PER_BAR;
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);
const share = <T,>(xs: readonly T[], test: (x: T) => boolean) => (xs.length ? xs.filter(test).length / xs.length : 0);

/** One note at a time, the top one where two start together. */
function line(notes: readonly NoteEvent[]): NoteEvent[] {
  return byStart(notes).filter((n, i, all) => i === 0 || n.start !== all[i - 1].start);
}

/** Each bar's onsets, as a string, so bars can be compared. */
function barRhythms(notes: readonly NoteEvent[], bars: number): string[] {
  const out = Array.from({ length: bars }, () => [] as number[]);
  for (const n of notes) out[barOf(n.start)]?.push(inBar(n.start));
  return out.map((steps) => [...new Set(steps)].sort((a, b) => a - b).join(','));
}

/** Each bar's shape: onsets with the direction of each move, so a transposed repeat still matches. */
function barShapes(notes: readonly NoteEvent[], bars: number): string[] {
  const out = Array.from({ length: bars }, () => [] as string[]);
  const l = line(notes);
  l.forEach((n, i) => {
    const prev = l[i - 1];
    const move = prev && barOf(prev.start) === barOf(n.start) ? Math.sign(n.pitch - prev.pitch) : 0;
    out[barOf(n.start)]?.push(`${inBar(n.start)}${'-=+'[move + 1]}`);
  });
  return out.map((s) => s.join(','));
}

/** Of the bars that play, the share whose signature turns up in another bar too. */
function recurrence(signatures: readonly string[]): number {
  const playing = signatures.filter((s) => s.length);
  return share(playing, (s) => playing.filter((t) => t === s).length > 1);
}

export interface MelodyMetrics {
  notesPerBar: number;
  /** Share of the loop's sixteenths with no melody sounding. */
  restShare: number;
  rhythmRecurrence: number;
  shapeRecurrence: number;
  distinctRhythms: number;
  /** Moves of a tone or less, repeats included. */
  stepRatio: number;
  repeatRatio: number;
  /** After a leap of a fourth or more, how often the line turns back. */
  leapRecovery: number;
  range: number;
  /** Notes on beats 1 and 3 that are chord tones. */
  strongChordTones: number;
  /** Long notes on beats 1 and 3 off the chord that don't resolve by step, per bar. */
  unresolved: number;
  endResolves: number;
  /** Onsets off the beat. */
  offbeat: number;
  /** Which bar of each four holds the phrase's top note, as a share landing in the third. */
  peakInThird: number;
}

export function melodyMetrics(notes: readonly NoteEvent[], progression: readonly Chord[], bars: number): MelodyMetrics {
  const l = line(notes);
  const steps = bars * STEPS_PER_BAR;
  const sounding = new Array<boolean>(steps).fill(false);
  for (const n of l) for (let s = stepOf(n.start); s < Math.min(steps, stepOf(n.start + n.duration - 1) + 1); s++) sounding[s] = true;
  const moves = l.slice(1).map((n, i) => n.pitch - l[i].pitch);
  const leaps = moves.map((m, i) => ({ m, next: moves[i + 1] })).filter(({ m, next }) => Math.abs(m) >= 5 && next !== undefined);
  const strong = l.filter((n) => inBar(n.start) % 8 === 0);
  const tones = (n: NoteEvent) => chordAt(progression, n.start).tones.includes(pc(n.pitch));
  const unresolved = l.filter((n, i) => {
    if (inBar(n.start) % 8 !== 0 || n.duration < STEP * 2 || tones(n)) return false;
    const next = l[i + 1];
    return !next || Math.abs(next.pitch - n.pitch) > 2 || !tones(next);
  }).length;
  const last = l[l.length - 1];
  const rhythms = barRhythms(l, bars);
  const peaks: number[] = [];
  for (let p = 0; p + 4 <= bars; p += 4) {
    const phrase = l.filter((n) => barOf(n.start) >= p && barOf(n.start) < p + 4);
    if (!phrase.length) continue;
    const top = Math.max(...phrase.map((n) => n.pitch));
    peaks.push(phrase.some((n) => n.pitch === top && barOf(n.start) === p + 2) ? 1 : 0);
  }
  return {
    notesPerBar: l.length / bars,
    restShare: share(sounding, (s) => !s),
    rhythmRecurrence: recurrence(rhythms),
    shapeRecurrence: recurrence(barShapes(l, bars)),
    distinctRhythms: new Set(rhythms.filter((r) => r)).size,
    stepRatio: share(moves, (m) => Math.abs(m) <= 2),
    repeatRatio: share(moves, (m) => m === 0),
    leapRecovery: share(leaps, ({ m, next }) => Math.sign(next!) === -Math.sign(m)),
    range: l.length ? Math.max(...l.map((n) => n.pitch)) - Math.min(...l.map((n) => n.pitch)) : 0,
    strongChordTones: share(strong, tones),
    unresolved: unresolved / bars,
    endResolves: last && chordAt(progression, last.start).tones.slice(0, 3).includes(pc(last.pitch)) ? 1 : 0,
    offbeat: share(l, (n) => inBar(n.start) % 4 !== 0),
    peakInThird: mean(peaks),
  };
}

export interface BassMetrics {
  notesPerBar: number;
  /** Onsets on a kick. */
  reinforce: number;
  /** Onsets one to three sixteenths after a kick, where there's no kick. */
  answer: number;
  /** Onsets on the backbeat. */
  onClap: number;
  /** Bars that repeat the bar before, and the bar two before. */
  period1: number;
  period2: number;
  /** Length over the gap to the next note. */
  gate: number;
  /** Short, quiet notes. */
  ghost: number;
}

export function bassMetrics(notes: readonly NoteEvent[], settings: Pick<CompositionSettings, 'style' | 'seed'>, bars: number): BassMetrics {
  const l = line(notes);
  const { kick, clap } = drumPattern(settings);
  const kicks = new Set(kick);
  const onsets = l.map((n) => inBar(n.start));
  const answered = (s: number) => !kicks.has(s) && [1, 2, 3].some((d) => kicks.has(s - d));
  const rhythms = barRhythms(l, bars);
  const compare = (gap: number) => {
    const pairs = rhythms.map((r, i) => [r, rhythms[i + gap]] as const).filter(([a, b], i) => b !== undefined && a && (i + gap) % 4 !== 3);
    return share(pairs, ([a, b]) => a === b);
  };
  const end = bars * TICKS_PER_BAR;
  return {
    notesPerBar: l.length / bars,
    reinforce: share(onsets, (s) => kicks.has(s)),
    answer: share(onsets, answered),
    onClap: share(onsets, (s) => clap.includes(s)),
    period1: compare(1),
    period2: compare(2),
    gate: mean(l.map((n, i) => n.duration / Math.max(STEP, (l[i + 1]?.start ?? end) - n.start))),
    ghost: share(l, (n) => n.duration <= STEP && n.velocity < 72),
  };
}

// ---------------------------------------------------------------------------
// Scores for choosing between takes

/**
 * The best-scoring take among those about as busy as the first, the seed's own. Takes are
 * compared like for like, so choosing between them never overrides the density setting.
 */
export function pickTake<T extends { notes: readonly NoteEvent[]; score: number }>(takes: readonly T[]): T {
  const base = takes[0].notes.length;
  const close = takes.filter((t) => Math.abs(t.notes.length - base) <= Math.max(2, base * 0.15));
  return close.reduce((a, b) => (b.score > a.score ? b : a));
}

/** A range a measurement should fall in. */
type Window = readonly [number, number];

/** Nothing inside the window; outside it, the distance in units of `scale`. */
const miss = (value: number, [lo, hi]: Window, scale: number) => (value < lo ? (lo - value) / scale : value > hi ? (value - hi) / scale : 0);

/** A note pushed up to two sixteenths ahead of a barline and held over it counts as the downbeat it anticipates. */
function onTheBeat(notes: readonly NoteEvent[], bars: number): NoteEvent[] {
  return notes.map((n) => {
    const next = (barOf(n.start) + 1) * TICKS_PER_BAR;
    const early = next - n.start;
    return early <= 2 * STEP && n.start + n.duration > next && barOf(next) < bars ? { ...n, start: next, duration: n.duration - early } : n;
  });
}

/** How far off the beat each style's toplines sit, and how wide they range, in semitones. */
const MELODY_TARGETS: Record<StyleId, { offbeat: Window; range: Window }> = {
  ukg: { offbeat: [0.55, 0.85], range: [7, 14] },
  house: { offbeat: [0.45, 0.8], range: [7, 15] },
  deepHouse: { offbeat: [0.4, 0.8], range: [6, 14] },
  melodicHouse: { offbeat: [0.35, 0.75], range: [8, 16] },
  rap: { offbeat: [0.5, 0.85], range: [6, 13] },
};

/**
 * How well a melody take holds together, higher being better: an idea that comes back, a line
 * that moves mostly by step and recovers from its leaps, strong beats on the harmony (with
 * resolved tension allowed), an ending that lands, a peak in the third bar, and the style's
 * syncopation and range. Each aim is a window rather than "more is better", so the plainest
 * take doesn't win by default. Density is the producer's setting, so it isn't scored.
 */
export function scoreMelody(notes: readonly NoteEvent[], progression: readonly Chord[], settings: Pick<CompositionSettings, 'style' | 'bars'>): number {
  if (!notes.length) return -Infinity;
  // Judged as heard: a pushed downbeat is still the downbeat.
  const m = melodyMetrics(onTheBeat(notes, settings.bars), progression, settings.bars);
  const t = MELODY_TARGETS[settings.style];
  return -(
    2 * miss(m.rhythmRecurrence, [0.5, 1], 0.25) +
    miss(m.shapeRecurrence, [0.3, 0.9], 0.25) +
    1.5 * miss(m.strongChordTones, [0.75, 1], 0.2) +
    3 * miss(m.unresolved, [0, 0.05], 0.1) +
    1.5 * (1 - m.endResolves) +
    miss(m.leapRecovery, [0.5, 1], 0.25) +
    miss(m.stepRatio, [0.4, 0.85], 0.2) +
    (settings.bars >= 4 ? 0.75 * miss(m.peakInThird, [0.5, 1], 0.5) : 0) +
    miss(m.offbeat, t.offbeat, 0.2) +
    0.5 * miss(m.range, t.range, 4)
  );
}

/**
 * How well a bass take sits in the groove, higher being better: its share of kicks reinforced
 * and answered inside the style's windows, off the clap, a two-bar figure that repeats, and some
 * but not all of its notes with the chord stabs in `chords`.
 */
export function scoreBass(
  notes: readonly NoteEvent[],
  settings: Pick<CompositionSettings, 'style' | 'seed' | 'bars'>,
  chords: readonly NoteEvent[] = [],
): number {
  if (!notes.length) return -Infinity;
  const m = bassMetrics(notes, settings, settings.bars);
  const feel = BASS_FEEL[settings.style];
  const stabs = new Set(chords.map((n) => n.start));
  const together = share(line(notes), (n) => stabs.has(n.start));
  return -(
    2 * miss(m.reinforce, feel.reinforce, 0.15) +
    2 * miss(m.answer, feel.answer, 0.15) +
    1.5 * miss(m.onClap, [0, feel.clap], 0.1) +
    miss(m.period2, [0.6, 1], 0.2) +
    (chords.length ? miss(together, [0.2, 0.75], 0.15) : 0)
  );
}

/**
 * How well a counter-melody take works around `melody`: playing in its gaps, under it where they
 * meet, one figure that comes back, and moving mostly by small steps.
 */
export function scoreCounter(notes: readonly NoteEvent[], melody: readonly NoteEvent[], bars: number): number {
  if (!notes.length) return -Infinity;
  const l = line(notes);
  const moves = l.slice(1).map((n, i) => n.pitch - l[i].pitch);
  const gaps = share(l, (n) => !melody.some((m) => sounds(m, n.start)));
  const under = share(l, (n) => !melody.some((m) => sounds(m, n.start) && m.pitch <= n.pitch));
  return -(
    2 * miss(gaps, [0.6, 1], 0.2) +
    2 * miss(under, [0.95, 1], 0.05) +
    miss(recurrence(barRhythms(l, bars)), [0.5, 1], 0.25) +
    miss(share(moves, (m) => Math.abs(m) <= 4), [0.5, 1], 0.2)
  );
}

/**
 * How well a brass take sits: under the melody, a figure that comes back, and rarely piling in
 * where the melody and the chords both strike.
 */
export function scoreBrass(notes: readonly NoteEvent[], melody: readonly NoteEvent[], chords: readonly NoteEvent[], bars: number): number {
  if (!notes.length) return -Infinity;
  const starts = [...new Set(notes.map((n) => n.start))];
  const melodyStarts = new Set(melody.map((n) => n.start));
  const chordStarts = new Set(chords.map((n) => n.start));
  const under = share(notes, (n) => !melody.some((m) => sounds(m, n.start) && m.pitch < n.pitch));
  return -(
    2 * miss(under, [0.95, 1], 0.05) +
    miss(recurrence(barRhythms(notes, bars)), [0.4, 1], 0.25) +
    miss(share(starts, (s) => melodyStarts.has(s) && chordStarts.has(s)), [0, 0.3], 0.15)
  );
}

/**
 * How well a chord take sits: the style's share of stabs off the beat, smooth voice leading that
 * keeps common tones, and nothing sounding at or above the melody.
 */
export function scoreChords(notes: readonly NoteEvent[], melody: readonly NoteEvent[], settings: Pick<CompositionSettings, 'style' | 'bars'>): number {
  if (!notes.length) return -Infinity;
  const m = chordMetrics(notes, settings.bars);
  const over = share(melody, (mm) => notes.some((c) => sounds(c, mm.start) && c.pitch >= mm.pitch));
  return -(
    2 * miss(m.offbeat, CHORD_FEEL[settings.style].offbeat, 0.15) +
    miss(m.motion, [0, 2], 0.5) +
    miss(m.commonTones, [1, 6], 0.5) +
    2 * miss(over, [0, 0.02], 0.05)
  );
}

export interface ChordMetrics {
  hitsPerBar: number;
  offbeat: number;
  /** Average semitones each voice moves between chord changes. */
  motion: number;
  /** Notes held in common between one chord change and the next. */
  commonTones: number;
}

export function chordMetrics(notes: readonly NoteEvent[], bars: number): ChordMetrics {
  const starts = [...new Set(notes.map((n) => n.start))].sort((a, b) => a - b);
  const voicings = starts.map((s) => notes.filter((n) => n.start === s).map((n) => n.pitch).sort((a, b) => a - b));
  const changes = voicings.filter((v, i) => i === 0 || v.join() !== voicings[i - 1].join());
  const pairs = changes.slice(1).map((v, i) => [changes[i], v] as const);
  return {
    hitsPerBar: starts.length / bars,
    offbeat: share(starts, (s) => inBar(s) % 4 !== 0),
    motion: mean(pairs.map(([a, b]) => mean(b.map((p, i) => Math.abs(p - (a[i] ?? a[a.length - 1])))))),
    commonTones: mean(pairs.map(([a, b]) => b.filter((p) => a.includes(p)).length)),
  };
}

export interface FitMetrics {
  /** Where anything starts, how many parts start there (a chord counts once). */
  attacksPerOnset: number;
  /** Onsets where four or more parts start together. */
  crowded: number;
  /** Melody onsets that land with a bass onset. */
  melodyOnBass: number;
  /** Melody notes with a chord note sounding at or above them. */
  chordsOverMelody: number;
  /** Counter or brass notes sounding above the melody. */
  overMelody: number;
}

const sounds = (n: NoteEvent, tick: number) => n.start <= tick && tick < n.start + n.duration;

export function fitMetrics(notes: readonly NoteEvent[]): FitMetrics {
  const parts = new Map<number, Set<TrackId>>();
  for (const n of notes) {
    const set = parts.get(n.start) ?? new Set<TrackId>();
    set.add(n.track);
    parts.set(n.start, set);
  }
  const counts = [...parts.values()].map((s) => s.size);
  const of = (t: TrackId) => notes.filter((n) => n.track === t);
  const melody = of('melody');
  const bassStarts = new Set(of('bass').map((n) => n.start));
  const chords = of('chords');
  const accompany = [...of('counter'), ...of('brass')];
  return {
    attacksPerOnset: mean(counts),
    crowded: share(counts, (c) => c >= 4),
    melodyOnBass: share(melody, (m) => bassStarts.has(m.start)),
    chordsOverMelody: share(melody, (m) => chords.some((c) => sounds(c, m.start) && c.pitch >= m.pitch)),
    overMelody: share(accompany, (a) => melody.some((m) => sounds(m, a.start) && a.pitch > m.pitch)),
  };
}

export interface LoopMetrics {
  melody: MelodyMetrics;
  bass: BassMetrics;
  chords: ChordMetrics;
  fit: FitMetrics;
}

export function loopMetrics(composition: Composition): LoopMetrics {
  const { notes, progression, settings } = composition;
  const of = (t: TrackId) => notes.filter((n) => n.track === t);
  return {
    melody: melodyMetrics(of('melody'), progression, settings.bars),
    bass: bassMetrics(of('bass'), settings, settings.bars),
    chords: chordMetrics(of('chords'), settings.bars),
    fit: fitMetrics(notes),
  };
}

/** One bar's onsets of a part as a set, for comparing loops with each other. */
export function firstBarOnsets(notes: readonly NoteEvent[], track: TrackId): Set<number> {
  return new Set(notes.filter((n) => n.track === track && n.start < TICKS_PER_BAR).map((n) => inBar(n.start)));
}
