import { fitArrangement, suggestArrangement } from './arrangement';
import { drumPattern } from './beat';
import { generateBrass } from './brass';
import { boldProgressions, colourProgression } from './harmony';
import { suggestAutomation } from './automation';
import { generateMelody, resolveForm, tradeResponses } from './melody';
import { createRng, deriveSeed, type Rng } from './random';
import { resolveTransition, transitionPart } from './transition';
import { contour, type ContourKind } from './motif';
import {
  REGISTERS,
  chordAt,
  clamp,
  fitHits,
  fitToChord,
  hitsAt,
  isTurnaround,
  lerp,
  lockTo,
  nearestIndex,
  nearestWhere,
  noteId,
  onsetProfile,
  pc,
  snapToChordTone,
  sortNotes,
  velocity,
} from './shared';
import { STYLES, densityBand, type BassHit, type CounterStyle, type Hit } from './styles';
import { SCALES, buildChord, harmonyPitchClasses, pitchesInRange, scalePitchClasses } from './theory';
import {
  STEP,
  STEPS_PER_BAR,
  TICKS_PER_BAR,
  totalTicks,
  type Arrangement,
  type AutomationLane,
  type Chord,
  type Composition,
  type CompositionSettings,
  type NoteEvent,
  type Phrasing,
  type StyleId,
  type TrackId,
  type TrackSeeds,
} from './types';

export { REGISTERS, chordAt };

export function trackSeedsFor(seed: number): TrackSeeds {
  return {
    melody: deriveSeed(seed, 'melody'),
    counter: deriveSeed(seed, 'counter'),
    brass: deriveSeed(seed, 'brass'),
    chords: deriveSeed(seed, 'chords'),
    bass: deriveSeed(seed, 'bass'),
  };
}

export function createSettings(overrides: Partial<CompositionSettings> = {}): CompositionSettings {
  const style = STYLES[overrides.style ?? 'ukg'];
  const seed = overrides.seed ?? 1;
  return {
    style: style.id,
    key: 5,
    scale: style.defaultScale,
    bpm: style.bpm,
    swing: style.swing,
    bars: 4,
    density: 0.55,
    variation: 0.35,
    creativity: 0.5,
    phrase: 'auto',
    transition: 'auto',
    ...overrides,
    seed,
    trackSeeds: overrides.trackSeeds ?? trackSeedsFor(seed),
    automationSeed: overrides.automationSeed ?? deriveSeed(seed, 'automation'),
  };
}

// ---------------------------------------------------------------------------
// Harmony

/** Used when none of a style's progressions suit the mode (e.g. lydian's #iv° turns up everywhere). */
const FALLBACK_PROGRESSIONS = {
  major: [
    [0, 1, 0, 1],
    [0, 6, 3, 0],
    [0, 4, 3, 0],
  ],
  minor: [
    [0, 3, 0, 3],
    [0, 6, 5, 6],
    [0, 1, 0, 6],
  ],
};

export function generateProgression(settings: CompositionSettings): Chord[] {
  const rng = createRng(deriveSeed(settings.seed, 'harmony'));
  const style = STYLES[settings.style];
  const family = SCALES[settings.scale].family;
  // Diminished and augmented chords rarely suit these genres; skip progressions that land on them in this mode.
  const stable = (degrees: number[]) =>
    degrees.every((d) => {
      const { quality } = buildChord(settings.key, settings.scale, d, 3);
      return quality === 'maj' || quality === 'min';
    });
  const suitable = style.progressions[family].filter(stable);
  const staples = suitable.length ? suitable : FALLBACK_PROGRESSIONS[family].filter(stable);
  // Bolder progressions join the choice as creativity rises.
  const bold = boldProgressions(settings.style, family).filter(stable);
  const template = rng.weighted([...staples, ...bold], [...staples.map(() => 1), ...bold.map(() => settings.creativity * 1.2)]);
  const chordTicks = settings.bars === 2 ? TICKS_PER_BAR / 2 : TICKS_PER_BAR;
  const count = totalTicks(settings.bars) / chordTicks;
  const chords = Array.from({ length: count }, (_, i) => ({
    ...buildChord(settings.key, settings.scale, template[i % template.length], style.extension),
    start: i * chordTicks,
    duration: chordTicks,
  }));
  return colourProgression(settings, chords, template.length);
}

// ---------------------------------------------------------------------------
// Counter-melody

interface MelodyMap {
  onset: boolean[];
  /** Pitch sounding at each step, or -1 when the melody rests. */
  sounding: number[];
}

function mapMelody(melody: readonly NoteEvent[], steps: number): MelodyMap {
  const onset = new Array<boolean>(steps).fill(false);
  const sounding = new Array<number>(steps).fill(-1);
  for (const n of melody) {
    const s0 = Math.floor(n.start / STEP);
    const s1 = Math.ceil((n.start + n.duration) / STEP);
    if (s0 >= 0 && s0 < steps) onset[s0] = true;
    for (let s = Math.max(0, s0); s < Math.min(steps, s1); s++) sounding[s] = Math.max(sounding[s], n.pitch);
  }
  return { onset, sounding };
}

/** For each sixteenth of the bar, how often the melody is sounding there across the loop (0–1). */
function melodyBusy(mel: MelodyMap, bars: number): number[] {
  const busy = new Array<number>(STEPS_PER_BAR).fill(0);
  mel.sounding.forEach((p, s) => {
    if (p >= 0) busy[s % STEPS_PER_BAR] += 1 / bars;
  });
  return busy;
}

const quiet = (busy: readonly number[], from: number, to: number) => {
  let sum = 0;
  for (let s = from; s < to; s++) sum += 1 - busy[s];
  return sum / Math.max(1, to - from);
};

/** A short figure for the gaps: often evenly spaced, started where the melody tends to rest. */
function answerCell(rng: Rng, density: number, busy: readonly number[]): Hit[] {
  const count = clamp(Math.round(lerp(2, 5, density) + rng.float(-0.6, 0.6)), 2, 6);
  let steps: number[];
  if (rng.chance(0.6)) {
    const space = rng.pick(count > 4 ? [2, 2, 3] : [2, 3, 4]);
    const span = space * (count - 1);
    const starts = Array.from({ length: STEPS_PER_BAR - span }, (_, s) => s);
    const s0 = rng.weighted(starts, starts.map((s) => quiet(busy, s, s + span + 1) ** 3 + 0.01));
    steps = Array.from({ length: count }, (_, i) => s0 + i * space);
  } else {
    const weights = Array.from({ length: STEPS_PER_BAR }, (_, s) => (s % 4 === 0 ? 0.7 : s % 2 === 0 ? 1 : 0.4) * (1.1 - busy[s]) ** 2);
    const chosen = new Set<number>();
    while (chosen.size < count) {
      const free = weights.map((_, s) => s).filter((s) => !chosen.has(s));
      chosen.add(rng.weighted(free, free.map((s) => weights[s])));
    }
    steps = [...chosen].sort((a, b) => a - b);
  }
  // One length for every note, so the figure reads as one gesture.
  const gate = rng.pick([1, 2, 2, 3]);
  return steps.map((step, i) => ({ step, len: Math.max(1, Math.min(gate, (steps[i + 1] ?? STEPS_PER_BAR) - step)) }));
}

const LINE_CELLS = [[0], [0, 8], [0, 6], [0, 10], [4, 12], [0, 6, 12], [0, 8, 12], [0, 4, 10], [2, 8, 12]];

/** One to three long notes a bar, held to the next or released a little early. */
function lineCell(rng: Rng, density: number): Hit[] {
  const count = clamp(Math.round(lerp(1, 3.2, density) + rng.float(-0.5, 0.5)), 1, 3);
  const steps = rng.pick(LINE_CELLS.filter((c) => c.length === count));
  const release = rng.chance(0.3) ? 2 : 0;
  return steps.map((step, i) => {
    const gap = (steps[i + 1] ?? STEPS_PER_BAR) - step;
    return { step, len: gap > release + 1 ? gap - release : gap };
  });
}

/**
 * The counter-melody's rhythm: one bar, played in every bar so the line reads as a part. A few
 * are tried and the one that best fills the melody's gaps wins.
 */
function counterCell(rng: Rng, kind: Exclude<CounterStyle, 'arp'>, density: number, busy: readonly number[]): Hit[] {
  let best: Hit[] = [];
  let bestScore = -Infinity;
  for (let k = 0; k < 6; k++) {
    const cell = kind === 'line' ? lineCell(rng, density) : answerCell(rng, density, busy);
    const covered = cell.reduce((a, h) => a + h.len, 0);
    const clash = cell.reduce((a, h) => a + (1 - quiet(busy, h.step, h.step + h.len)) * h.len, 0) / covered;
    const score = -clash * 4 + rng.float(0, 0.4);
    if (score > bestScore) [best, bestScore] = [cell, score];
  }
  return best;
}

const COUNTER_CONTOURS: Record<Exclude<CounterStyle, 'arp'>, [ContourKind, number][]> = {
  answer: [['stepDown', 2], ['turn', 2], ['arch', 1.5], ['repeat', 1], ['thirds', 1]],
  line: [['stepDown', 2], ['repeat', 1.5], ['turn', 1]],
};

/**
 * Where each bar's figure starts: the chord tone nearest the last one, preferring the third and
 * seventh (the notes that say what the chord is), with a pull back to the middle of the register.
 * Bars over the same chord land in the same place, so the line moves only when the harmony does.
 */
function guideIndex(pool: readonly number[], chord: Chord, near: number, centre: number): number {
  let best = 0;
  let bestScore = Infinity;
  pool.forEach((p, i) => {
    const k = chord.tones.indexOf(pc(p));
    if (k < 0) return;
    const score = Math.abs(p - near) + (k === 0 ? 2 : k === 2 ? 1 : 0) + Math.abs(p - centre) * 0.2;
    if (score < bestScore) [best, bestScore] = [i, score];
  });
  return best;
}

/** The kinds of counter-melody each style plays, weighted; its own kind leads. */
const COUNTER_KINDS: Record<StyleId, [CounterStyle, number][]> = {
  ukg: [['answer', 3], ['line', 1], ['arp', 0.8]],
  house: [['answer', 3], ['arp', 1.2], ['line', 0.8]],
  deepHouse: [['line', 3], ['answer', 1.5], ['arp', 0.6]],
  melodicHouse: [['arp', 3], ['line', 1.5], ['answer', 1]],
  rap: [['arp', 3], ['answer', 1.5], ['line', 0.6]],
};

/** The kind of counter-melody this loop plays: an answering figure, a slow line or an arp. It comes with the part's seed. */
export function counterStyle(settings: Pick<CompositionSettings, 'style' | 'trackSeeds'>): CounterStyle {
  const table = COUNTER_KINDS[settings.style];
  const rng = createRng(deriveSeed(settings.trackSeeds.counter, 'kind'));
  return rng.weighted(table.map(([k]) => k), table.map(([, w]) => w));
}

/** Arp rhythms by density band, as the sixteenths of the bar they play on: eighths, a 3-3-2 push, dotted eighths, a gallop. */
const ARP_RHYTHMS: [number[], number][][] = [
  [
    [[0, 2, 4, 6, 8, 10, 12, 14], 1.5],
    [[0, 3, 6, 8, 11, 14], 2],
    [[0, 3, 6, 9, 12], 1],
    [[0, 4, 6, 8, 12, 14], 1],
  ],
  [
    [[0, 2, 4, 6, 8, 10, 12, 14], 2],
    [[0, 3, 6, 8, 11, 14], 1.5],
    [[0, 2, 3, 6, 8, 10, 11, 14], 1],
    [[0, 2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15], 1],
  ],
  [
    [Array.from({ length: STEPS_PER_BAR }, (_, s) => s), 2],
    [[0, 2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15], 1.5],
    [[0, 2, 4, 6, 8, 10, 12, 14], 1],
  ],
];

const ARP_SHAPES = [
  [0, 1, 2],
  [0, 2, 1, 2],
  [0, 1, 2, 3],
  [2, 1, 0, 1],
  [0, 2, 3, 1],
];

/** Less obvious arp orders, offered as creativity rises: up-and-back, skips, a gallop on the root. */
const BOLD_ARP_SHAPES = [
  [0, 1, 2, 3, 2, 1],
  [0, 3, 1, 2],
  [0, 0, 2, 1, 3, 1],
  [3, 2, 1, 0],
  [0, 2, 1, 3, 2, 0, 1],
];

function arpVoicing(chord: Chord, scale: ReadonlySet<number>, low: number): number[] {
  const inScale = chord.tones.filter((t) => scale.has(t));
  const tones = (inScale.length ? inScale : chord.tones).slice(0, 4);
  let base = low;
  while (pc(base) !== tones[0]) base++;
  const voiced = tones.map((t) => {
    let p = base;
    while (pc(p) !== t) p++;
    return p;
  });
  voiced.sort((a, b) => a - b);
  if (voiced.length < 4) voiced.push(voiced[0] + 12);
  return voiced;
}

export function generateCounter(
  settings: CompositionSettings,
  progression: readonly Chord[],
  melody: readonly NoteEvent[],
  phrasing: Phrasing,
): NoteEvent[] {
  const seed = settings.trackSeeds.counter;
  const rng = createRng(seed);

  // In a trade the counter-melody stops accompanying and answers the melody instead.
  if (phrasing.form === 'trade') {
    return tradeResponses(settings, progression, melody, phrasing, rng).map((n, i) => ({
      id: noteId('counter', seed, i),
      track: 'counter',
      pitch: fitToChord(n.pitch, chordAt(progression, n.start)),
      start: n.start,
      duration: n.duration,
      velocity: velocity(n.accent + rng.float(-5, 5)),
    }));
  }

  const { low, high } = REGISTERS.counter;
  const pool = pitchesInRange(scalePitchClasses(settings.key, settings.scale), low, high);
  const steps = settings.bars * STEPS_PER_BAR;
  const mel = mapMelody(melody, steps);
  const notes: NoteEvent[] = [];
  const push = (pitch: number, step: number, len: number, vel: number) =>
    notes.push({
      id: noteId('counter', seed, notes.length),
      track: 'counter',
      pitch,
      start: step * STEP,
      duration: len * STEP,
      velocity: velocity(vel + rng.float(-5, 5)),
    });

  const kind = counterStyle(settings);
  if (kind === 'arp') {
    const shapes = [...ARP_SHAPES, ...BOLD_ARP_SHAPES];
    const shape = rng.weighted(shapes, shapes.map((_, i) => (i < ARP_SHAPES.length ? 1 : settings.creativity)));
    const table = ARP_RHYTHMS[densityBand(settings.density)];
    const rhythm = rng.weighted(table.map(([r]) => r), table.map(([, w]) => w));
    const gate = lerp(0.35, 0.05, settings.density);
    const scale = new Set(scalePitchClasses(settings.key, settings.scale));
    // How high in the register the arp sits, chosen once.
    const floor = low + rng.pick([0, 2, 4]);
    // The gaps are chosen once, so every bar breathes in the same places.
    const rests = new Set(rhythm.filter((s) => s % 4 !== 0 && rng.chance(gate)));
    let n = 0;
    for (let bar = 0; bar < settings.bars; bar++) {
      rhythm.forEach((at, i) => {
        const s = bar * STEPS_PER_BAR + at;
        const len = Math.min(3, (rhythm[i + 1] ?? STEPS_PER_BAR) - at);
        if (rests.has(at)) {
          n++;
          return;
        }
        const chord = chordAt(progression, s * STEP);
        const voicing = arpVoicing(chord, chord.scale ? new Set(chord.scale) : scale, floor);
        let pitch = voicing[shape[n % shape.length] % voicing.length];
        n++;
        const mp = mel.sounding[s];
        if (mp >= 0 && pitch > mp - 2 && pitch - 12 >= low) pitch -= 12;
        if (pitch > high || (mp >= 0 && pitch > mp - 2)) return;
        push(pitch, s, len, at % 4 === 0 ? 86 : 74);
      });
    }
    return notes;
  }

  // One figure, decided once: the same rhythm and shape every bar, started on each chord's guide
  // tone, so it moves with the harmony and repeats where the harmony repeats.
  const octave = SCALES[settings.scale].intervals.length;
  const cell = counterCell(rng, kind, settings.density, melodyBusy(mel, settings.bars));
  const table = COUNTER_CONTOURS[kind];
  const shape = contour(rng.weighted(table.map(([k]) => k), table.map(([, w]) => w)), cell.length, rng, octave);
  const centre = (low + high) / 2 - 2;
  let near = centre;
  for (let bar = 0; bar < settings.bars; bar++) {
    const lastBar = bar === settings.bars - 1;
    // At the end of a phrase the figure can leave its last note out, making room for what comes next.
    const hits = isTurnaround(bar, settings.bars) && !lastBar && cell.length > 1 && rng.chance(settings.variation * 0.6) ? cell.slice(0, -1) : cell;
    const anchor = guideIndex(pool, chordAt(progression, (bar * STEPS_PER_BAR + hits[0].step) * STEP), near, centre);
    near = pool[anchor];
    hits.forEach((hit, i) => {
      const step = bar * STEPS_PER_BAR + hit.step;
      const chord = chordAt(progression, step * STEP);
      let index = clamp(anchor + shape[i], 0, pool.length - 1);
      const dir = Math.sign(shape[i] - (shape[i - 1] ?? shape[i]));
      // Beats land on chord tones; the loop's last note settles on the chord's triad.
      if (lastBar && i === hits.length - 1) index = nearestWhere(pool, index, dir, (p) => chord.tones.slice(0, 3).includes(pc(p)));
      else if (hit.step % 4 === 0) index = snapToChordTone(pool, chord.tones, index, dir);
      let pitch = fitToChord(pool[index], chord);
      const mp = mel.sounding[step];
      if (mp >= 0 && pitch > mp - 2) pitch -= 12;
      if (pitch < low || (mp >= 0 && pitch > mp - 2)) return;
      // Shorten if the melody dips into this note's space before it ends.
      let len = hit.len;
      for (let k = 1; k < len; k++) {
        const later = mel.sounding[step + k];
        if (later >= 0 && later - 3 < pitch) {
          len = k;
          break;
        }
      }
      push(pitch, step, len, (hit.step % 4 === 0 ? 86 : 78) - (kind === 'line' ? 4 : 0));
    });
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Chords

type VoicingShape = 'close' | 'spread' | 'stab';

/** How each style spreads its chords once creativity lets them leave close position. */
const VOICINGS: Record<StyleId, [VoicingShape, number][]> = {
  ukg: [['stab', 2], ['close', 1], ['spread', 0.6]],
  house: [['stab', 1.5], ['spread', 1], ['close', 1]],
  deepHouse: [['spread', 2], ['close', 1]],
  melodicHouse: [['spread', 2], ['close', 1]],
  rap: [['spread', 1.5], ['close', 1]],
};

/**
 * Close-position voicing with the smoothest move from the last chord. `lead` (0–1) favours
 * voicings whose top note moves by a step, so the chords carry a little line of their own.
 */
function voiceChord(chord: Chord, previous: number[] | null, lead = 0): number[] {
  const { low, high } = REGISTERS.chords;
  // Extended chords drop the root: the bass already has it, and the shell sounds cleaner.
  const tones = chord.tones.length >= 4 ? chord.tones.slice(1) : chord.tones;
  let best: number[] = [];
  let bestScore = Infinity;
  for (let rot = 0; rot < tones.length; rot++) {
    const order = [...tones.slice(rot), ...tones.slice(0, rot)];
    for (let start = low; start < low + 12; start++) {
      if (pc(start) !== order[0]) continue;
      const voicing = [start];
      for (const t of order.slice(1)) {
        let p = voicing[voicing.length - 1] + 1;
        while (pc(p) !== t) p++;
        voicing.push(p);
      }
      for (const shift of [0, 12]) {
        const v = voicing.map((p) => p + shift);
        if (v[0] < low || v[v.length - 1] > high) continue;
        const muddy = Math.max(0, 55 - v[0]) * 1.5;
        const centre = Math.abs(v.reduce((a, p) => a + p, 0) / v.length - 61) * 0.4;
        const motion = previous
          ? v.reduce((a, p, i) => a + Math.abs(p - (previous[i] ?? previous[previous.length - 1])), 0)
          : 0;
        const topMove = previous ? Math.abs(v[v.length - 1] - previous[previous.length - 1]) : 1;
        const line = lead * (topMove === 0 ? 2 : topMove <= 2 ? 0 : topMove * 0.5);
        const score = muddy + centre + motion + line;
        if (score < bestScore) [best, bestScore] = [v, score];
      }
    }
  }
  return best;
}

/** Opens a close voicing out: `spread` drops the second voice from the top an octave, `stab` doubles the top an octave down. */
function shapeVoicing(voicing: number[], shape: VoicingShape): number[] {
  const { low } = REGISTERS.chords;
  if (shape === 'close' || voicing.length < 3) return voicing;
  if (shape === 'spread') {
    const i = voicing.length - 2;
    if (voicing[i] - 12 < low) return voicing;
    return [...voicing.slice(0, i), ...voicing.slice(i + 1), voicing[i] - 12].sort((a, b) => a - b);
  }
  const top = voicing[voicing.length - 1];
  return top - 12 >= low && !voicing.includes(top - 12) ? [top - 12, ...voicing].sort((a, b) => a - b) : voicing;
}

/** How strongly a new part is drawn to land with the parts already written. */
const LOCK = 2.5;

/** The loop's kick, and the notes already written, as one groove for a new part to lock to. */
function grooveOf(settings: CompositionSettings, around: readonly NoteEvent[]): number[] {
  const kick = new Set(drumPattern(settings).kick);
  return onsetProfile(around, settings.bars).map((v, s) => Math.max(v, kick.has(s) ? 0.5 : 0));
}

/** A one-bar rhythm, and the style pattern it was made from. */
interface Rhythm<T extends Hit> {
  hits: T[];
  base: T[];
}

/** How often each way of reworking a bar of hits is tried. */
interface Moves {
  nudge: number;
  drop: number;
  add: number;
  clip: number;
  hold: number;
  split: number;
}

const MOVES: Moves = { nudge: 2, drop: 1, add: 1.5, clip: 1, hold: 1, split: 1 };

/**
 * One change to a bar of hits, or null if it has nothing to change. The downbeat hit is never moved
 * or dropped, nor is one on beat three, where a 2-bar loop's second chord comes in.
 */
function rework<T extends Hit>(rng: Rng, hits: readonly T[], move: keyof Moves, added: (rng: Rng) => Omit<T, keyof Hit>): T[] | null {
  const movable = hits.map((_, i) => i).filter((i) => hits[i].step > 0);
  const covered = (s: number) => hits.some((h) => h.step <= s && s < h.step + h.len);
  // A moved or added hit keeps an eighth clear of the others, so the bar never stutters.
  const crowded = (s: number, skip = -1) => hits.some((h, k) => k !== skip && Math.abs(h.step - s) < 2);
  switch (move) {
    case 'nudge': {
      // A hit pushed a sixteenth ahead of where it was, or dragged a sixteenth behind.
      if (!movable.length) return null;
      const i = rng.pick(movable);
      const by = rng.pick([-1, 1]);
      const step = hits[i].step + by;
      if (step >= STEPS_PER_BAR || crowded(step, i)) return null;
      return hits.map((h, k) => (k === i ? { ...h, step, len: Math.max(1, h.len - by) } : h));
    }
    case 'drop': {
      const droppable = movable.filter((i) => hits[i].step !== STEPS_PER_BAR / 2);
      if (!droppable.length || hits.length <= 2) return null;
      const i = rng.pick(droppable);
      return hits.filter((_, k) => k !== i);
    }
    case 'add': {
      // A short hit in a gap, most often on an off-beat eighth.
      const free = Array.from({ length: STEPS_PER_BAR }, (_, s) => s).filter((s) => s > 0 && !covered(s) && !crowded(s));
      if (!free.length) return null;
      const step = rng.weighted(free, free.map((s) => (s % 4 === 2 ? 3 : s % 2 === 1 ? 1.5 : 1)));
      return [...hits, { ...added(rng), step, len: rng.pick([1, 2]) } as T];
    }
    case 'clip': {
      const to = rng.pick([1, 2, 2, 3]);
      return hits.some((h) => h.len > to) ? hits.map((h) => ({ ...h, len: Math.min(h.len, to) })) : null;
    }
    case 'hold': {
      const held = hits.map((h, k) => ({ ...h, len: (hits[k + 1]?.step ?? STEPS_PER_BAR) - h.step }));
      return held.some((h, k) => h.len !== hits[k].len) ? held : null;
    }
    case 'split': {
      const long = hits.map((_, i) => i).filter((i) => hits[i].len >= 4);
      if (!long.length) return null;
      const i = rng.pick(long);
      const half = Math.floor(hits[i].len / 2);
      return [...hits.slice(0, i), { ...hits[i], len: half }, { ...hits[i], step: hits[i].step + half, len: hits[i].len - half }, ...hits.slice(i + 1)];
    }
  }
}

/**
 * A style's patterns for a density, and seeded takes on them: a hit nudged off the beat, one left
 * out or added in a gap, the notes clipped short, held on or split. Every take starts from one of
 * the style's own patterns, so it stays in the style, and there are enough of them that two loops
 * rarely share a rhythm.
 */
function rhythms<T extends Hit>(rng: Rng, patterns: readonly T[][], added: (rng: Rng) => Omit<T, keyof Hit>, moves: Moves = MOVES): Rhythm<T>[] {
  const out: Rhythm<T>[] = patterns.map((p) => ({ hits: p, base: p }));
  const seen = new Set(patterns.map((p) => JSON.stringify(p)));
  const kinds = Object.keys(moves) as (keyof Moves)[];
  for (let tries = 0; tries < 24 && out.length < patterns.length + 8; tries++) {
    const base = rng.pick(patterns);
    let hits: T[] | null = base;
    for (let k = rng.chance(0.4) ? 2 : 1; k > 0 && hits; k--) {
      hits = rework(rng, hits, rng.weighted(kinds, kinds.map((m) => moves[m])), added);
      if (hits) hits = fitHits(hits, STEPS_PER_BAR);
    }
    const key = JSON.stringify(hits);
    if (!hits || hits.length < 1 || seen.has(key)) continue;
    seen.add(key);
    out.push({ hits, base });
  }
  return out;
}

/** One rhythm, favouring those that hit where the groove already does. */
function pickLocked<T extends Hit>(rng: Rng, choices: readonly Rhythm<T>[], groove: readonly number[]): Rhythm<T> {
  return rng.weighted(choices, choices.map((r) => Math.exp(LOCK * lockTo(r.hits, groove))));
}

/** A different pattern from the same density band, for a fill. */
function otherPattern<T extends Hit>(rng: Rng, patterns: readonly T[][], pattern: readonly T[]): T[] | null {
  const others = patterns.filter((p) => p !== pattern);
  return others.length ? rng.pick(others) : null;
}

/** A free sixteenth in a bar's hits, for a ghost stab. */
function freeStep(rng: Rng, hits: readonly Hit[], span: number): number | null {
  const covered = (s: number) => hits.some((h) => h.step <= s && s < h.step + h.len);
  const free = Array.from({ length: span }, (_, s) => s).filter((s) => s > 0 && !covered(s));
  return free.length ? rng.weighted(free, free.map((s) => (s % 2 === 1 ? 2 : 1))) : null;
}

export function generateChords(settings: CompositionSettings, progression: readonly Chord[], around: readonly NoteEvent[] = []): NoteEvent[] {
  const seed = settings.trackSeeds.chords;
  const rng = createRng(seed);
  // Creative choices draw from their own stream, so at creativity 0 the part is as it always was.
  const flair = createRng(deriveSeed(seed, 'flair'));
  const c = settings.creativity;
  const style = STYLES[settings.style];
  const patterns = style.chords[densityBand(settings.density)];
  const choices = rhythms(createRng(deriveSeed(seed, 'rhythm')), patterns, () => ({}));
  const { hits: pattern, base } = pickLocked(rng, choices, grooveOf(settings, around));
  const shapes = VOICINGS[settings.style];
  const shape = flair.chance(c) ? flair.weighted(shapes.map(([s]) => s), shapes.map(([, w]) => w)) : 'close';
  // Decided once for the whole loop, so every bar is played the same way: the style's other
  // pattern as a fill at the end of each phrase, a ghost stab, and how early the changes come.
  const fill = flair.chance(c * 0.6) ? otherPattern(flair, patterns, base) : null;
  const ghost = flair.chance(c * 0.25) ? freeStep(flair, pattern, STEPS_PER_BAR) : null;
  const early = flair.chance(c * 0.3) ? flair.pick([1, 2]) : 0;
  const notes: NoteEvent[] = [];
  let previous: number[] | null = null;
  let lastEnd = 0;

  progression.forEach((chord, ci) => {
    const voicing = voiceChord(chord, previous, c);
    previous = voicing;
    const voiced = shapeVoicing(voicing, shape);
    const span = chord.duration / STEP;
    const offset = (chord.start % TICKS_PER_BAR) / STEP;
    const bar = fill && isTurnaround(Math.floor(chord.start / TICKS_PER_BAR), settings.bars) ? fill : pattern;
    let hits: (Hit & { ghost?: boolean })[] = hitsAt(bar, offset, span);
    if (!hits.length) hits = [{ step: 0, len: span }];
    const last = ci === progression.length - 1 && bar === pattern;
    if (last && hits.length > 1 && rng.chance(settings.variation * 0.5)) hits = hits.slice(0, -1);
    const covered = (s: number) => hits.some((h) => h.step <= s && s < h.step + h.len);
    if (ghost !== null && ghost >= offset && ghost < offset + span && !covered(ghost - offset)) {
      hits = fitHits([...hits, { step: ghost - offset, len: 1, ghost: true }], span);
    }
    // Push the change a sixteenth or an eighth early, ahead of the bar.
    const push = ci > 0 && hits[0].step === 0 ? Math.min(early, Math.floor((chord.start - lastEnd) / STEP)) : 0;
    for (const [hi, hit] of hits.entries()) {
      const ahead = hi === 0 ? push : 0;
      const accent = (hit.ghost ? 62 : hit.step % 4 === 0 ? 84 : 76) + rng.float(-4, 4);
      const start = chord.start + (hit.step - ahead) * STEP;
      lastEnd = Math.max(lastEnd, start + (hit.len + ahead) * STEP);
      for (const pitch of voiced) {
        notes.push({
          id: noteId('chords', seed, notes.length),
          track: 'chords',
          pitch,
          start,
          duration: (hit.len + ahead) * STEP,
          velocity: velocity(accent),
        });
      }
    }
  });
  return notes;
}

// ---------------------------------------------------------------------------
// Bass

/** Small changes to a bar of bass hits, scaled by creativity: octave pops, a pushed note, an approach into the next chord. */
function mutateBass(rng: Rng, c: number, hits: BassHit[], span: number): BassHit[] {
  let out = hits.map((h, i): BassHit => (i > 0 && h.tone === 'root' && rng.chance(c * 0.25) ? { ...h, tone: 'octave' } : h));
  if (out.length > 1 && rng.chance(c * 0.2)) {
    const i = rng.int(1, out.length - 1);
    const moved = out[i].step + 1;
    const nextStep = out[i + 1]?.step ?? span;
    if (moved < nextStep) out[i] = { ...out[i], step: moved, len: Math.max(1, out[i].len - 1) };
  }
  const tail = out[out.length - 1];
  if (out.length > 1 && tail.step >= 2 && tail.tone !== 'approach' && rng.chance(c * 0.35)) {
    out = [...out.slice(0, -1), { ...tail, tone: rng.chance(0.6) ? 'chromatic' : 'approach' }];
  }
  return fitHits(out, span);
}

export function generateBass(settings: CompositionSettings, progression: readonly Chord[], around: readonly NoteEvent[] = []): NoteEvent[] {
  const seed = settings.trackSeeds.bass;
  const rng = createRng(seed);
  const flair = createRng(deriveSeed(seed, 'flair'));
  const c = settings.creativity;
  const style = STYLES[settings.style];
  const { low, high } = REGISTERS.bass;
  const patterns = style.bass[densityBand(settings.density)];
  // Added hits are mostly roots, sometimes an octave pop. 808 lines run on rather than clip short.
  const added = (r: Rng): Omit<BassHit, keyof Hit> => ({ tone: r.chance(0.3) ? 'octave' : 'root' });
  const moves = settings.style === 'rap' ? { ...MOVES, clip: 0, hold: 2 } : MOVES;
  const choices = rhythms(createRng(deriveSeed(seed, 'rhythm')), patterns, added, moves);
  const { hits: pattern, base } = pickLocked(rng, choices, grooveOf(settings, around));
  // Decided once for the whole loop: a fill pattern for the end of each phrase, and whether the 808 slides.
  const fill = flair.chance(c * 0.6) ? otherPattern(flair, patterns, base) : null;
  const slide = settings.style === 'rap' && flair.chance(c * 0.5);
  // A chord in the same place in the bar gets the same changes, so repeated bars stay repeats.
  const mutated = new Map<string, BassHit[]>();
  const scale = pitchesInRange(harmonyPitchClasses(settings.key, settings.scale), low, high);
  const notes: NoteEvent[] = [];
  const push = (pitch: number, start: number, duration: number, accent: number) =>
    notes.push({
      id: noteId('bass', seed, notes.length),
      track: 'bass',
      pitch: clamp(pitch, low, high),
      start,
      duration,
      velocity: velocity(accent + rng.float(-5, 5)),
    });

  const rootNear = (rootPc: number, near: number | null) => {
    const options = [36 + rootPc, 48 + rootPc].filter((p) => p <= 49);
    return near === null ? options[0] : options.reduce((a, p) => (Math.abs(p - near) < Math.abs(a - near) ? p : a));
  };

  let prevRoot: number | null = null;
  const roots = progression.map((c) => (prevRoot = rootNear(c.root, prevRoot)));

  progression.forEach((chord, ci) => {
    const root = roots[ci];
    const nextRoot = roots[(ci + 1) % roots.length];
    const span = chord.duration / STEP;
    const offset = (chord.start % TICKS_PER_BAR) / STEP;
    const bar = fill && isTurnaround(Math.floor(chord.start / TICKS_PER_BAR), settings.bars) ? fill : pattern;
    let hits: BassHit[] = hitsAt(bar, offset, span);
    if (!hits.length) hits = [{ step: 0, len: span, tone: 'root' }];
    // A chord that starts mid-bar still opens on its root.
    if (hits[0].tone === 'fifth' || hits[0].tone === 'approach') hits = [{ ...hits[0], tone: 'root' }, ...hits.slice(1)];
    const filled = bar !== pattern;
    if (c > 0 && !filled) {
      const key = `${offset}:${span}`;
      if (!mutated.has(key)) mutated.set(key, mutateBass(flair, c, hits, span));
      hits = mutated.get(key)!;
    }

    // The end of the loop gets one move, not a pile of them: the fill, a walk, or a pop into an approach note.
    const last = ci === progression.length - 1 && !filled;
    const walk = last && span >= 8 && hits[0].step < span - 4 && flair.chance(c * 0.35);
    if (last && !walk && rng.chance(settings.variation * 0.6)) {
      const tail = hits[hits.length - 1];
      if (tail.step > 0 && tail.len >= 2) {
        hits = [...hits.slice(0, -1), { ...tail, len: 1, tone: 'octave' }, { step: tail.step + 1, len: tail.len - 1, tone: 'approach' }];
      } else if (tail.step > 0) {
        hits = [...hits.slice(0, -1), { ...tail, tone: 'approach' }];
      }
    }
    // The loop's last bar can walk into the top of the loop.
    if (walk) hits = hits.filter((h, i) => i === 0 || h.step < span - 4);
    // 808s run their notes together so they slide.
    if (slide) hits = hits.map((h, i) => ({ ...h, len: (hits[i + 1]?.step ?? h.step + h.len) - h.step }));

    const fifthPc = chord.tones[2];
    hits.forEach((hit) => {
      let pitch = root;
      const { tone } = hit;
      if (tone === 'octave' && root + 12 <= high) pitch = root + 12;
      if (tone === 'fifth') {
        let p = root;
        while (pc(p) !== fifthPc) p++;
        pitch = p <= high ? p : p - 12 >= low ? p - 12 : root;
      }
      if (tone === 'approach') {
        const below = scale.filter((p) => p < nextRoot).pop();
        const above = scale.find((p) => p > nextRoot);
        pitch = below !== undefined && below >= low ? below : (above ?? root);
      }
      // A semitone into the next chord's root, from below unless that would leave the register.
      if (tone === 'chromatic') pitch = nextRoot - 1 >= low ? nextRoot - 1 : nextRoot + 1;
      const accent = hit.step % 4 === 0 ? 104 : hit.step % 2 === 0 ? 98 : 88;
      push(pitch, chord.start + hit.step * STEP, hit.len * STEP, accent);
    });

    if (walk) {
      // Three scale steps into the next root, from whichever side the line is already on.
      const held = notes[notes.length - 1];
      const dir = nextRoot >= held.pitch ? 1 : -1;
      const at = nearestIndex(scale, nextRoot);
      held.duration = Math.min(held.duration, chord.start + (span - 3) * STEP - held.start);
      [3, 2, 1].forEach((k, i) => push(scale[clamp(at - dir * k, 0, scale.length - 1)], chord.start + (span - 3 + i) * STEP, STEP, i === 0 ? 96 : 86));
    }
  });
  return notes;
}

// ---------------------------------------------------------------------------
// Whole compositions

/**
 * Pure and deterministic: the same settings always yield the same composition.
 * `previous` lanes only carry over their on/off state. A previous arrangement
 * is kept while the style stays the same; a new style gets its own structure.
 */
export function generateComposition(
  settings: CompositionSettings,
  previous: readonly AutomationLane[] = [],
  previousArrangement?: Arrangement,
): Composition {
  const progression = generateProgression(settings);
  // Each part is written around the ones before it: the bass locks to the chords, the melody
  // leans on their rhythm, the counter-melody fills the melody's gaps, and the brass finds room
  // around all of them.
  const chords = generateChords(settings, progression);
  const bass = generateBass(settings, progression, chords);
  const { notes: melody, phrasing } = generateMelody(settings, progression, [...chords, ...bass]);
  const counter = generateCounter(settings, progression, melody, phrasing);
  const brass = generateBrass(settings, progression, melody, counter, [...chords, ...bass]);
  const ending = (track: TrackId, part: NoteEvent[]) => withTransition(settings, progression, phrasing, track, part, melody);
  const notes = sortNotes([
    ...ending('melody', melody),
    ...ending('counter', counter),
    ...ending('brass', brass),
    ...ending('chords', chords),
    ...ending('bass', bass),
  ]);
  const automation = suggestAutomation({ settings, progression, phrasing, notes }, previous);
  const arrangement =
    previousArrangement?.style === settings.style
      ? fitArrangement(previousArrangement, settings.bars)
      : suggestArrangement(settings.style, settings.bars);
  return { settings, progression, phrasing, notes, automation, arrangement };
}

/** A generated part with its share of the transition at the end of an 8-bar loop. `melody` is what the brass's hit stays under. */
export function withTransition(
  settings: CompositionSettings,
  progression: readonly Chord[],
  phrasing: Phrasing,
  track: TrackId,
  notes: NoteEvent[],
  melody: readonly NoteEvent[] = [],
): NoteEvent[] {
  const transition = resolveTransition(settings);
  if (!transition) return notes;
  const lead = phrasing.sections[phrasing.sections.length - 1].voice;
  return transitionPart(track, notes, transition, { settings, progression, lead, under: melody });
}

/** With an uploaded counter-melody held, a trade would leave the melody waiting for answers that never come. */
export function melodySettings(settings: CompositionSettings, held: ReadonlySet<TrackId>): CompositionSettings {
  return held.has('counter') && resolveForm(settings) === 'trade' ? { ...settings, phrase: 'callResponse' } : settings;
}

/** Rebuilds the automation suggestions for the current notes, keeping on/off choices. */
export function refreshAutomation(composition: Composition): Composition {
  return { ...composition, automation: suggestAutomation(composition, composition.automation) };
}

/**
 * Replaces one part using a new seed. Other parts, including edits, are kept,
 * except that a traded counter-melody and the brass follow a new melody (they
 * answer it, double it or leave it room). Uploaded parts are never replaced.
 */
export function regenerateTrack(composition: Composition, track: TrackId, seed: number): Composition {
  const held = new Set(composition.source?.parts.map((p) => p.track));
  if (held.has(track)) return composition;
  const settings = { ...composition.settings, trackSeeds: { ...composition.settings.trackSeeds, [track]: seed } };
  const { progression } = composition;
  let { phrasing } = composition;
  let melody = composition.notes.filter((n) => n.track === 'melody');
  const replaced = new Set<TrackId>([track]);
  const fresh: NoteEvent[] = [];

  const part = (t: TrackId) => composition.notes.filter((n) => n.track === t);

  const ending = (t: TrackId, notes: NoteEvent[]) => withTransition(settings, progression, phrasing, t, notes, melody);
  if (track === 'melody') {
    const wasTrade = phrasing.form === 'trade';
    ({ notes: melody, phrasing } = generateMelody(melodySettings(settings, held), progression, [...part('chords'), ...part('bass')]));
    fresh.push(...ending('melody', melody));
    if ((wasTrade || phrasing.form === 'trade') && !held.has('counter')) replaced.add('counter');
    if (!held.has('brass')) replaced.add('brass');
  }
  let counter = part('counter');
  if (replaced.has('counter')) {
    counter = generateCounter(settings, progression, melody, phrasing);
    fresh.push(...ending('counter', counter));
  }
  if (replaced.has('brass')) fresh.push(...ending('brass', generateBrass(settings, progression, melody, counter, [...part('chords'), ...part('bass')])));
  if (track === 'chords') fresh.push(...ending('chords', generateChords(settings, progression, part('bass'))));
  if (track === 'bass') fresh.push(...ending('bass', generateBass(settings, progression, part('chords'))));

  const kept = composition.notes.filter((n) => !replaced.has(n.track));
  return refreshAutomation({ ...composition, settings, phrasing, notes: sortNotes([...kept, ...fresh]) });
}

/** New automation ideas for the same music. */
export function rerollAutomation(composition: Composition, seed: number): Composition {
  const settings = { ...composition.settings, automationSeed: seed };
  return { ...composition, settings, automation: suggestAutomation({ ...composition, settings }) };
}

export function setLaneEnabled(composition: Composition, id: string, enabled: boolean): Composition {
  const lane = composition.automation.find((l) => l.id === id);
  if (!lane || lane.enabled === enabled) return composition;
  return { ...composition, automation: composition.automation.map((l) => (l.id === id ? { ...l, enabled } : l)) };
}
