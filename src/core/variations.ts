import { CELLS, parseCell } from './motif';
import { createRng, deriveSeed, type Rng } from './random';
import { chordAt, clamp, fitToChord, hitsAt, nearestIndex, noteId, pc, snapToChordTone, velocity } from './shared';
import { STYLES, type StyleDef } from './styles';
import { harmonyPitchClasses, pitchesInRange, scalePitchClasses } from './theory';
import {
  STEP,
  TICKS_PER_BAR,
  VARIATION_COUNT,
  totalTicks,
  type Chord,
  type ImportSource,
  type NoteEvent,
  type StyleId,
  type TrackId,
} from './types';

/** One variation card: what changed, and the notes. */
export interface Variation {
  label: string;
  notes: NoteEvent[];
}

interface Tone {
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
}

interface Ctx {
  rng: Rng;
  amount: number;
  style: StyleDef;
  track: TrackId;
  bars: number;
  end: number;
  progression: readonly Chord[];
  /** Scale pitches across the keyboard; moves step through these. */
  pool: number[];
  /** Pool entries per octave. */
  octave: number;
  low: number;
  high: number;
  /** The key's seven-note scale, for colour tones. */
  keyScale: number[];
}

type Result = { notes: Tone[]; label: string } | null;

/** What a move changes. A card combines moves from different groups only. */
type Group = 'pitch' | 'rhythm' | 'time' | 'shape' | 'register' | 'voicing' | 'ending';

interface Move {
  id: string;
  group: Group;
  weight: number;
  run(line: Tone[], ctx: Ctx): Result;
}

const BEAT = STEP * 4;
const onBeat = (t: number) => t % BEAT === 0;
/** Beats one and three. */
const strong = (t: number) => t % (BEAT * 2) === 0;
const chance = (ctx: Ctx, base: number, span: number) => ctx.rng.chance(clamp(base + span * ctx.amount, 0, 1));
const at = (ctx: Ctx, pitch: number) => nearestIndex(ctx.pool, pitch);
const chordOf = (ctx: Ctx, tick: number) => chordAt(ctx.progression, tick);
const done = (notes: Tone[], label: string): Result => ({ notes, label });
const same = (a: readonly Tone[], b: readonly Tone[]) => signature(a) === signature(b);

function signature(notes: readonly Tone[]): string {
  return [...notes]
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch)
    .map((n) => `${n.start}:${n.pitch}:${n.duration}`)
    .join(',');
}

/** A pool index moved back toward `near` by whole octaves, so a line can't wander off. */
function keepNear(ctx: Ctx, index: number, near: number): number {
  let i = clamp(index, 0, ctx.pool.length - 1);
  while (ctx.pool[i] - near > 9 && i - ctx.octave >= 0) i -= ctx.octave;
  while (near - ctx.pool[i] > 9 && i + ctx.octave < ctx.pool.length) i += ctx.octave;
  return i;
}

function inBar(line: readonly Tone[], bar: number): Tone[] {
  const s = bar * TICKS_PER_BAR;
  return line.filter((n) => n.start >= s && n.start < s + TICKS_PER_BAR);
}

// ---------------------------------------------------------------------------
// Moves for single lines: melody, counter-melody and bass

/** Each note keeps its rhythm and direction but moves by a new interval; strong beats land on chord tones. */
const newNotes: Move = {
  id: 'newNotes',
  group: 'pitch',
  weight: 1.3,
  run(line, ctx) {
    if (line.length < 3) return null;
    let index = at(ctx, line[0].pitch);
    const notes = line.map((n, i) => {
      if (i > 0) {
        const was = at(ctx, n.pitch) - at(ctx, line[i - 1].pitch);
        const dir = Math.sign(was) || ctx.rng.pick([-1, 1]);
        const step = chance(ctx, 0.45, 0.45) ? dir * ctx.rng.weighted([1, 2, 3, 4], [3, 3, 2, ctx.amount * 2]) : was;
        index = keepNear(ctx, index + step, n.pitch);
      }
      if (strong(n.start)) index = snapToChordTone(ctx.pool, chordOf(ctx, n.start).tones, index, 0);
      return { ...n, pitch: ctx.pool[index] };
    });
    return done(notes, 'Same rhythm, new notes');
  },
};

/** The bar's notes, in order, put to one of the style's rhythm cells. */
const newRhythm: Move = {
  id: 'newRhythm',
  group: 'rhythm',
  weight: 1.1,
  run(line, ctx) {
    const out: Tone[] = [];
    let changed = false;
    for (let bar = 0; bar < ctx.bars; bar++) {
      const notes = inBar(line, bar);
      if (notes.length < 2 || !chance(ctx, 0.45, 0.5)) {
        out.push(...notes);
        continue;
      }
      const hits = parseCell(ctx.rng.pick(CELLS[ctx.style.id]));
      const span = Math.max(1, hits.length - 1);
      hits.forEach((h, i) => {
        const from = notes[Math.min(notes.length - 1, Math.round((i * (notes.length - 1)) / span))];
        out.push({ pitch: from.pitch, start: bar * TICKS_PER_BAR + h.step * STEP, duration: h.len * STEP, velocity: from.velocity });
      });
      changed = true;
    }
    return changed ? done(out, 'Same notes, new rhythm') : null;
  },
};

/** Notes on the beat slip a sixteenth late (or early), leaning the line off the grid. */
const syncopate: Move = {
  id: 'syncopate',
  group: 'time',
  weight: 1,
  run(line, ctx) {
    let changed = false;
    const notes = line.map((n, i) => {
      if (n.start % TICKS_PER_BAR === 0 || !onBeat(n.start) || !chance(ctx, 0.5, 0.4)) return n;
      const prev = line[i - 1];
      if (ctx.rng.chance(0.6)) {
        if (n.duration < 2 * STEP) return n;
        changed = true;
        return { ...n, start: n.start + STEP, duration: n.duration - STEP };
      }
      if (prev && prev.start >= n.start - STEP) return n;
      changed = true;
      return { ...n, start: n.start - STEP, duration: n.duration + STEP };
    });
    return changed ? done(notes, 'Syncopated') : null;
  },
};

/** The whole part shifted against the beat, wrapping round the loop. */
const push: Move = {
  id: 'push',
  group: 'time',
  weight: 0.6,
  run(line, ctx) {
    const by = ctx.rng.weighted([STEP, -STEP, 2 * STEP, -2 * STEP], [1, 1, 0.6 + ctx.amount, 0.6 + ctx.amount]);
    const notes = line.map((n) => ({ ...n, start: (((n.start + by) % ctx.end) + ctx.end) % ctx.end }));
    const size = Math.abs(by) === STEP ? 'a 16th' : 'an 8th';
    return done(notes, by > 0 ? `Pushed ${size} late` : `Pulled ${size} early`);
  },
};

/** Mirrored around the first note: steps up become steps down. At low amounts only the second half turns over. */
const invert: Move = {
  id: 'invert',
  group: 'pitch',
  weight: 0.8,
  run(line, ctx) {
    if (line.length < 3) return null;
    const half = ctx.amount < 0.4 ? ctx.end / 2 : 0;
    const touched = line.filter((n) => n.start >= half);
    if (touched.length < 2) return null;
    const pivot = at(ctx, touched[0].pitch);
    const notes = line.map((n) => {
      if (n.start < half) return n;
      let index = keepNear(ctx, 2 * pivot - at(ctx, n.pitch), n.pitch);
      if (strong(n.start)) index = snapToChordTone(ctx.pool, chordOf(ctx, n.start).tones, index, 0);
      return { ...n, pitch: ctx.pool[index] };
    });
    return done(notes, half ? 'Second half upside down' : 'Upside down');
  },
};

/** Each bar's pitches played in reverse order over the same rhythm. */
const reverse: Move = {
  id: 'reverse',
  group: 'pitch',
  weight: 0.7,
  run(line, ctx) {
    const pitchOf = new Map<Tone, number>();
    for (let bar = 0; bar < ctx.bars; bar++) {
      const notes = inBar(line, bar);
      if (notes.length < 3 || !chance(ctx, 0.5, 0.5)) continue;
      notes.forEach((n, i) => pitchOf.set(n, notes[notes.length - 1 - i].pitch));
    }
    const notes = line.map((n) => ({ ...n, pitch: pitchOf.get(n) ?? n.pitch }));
    return pitchOf.size ? done(notes, 'Pitches reversed') : null;
  },
};

/** The last bar re-pitched as a run that leads back to the top of the loop. */
const newEnding: Move = {
  id: 'newEnding',
  group: 'ending',
  weight: 1,
  run(line, ctx) {
    const lastBar = ctx.bars - 1;
    const tail = inBar(line, lastBar);
    if (tail.length < 2 || !line.length) return null;
    const final = chordOf(ctx, tail[tail.length - 1].start);
    const from = at(ctx, tail[0].pitch);
    const goal = snapToChordTone(ctx.pool, final.tones, keepNear(ctx, at(ctx, line[0].pitch) + ctx.rng.pick([-2, -1, 1, 2]), line[0].pitch), 0);
    const pitchOf = new Map<Tone, number>();
    tail.forEach((n, i) => {
      if (i === 0) return;
      const t = i / (tail.length - 1);
      const wiggle = i < tail.length - 1 && ctx.rng.chance(0.3 + ctx.amount * 0.3) ? ctx.rng.pick([-1, 1]) : 0;
      let index = Math.round(from + (goal - from) * t) + wiggle;
      if (strong(n.start) || i === tail.length - 1) index = snapToChordTone(ctx.pool, chordOf(ctx, n.start).tones, index, 0);
      pitchOf.set(n, ctx.pool[clamp(index, 0, ctx.pool.length - 1)]);
    });
    const notes = line.map((n) => ({ ...n, pitch: pitchOf.get(n) ?? n.pitch }));
    return same(notes, line) ? null : done(notes, 'New ending');
  },
};

/** Passing notes across leaps, and a neighbour note inside long ones. */
const passing: Move = {
  id: 'passing',
  group: 'shape',
  weight: 1,
  run(line, ctx) {
    const out: Tone[] = [];
    line.forEach((n, i) => {
      const next = line[i + 1];
      const gapIndex = next ? at(ctx, next.pitch) - at(ctx, n.pitch) : 0;
      if (next && n.duration >= 2 * STEP && next.start - n.start >= 2 * STEP && Math.abs(gapIndex) >= 2 && chance(ctx, 0.3, 0.45)) {
        const t = next.start - STEP;
        out.push({ ...n, duration: t - n.start });
        out.push({ pitch: ctx.pool[at(ctx, next.pitch) - Math.sign(gapIndex)], start: t, duration: STEP, velocity: n.velocity - 8 });
        return;
      }
      if (n.duration >= 4 * STEP && chance(ctx, 0.1, 0.35)) {
        const half = Math.floor(n.duration / STEP / 2) * STEP;
        const neighbour = ctx.pool[clamp(at(ctx, n.pitch) + ctx.rng.pick([-1, 1]), 0, ctx.pool.length - 1)];
        out.push({ ...n, duration: half });
        out.push({ pitch: neighbour, start: n.start + half, duration: STEP, velocity: n.velocity - 8 });
        out.push({ ...n, start: n.start + half + STEP, duration: n.duration - half - STEP, velocity: n.velocity - 4 });
        return;
      }
      out.push(n);
    });
    return out.length > line.length ? done(out, 'Passing notes') : null;
  },
};

/** Off-beat notes jump an octave. */
const octaves: Move = {
  id: 'octaves',
  group: 'register',
  weight: 0.8,
  run(line, ctx) {
    const up = ctx.track !== 'counter';
    const jump = (p: number) => (up ? (p + 12 <= ctx.high ? p + 12 : p - 12) : p - 12 >= ctx.low ? p - 12 : p + 12);
    const offbeat = line.map((n, i) => (i > 0 && !onBeat(n.start) ? i : -1)).filter((i) => i >= 0);
    if (!offbeat.length) return null;
    const picked = new Set(offbeat.filter(() => chance(ctx, 0.25, 0.35)));
    if (!picked.size) picked.add(ctx.rng.pick(offbeat));
    const notes = line.map((n, i) => (picked.has(i) ? { ...n, pitch: jump(n.pitch) } : n));
    return done(notes, 'Octave leaps');
  },
};

/** Short off-beat notes taken out, the note before held on through the space. */
const strip: Move = {
  id: 'strip',
  group: 'rhythm',
  weight: 0.7,
  run(line, ctx) {
    if (line.length < 6) return null;
    const out: Tone[] = [];
    for (const n of line) {
      const prev = out[out.length - 1];
      const removable = prev && !onBeat(n.start) && n.duration <= 2 * STEP && out.length + (line.length - out.length) > line.length / 2;
      if (removable && chance(ctx, 0.5, 0.4)) {
        if (prev.start + prev.duration >= n.start - STEP) prev.duration = n.start + n.duration - prev.start;
        continue;
      }
      out.push({ ...n });
    }
    return out.length < line.length && out.length >= line.length / 2 ? done(out, 'Stripped back') : null;
  },
};

/** Odd bars replaced by the bar before them, moved up a third or down a step. */
const sequence: Move = {
  id: 'sequence',
  group: 'pitch',
  weight: 0.9,
  run(line, ctx) {
    if (ctx.bars < 2) return null;
    const shift = ctx.rng.weighted([2, -1, 1], [2, 1, 1]);
    const replaced = new Set<number>();
    const added: Tone[] = [];
    for (let bar = 1; bar < ctx.bars; bar += 2) {
      const src = inBar(line, bar - 1);
      if (src.length < 2 || !chance(ctx, 0.55, 0.4)) continue;
      replaced.add(bar);
      for (const n of src) {
        const start = n.start + TICKS_PER_BAR;
        let index = keepNear(ctx, at(ctx, n.pitch) + shift, n.pitch);
        if (strong(start)) index = snapToChordTone(ctx.pool, chordOf(ctx, start).tones, index, shift > 0 ? 1 : -1);
        added.push({ ...n, start, pitch: ctx.pool[index] });
      }
    }
    if (!replaced.size) return null;
    const kept = line.filter((n) => !replaced.has(Math.floor(n.start / TICKS_PER_BAR)));
    return done([...kept, ...added], shift > 0 ? 'Sequenced up' : 'Sequenced down');
  },
};

// Bass

/** Index of the chord a tick falls in. */
const chordIndex = (ctx: Ctx, tick: number) => Math.max(0, ctx.progression.indexOf(chordOf(ctx, tick)));
/** The chord root nearest `near`. */
const rootNear = (chord: Chord, near: number) => near + ((((chord.root - pc(near) + 6) % 12) + 12) % 12) - 6;

/** A note a semitone or a scale step away leads into each new chord. */
const approach: Move = {
  id: 'approach',
  group: 'shape',
  weight: 1.1,
  run(line, ctx) {
    const out = line.map((n) => ({ ...n }));
    let changed = false;
    for (const change of ctx.progression) {
      const t = (change.start || ctx.end) - STEP;
      const target = out.find((n) => n.start === change.start) ?? out[0];
      if (!target || !chance(ctx, 0.5, 0.5)) continue;
      const chromatic = ctx.rng.chance(0.5);
      const index = at(ctx, target.pitch);
      const pitch = chromatic ? target.pitch + ctx.rng.pick([-1, 1]) : ctx.pool[clamp(index + ctx.rng.pick([-1, 1]), 0, ctx.pool.length - 1)];
      const starting = out.find((n) => n.start === t);
      const holding = out.find((n) => n.start < t && n.start + n.duration > t);
      if (starting) starting.pitch = pitch;
      else if (holding && t - holding.start >= STEP) {
        holding.duration = t - holding.start;
        out.push({ pitch, start: t, duration: STEP, velocity: holding.velocity - 6 });
      } else if (!holding) out.push({ pitch, start: t, duration: STEP, velocity: target.velocity - 10 });
      else continue;
      changed = true;
    }
    return changed ? done(out, 'Approach notes') : null;
  },
};

/** Repeated roots turned into root–fifth–octave figures. */
const walk: Move = {
  id: 'walk',
  group: 'pitch',
  weight: 0.9,
  run(line, ctx) {
    const firstIn = new Map<number, number>();
    const count = new Map<number, number>();
    let changed = false;
    const notes = line.map((n) => {
      const c = chordIndex(ctx, n.start);
      if (!firstIn.has(c)) {
        firstIn.set(c, n.pitch);
        count.set(c, 0);
        return n;
      }
      const k = count.get(c)! + 1;
      count.set(c, k);
      const base = firstIn.get(c)!;
      if (n.pitch !== base || !chance(ctx, 0.45, 0.45)) return n;
      const offset = [7, 12, 7, 0][(k - 1) % 4];
      const pitch = base + offset;
      if (pitch > ctx.high || !ctx.pool.includes(pitch) || offset === 0) return n;
      changed = true;
      return { ...n, pitch };
    });
    return changed ? done(notes, 'Root–fifth walks') : null;
  },
};

/** The first note of each new chord lands a sixteenth or an eighth early. */
const anticipate: Move = {
  id: 'anticipate',
  group: 'time',
  weight: 1,
  run(line, ctx) {
    const out = line.map((n) => ({ ...n }));
    let changed = false;
    for (const change of ctx.progression) {
      if (!change.start) continue;
      const note = out.find((n) => n.start === change.start);
      if (!note || !chance(ctx, 0.5, 0.4)) continue;
      const by = ctx.rng.pick([1, 2]) * STEP;
      const prev = out.filter((n) => n.start < note.start).pop();
      if (prev && prev.start >= note.start - by) continue;
      note.start -= by;
      note.duration += by;
      changed = true;
    }
    return changed ? done(out, 'Pushed changes') : null;
  },
};

/** Ghost sixteenths fill the spaces. */
const busier: Move = {
  id: 'busier',
  group: 'rhythm',
  weight: 0.9,
  run(line, ctx) {
    const out = line.map((n) => ({ ...n }));
    const added: Tone[] = [];
    out.forEach((n, i) => {
      const nextStart = out[i + 1]?.start ?? ctx.end;
      const end = n.start + n.duration;
      // A ghost on the off-sixteenth after a note that leaves space.
      let t = end % (2 * STEP) === 0 ? end + STEP : end;
      if (n.duration > 4 * STEP && chance(ctx, 0.2, 0.3)) {
        n.duration = 2 * STEP;
        t = n.start + 3 * STEP;
      }
      if (t + STEP <= nextStart && chance(ctx, 0.4, 0.45)) {
        added.push({ pitch: ctx.rng.chance(0.75) ? n.pitch : n.pitch + 12 <= ctx.high ? n.pitch + 12 : n.pitch, start: t, duration: STEP, velocity: n.velocity * 0.7 });
      }
    });
    return added.length ? done([...out, ...added], 'Busier') : null;
  },
};

/** Just the roots, on each chord change and beat three, held. */
const rootsOnly: Move = {
  id: 'rootsOnly',
  group: 'rhythm',
  weight: 0.6,
  run(line, ctx) {
    const out: Tone[] = [];
    for (const chord of ctx.progression) {
      const inside = line.filter((n) => n.start >= chord.start && n.start < chord.start + chord.duration);
      const near = inside[0]?.pitch ?? out[out.length - 1]?.pitch ?? line[0]?.pitch;
      if (near === undefined) continue;
      const pitch = rootNear(chord, near);
      const hits = chord.duration > TICKS_PER_BAR / 2 && chance(ctx, 0.5, -0.3) ? [0, TICKS_PER_BAR / 2] : [0];
      hits.forEach((h, i) => {
        const next = hits[i + 1] ?? chord.duration;
        out.push({ pitch, start: chord.start + h, duration: next - h - (i === hits.length - 1 ? STEP : 0), velocity: inside[0]?.velocity ?? 96 });
      });
    }
    return same(out, line) ? null : done(out, 'Roots only');
  },
};

/** Each note held into the next, so an 808 slides between them. */
const legato: Move = {
  id: 'legato',
  group: 'shape',
  weight: 0.5,
  run(line) {
    let changed = false;
    const notes = line.map((n, i) => {
      const next = line[i + 1];
      if (!next || next.start - (n.start + n.duration) <= 0 || next.start - n.start > 8 * STEP) return n;
      changed = true;
      return { ...n, duration: next.start - n.start };
    });
    return changed ? done(notes, 'Tied together') : null;
  },
};

/** The last beat walks through the scale back to the first note. */
const walkUp: Move = {
  id: 'walkUp',
  group: 'ending',
  weight: 0.9,
  run(line, ctx) {
    if (line.length < 2) return null;
    const from = ctx.end - BEAT;
    const kept = line.filter((n) => n.start < from).map((n) => ({ ...n, duration: Math.min(n.duration, from - n.start) }));
    const before = kept[kept.length - 1];
    if (!before) return null;
    const target = at(ctx, line[0].pitch);
    const up = before.pitch <= line[0].pitch;
    const eighths = ctx.rng.chance(0.5 - ctx.amount * 0.3);
    const count = eighths ? 2 : 3;
    const rate = eighths ? 2 * STEP : STEP;
    const run = Array.from({ length: count }, (_, i): Tone => ({
      pitch: ctx.pool[clamp(target + (up ? -(count - i) : count - i), 0, ctx.pool.length - 1)],
      start: ctx.end - (count - i) * rate,
      duration: rate,
      velocity: before.velocity - 6 + i * 4,
    }));
    return done([...kept, ...run], up ? 'Walk-up ending' : 'Walk-down ending');
  },
};

/** The bass put to another of the style's grooves, roots and fifths from the original. */
const bassGroove: Move = {
  id: 'bassGroove',
  group: 'rhythm',
  weight: 1,
  run(line, ctx) {
    const patterns = ctx.style.bass.flat();
    const pattern = ctx.rng.pick(patterns);
    const out: Tone[] = [];
    ctx.progression.forEach((chord, i) => {
      const first = line.find((n) => n.start >= chord.start && n.start < chord.start + chord.duration) ?? line[0];
      if (!first) return;
      const root = rootNear(chord, first.pitch);
      const nextRoot = rootNear(ctx.progression[(i + 1) % ctx.progression.length], root);
      for (const h of hitsAt(pattern, (chord.start % TICKS_PER_BAR) / STEP, chord.duration / STEP)) {
        const pitch =
          h.tone === 'octave' && root + 12 <= ctx.high ? root + 12
          : h.tone === 'fifth' ? root + 7
          : h.tone === 'approach' || h.tone === 'chromatic' ? nextRoot + (nextRoot > root ? -1 : 1)
          : root;
        out.push({ pitch, start: chord.start + h.step * STEP, duration: h.len * STEP, velocity: h.step % 4 === 0 ? first.velocity : first.velocity - 8 });
      }
    });
    return out.length && !same(out, line) ? done(out, 'New groove') : null;
  },
};

// ---------------------------------------------------------------------------
// Moves for chords, which work on hits: the notes struck together

interface ChordHit {
  start: number;
  duration: number;
  pitches: number[];
  velocity: number;
}

function toHits(line: readonly Tone[]): ChordHit[] {
  const byStart = new Map<number, ChordHit>();
  for (const n of line) {
    const hit = byStart.get(n.start) ?? { start: n.start, duration: 0, pitches: [], velocity: 0 };
    hit.duration = Math.max(hit.duration, n.duration);
    hit.pitches.push(n.pitch);
    hit.velocity = Math.max(hit.velocity, n.velocity);
    byStart.set(n.start, hit);
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start).map((h) => ({ ...h, pitches: [...new Set(h.pitches)].sort((a, b) => a - b) }));
}

const fromHits = (hits: readonly ChordHit[]): Tone[] =>
  hits.flatMap((h) => h.pitches.map((pitch) => ({ pitch, start: h.start, duration: h.duration, velocity: h.velocity })));

/** Applies `edit` to every hit of a chord, deciding chord by chord so a voicing stays put while its chord lasts. */
function perChord(ctx: Ctx, line: Tone[], base: number, span: number, edit: (pitches: number[], chord: Chord) => number[] | null): Tone[] | null {
  const hits = toHits(line);
  const decided = new Map<number, boolean>();
  let changed = false;
  const out = hits.map((h) => {
    const c = chordIndex(ctx, h.start);
    if (!decided.has(c)) decided.set(c, chance(ctx, base, span));
    if (!decided.get(c)) return h;
    const pitches = edit(h.pitches, ctx.progression[c]);
    if (!pitches) return h;
    changed = true;
    return { ...h, pitches };
  });
  return changed ? fromHits(out) : null;
}

const inversion = (dir: 1 | -1): Move => ({
  id: dir > 0 ? 'invertUp' : 'invertDown',
  group: 'voicing',
  weight: 0.8,
  run(line, ctx) {
    const notes = perChord(ctx, line, 0.55, 0.45, (p) => {
      if (p.length < 2) return null;
      if (dir > 0) return p[0] + 12 <= ctx.high ? [...p.slice(1), p[0] + 12] : null;
      const top = p[p.length - 1];
      return top - 12 >= ctx.low ? [top - 12, ...p.slice(0, -1)] : null;
    });
    return notes && done(notes, dir > 0 ? 'Inversions up' : 'Inversions down');
  },
});

/** Drop-2: the second voice from the top drops an octave. */
const spread: Move = {
  id: 'spread',
  group: 'voicing',
  weight: 0.8,
  run(line, ctx) {
    const notes = perChord(ctx, line, 0.6, 0.4, (p) => {
      if (p.length < 3 || p[p.length - 2] - 12 < ctx.low) return null;
      const dropped = p[p.length - 2] - 12;
      return [dropped, ...p.filter((_, i) => i !== p.length - 2)].sort((a, b) => a - b);
    });
    return notes && done(notes, 'Open voicings');
  },
};

/** A seventh or ninth from the scale added to each voicing. */
const addColour: Move = {
  id: 'addColour',
  group: 'pitch',
  weight: 1,
  run(line, ctx) {
    const ninth = ctx.rng.chance(0.5);
    const notes = perChord(ctx, line, 0.6, 0.4, (p, chord) => {
      const scale = chord.scale ?? ctx.keyScale;
      const i = scale.indexOf(chord.root);
      if (i < 0) return null;
      const colour = scale[(i + (ninth ? 1 : 6)) % scale.length];
      const interval = (colour - chord.root + 12) % 12;
      // No flat nines, and no major seventh over a minor chord.
      if (interval === 1 || (!ninth && interval === 11 && chord.quality === 'min')) return null;
      if (p.some((x) => pc(x) === colour)) return null;
      const top = p[p.length - 1];
      let pitch = top - ((pc(top) - colour + 12) % 12);
      if (pitch <= p[0]) pitch += 12;
      if (pitch > ctx.high) return null;
      return [...p, pitch].sort((a, b) => a - b);
    });
    return notes && done(notes, ninth ? 'Added 9ths' : 'Added 7ths');
  },
};

/** Back to plain triads: colour tones taken out. */
const triads: Move = {
  id: 'triads',
  group: 'pitch',
  weight: 0.5,
  run(line, ctx) {
    const notes = perChord(ctx, line, 1, 0, (p, chord) => {
      const kept = p.filter((x) => chord.tones.slice(0, 3).includes(pc(x)));
      return kept.length >= 2 && kept.length < p.length ? kept : null;
    });
    return notes && done(notes, 'Plain triads');
  },
};

/** The voicing at each chord change, re-struck on new hits. */
function rechord(ctx: Ctx, line: Tone[], hitsFor: (chord: Chord) => { step: number; len: number }[]): Tone[] {
  const hits = toHits(line);
  const out: ChordHit[] = [];
  for (const chord of ctx.progression) {
    const first = hits.find((h) => h.start >= chord.start - 2 * STEP && h.start < chord.start + chord.duration);
    if (!first) continue;
    for (const h of hitsFor(chord)) out.push({ ...first, start: chord.start + h.step * STEP, duration: h.len * STEP });
  }
  return fromHits(out);
}

const restab: Move = {
  id: 'restab',
  group: 'rhythm',
  weight: 1.3,
  run(line, ctx) {
    const pattern = ctx.rng.pick(ctx.style.chords.flat());
    const notes = rechord(ctx, line, (chord) => hitsAt(pattern, (chord.start % TICKS_PER_BAR) / STEP, chord.duration / STEP));
    return notes.length && !same(notes, line) ? done(notes, 'New chord rhythm') : null;
  },
};

const offbeat: Move = {
  id: 'offbeat',
  group: 'rhythm',
  weight: 0.9,
  run(line, ctx) {
    const len = ctx.rng.pick([1, 2]);
    const notes = rechord(ctx, line, (chord) =>
      Array.from({ length: chord.duration / (4 * STEP) }, (_, i) => ({ step: i * 4 + 2, len })),
    );
    return notes.length && !same(notes, line) ? done(notes, 'Offbeat stabs') : null;
  },
};

const pads: Move = {
  id: 'pads',
  group: 'rhythm',
  weight: 0.7,
  run(line, ctx) {
    const notes = rechord(ctx, line, (chord) => [{ step: 0, len: chord.duration / STEP }]);
    return notes.length && !same(notes, line) ? done(notes, 'Held chords') : null;
  },
};

/** Chord changes struck a sixteenth or an eighth before the beat. */
const pushChanges: Move = {
  id: 'pushChanges',
  group: 'time',
  weight: 0.9,
  run(line, ctx) {
    const hits = toHits(line);
    let changed = false;
    for (const chord of ctx.progression) {
      if (!chord.start) continue;
      const hit = hits.find((h) => h.start === chord.start);
      if (!hit || !chance(ctx, 0.55, 0.4)) continue;
      const by = ctx.rng.pick([1, 2]) * STEP;
      const prev = hits.filter((h) => h.start < hit.start).pop();
      if (prev && prev.start >= hit.start - by) continue;
      if (prev && prev.start + prev.duration > hit.start - by) prev.duration = hit.start - by - prev.start;
      hit.start -= by;
      hit.duration += by;
      changed = true;
    }
    return changed ? done(fromHits(hits), 'Pushed changes') : null;
  },
};

/** Each chord rolled out low to high in sixteenths, every note held to the end of the hit. */
const broken: Move = {
  id: 'broken',
  group: 'rhythm',
  weight: 1,
  run(line, ctx) {
    const down = ctx.rng.chance(0.3);
    const rate = ctx.rng.chance(0.5 + ctx.amount * 0.3) ? STEP : 2 * STEP;
    const out: Tone[] = [];
    let changed = false;
    for (const h of toHits(line)) {
      const order = down ? [...h.pitches].reverse() : h.pitches;
      const fits = Math.min(order.length, Math.floor(h.duration / rate));
      if (fits < 2) {
        out.push(...fromHits([h]));
        continue;
      }
      changed = true;
      order.slice(0, fits).forEach((pitch, i) =>
        out.push({ pitch, start: h.start + i * rate, duration: h.duration - i * rate, velocity: h.velocity - i * 3 }),
      );
    }
    return changed ? done(out, down ? 'Broken chords, top down' : 'Broken chords') : null;
  },
};

const LINE_MOVES: Move[] = [newNotes, newRhythm, syncopate, push, invert, reverse, newEnding, passing, octaves, strip, sequence];
const BASS_MOVES: Move[] = [octaves, approach, walk, anticipate, busier, rootsOnly, legato, walkUp, bassGroove, syncopate, push];
const CHORD_MOVES: Move[] = [inversion(1), inversion(-1), spread, addColour, triads, restab, offbeat, pads, pushChanges, broken];

function movesFor(track: TrackId, style: StyleId): Move[] {
  if (track === 'chords') return CHORD_MOVES;
  if (track === 'bass') return BASS_MOVES.map((m) => (m.id === 'legato' && style === 'rap' ? { ...m, weight: 1.4 } : m));
  return LINE_MOVES;
}

// ---------------------------------------------------------------------------

/** Keeps a take playable: on the grid, inside the loop and the range, one note at a time where the part needs it. */
function tidyTake(ctx: Ctx, notes: readonly Tone[]): Tone[] {
  const mono = ctx.track !== 'chords';
  let out = notes
    .map((n) => {
      const start = clamp(Math.round(n.start / STEP) * STEP, 0, ctx.end - STEP);
      const duration = clamp(Math.round(n.duration / STEP) * STEP, STEP, ctx.end - start);
      let pitch = n.pitch;
      while (pitch > ctx.high) pitch -= 12;
      while (pitch < ctx.low) pitch += 12;
      if (ctx.track !== 'bass' && ctx.track !== 'chords') pitch = fitToChord(pitch, chordOf(ctx, start));
      return { pitch, start, duration, velocity: velocity(n.velocity) };
    })
    .sort((a, b) => a.start - b.start || (ctx.track === 'bass' ? a.pitch - b.pitch : b.pitch - a.pitch));
  if (mono) {
    out = out.filter((n, i) => i === 0 || n.start !== out[i - 1].start);
    out.forEach((n, i) => {
      const next = out[i + 1];
      if (next) n.duration = Math.max(STEP, Math.min(n.duration, next.start - n.start));
    });
  } else {
    out = out.filter((n, i) => !out.slice(0, i).some((m) => m.start === n.start && m.pitch === n.pitch));
    out.forEach((n, i) => {
      const next = out.slice(i + 1).find((m) => m.pitch === n.pitch);
      if (next) n.duration = Math.max(STEP, Math.min(n.duration, next.start - n.start));
    });
  }
  return out;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Six variations of one uploaded part. Each card leads with a different move, picked by weight,
 * and adds one or two more as `amount` rises. Same source, same cards.
 */
export function makeVariations(source: ImportSource, track: TrackId, style: StyleId): Variation[] {
  const part = source.parts.find((p) => p.track === track);
  if (!part || !part.notes.length) return [];
  const original: Tone[] = part.notes.map(({ pitch, start, duration, velocity: v }) => ({ pitch, start, duration, velocity: v }));
  const melodic = track === 'melody' || track === 'counter' || track === 'brass';
  const pcs = melodic ? scalePitchClasses(source.key, source.scale) : harmonyPitchClasses(source.key, source.scale);
  const pitches = original.map((n) => n.pitch);
  const base = {
    amount: source.amount,
    style: STYLES[style],
    track,
    bars: source.bars,
    end: totalTicks(source.bars),
    progression: source.progression,
    pool: pitchesInRange(pcs, 12, 120),
    octave: pcs.length,
    low: Math.max(21, Math.min(...pitches) - 7),
    high: Math.min(108, Math.max(...pitches) + 7),
    keyScale: harmonyPitchClasses(source.key, source.scale),
  };
  const moves = movesFor(track, style);
  const leads = new Set<string>();
  const seen = new Set([signature(original)]);
  const cards: Variation[] = [];

  for (let card = 0; card < VARIATION_COUNT; card++) {
    let made: { label: string; notes: Tone[] } | null = null;
    for (let attempt = 0; attempt < 8 && !made; attempt++) {
      const rng = createRng(deriveSeed(source.variationSeed, `${track}/${card}/${attempt}`));
      const ctx: Ctx = { ...base, rng };
      // Fresh leads first; once they run out, any move can lead again.
      const fresh = moves.filter((m) => !leads.has(m.id));
      const pool = attempt < 4 && fresh.length ? fresh : moves;
      const lead = rng.weighted(pool, pool.map((m) => m.weight));
      const first = lead.run(original.map((n) => ({ ...n })), ctx);
      if (!first) continue;
      let notes = first.notes;
      const labels = [first.label];
      const groups = new Set([lead.group]);
      const extras = (rng.chance(source.amount * 0.9) ? 1 : 0) + (rng.chance(source.amount * source.amount * 0.6) ? 1 : 0);
      for (let k = 0; k < extras; k++) {
        const options = moves.filter((m) => !groups.has(m.group));
        if (!options.length) break;
        const extra = rng.weighted(options, options.map((m) => m.weight));
        groups.add(extra.group);
        const next = extra.run(tidyTake(ctx, notes), ctx);
        if (!next) continue;
        notes = next.notes;
        labels.push(lowerFirst(next.label));
      }
      const tidied = tidyTake(ctx, notes);
      const sig = signature(tidied);
      if (!tidied.length || seen.has(sig)) continue;
      seen.add(sig);
      leads.add(lead.id);
      made = { label: labels.join(' · '), notes: tidied };
    }
    if (!made) continue;
    const seed = deriveSeed(source.variationSeed, `${track}/take${card + 1}`);
    cards.push({
      label: made.label,
      notes: made.notes.map((n, i) => ({ ...n, id: noteId(track, seed, i), track })),
    });
  }
  return cards;
}
