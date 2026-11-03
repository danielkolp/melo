import {
  augment,
  contour,
  displace,
  fragment,
  invert,
  makeMotif,
  motion,
  newTail,
  ornament,
  reshape,
  retrograde,
  syncopate,
  tidy,
  vary,
  type ContourKind,
  type Motif,
} from './motif';
import { createRng, deriveSeed, type Rng } from './random';
import { REGISTERS, chordAt, clamp, fitToChord, nearestIndex, noteId, onsetProfile, pc, snapToChordTone, velocity } from './shared';
import { STYLES, type StyleDef } from './styles';
import { SCALES, pitchesInRange, scalePitchClasses } from './theory';
import {
  STEP,
  STEPS_PER_BAR,
  TICKS_PER_BAR,
  type Chord,
  type CompositionSettings,
  type NoteEvent,
  type PhraseForm,
  type PhraseRole,
  type Phrasing,
  type ResolvedForm,
  type StyleId,
  totalTicks,
} from './types';

export const PHRASE_FORMS: Record<PhraseForm, { label: string; description: string }> = {
  auto: { label: 'Auto', description: 'Picks a phrase shape that suits the style.' },
  callResponse: { label: 'Call & response', description: 'A one-bar call, then an answer that turns it around.' },
  trade: { label: 'Trade', description: 'The melody calls and the counter-melody answers.' },
  hook: { label: 'Hook', description: 'A short riff that repeats with small changes.' },
  questionAnswer: { label: 'Question & answer', description: 'Two bars that end open, two that bring it home.' },
  sequence: { label: 'Sequence', description: 'One motif, moved through the chords step by step.' },
  arc: { label: 'Arc', description: 'Climbs to a peak in the third bar, then falls back.' },
};

export const PHRASE_FORM_IDS = Object.keys(PHRASE_FORMS) as PhraseForm[];

export const ROLE_LABELS: Record<PhraseRole, string> = {
  call: 'call',
  response: 'response',
  hook: 'hook',
  question: 'question',
  answer: 'answer',
  motif: 'motif',
  rise: 'rise',
  peak: 'peak',
  fall: 'fall',
  yours: 'yours',
};

const AUTO_FORMS: Record<StyleId, [ResolvedForm, number][]> = {
  ukg: [['callResponse', 3], ['trade', 2.5], ['hook', 3], ['questionAnswer', 1.5], ['sequence', 1]],
  house: [['hook', 3], ['callResponse', 2.5], ['sequence', 2], ['questionAnswer', 1.5], ['trade', 1.5]],
  deepHouse: [['questionAnswer', 3], ['callResponse', 2.5], ['arc', 2], ['trade', 2], ['sequence', 1]],
  melodicHouse: [['arc', 3], ['sequence', 2.5], ['questionAnswer', 2], ['hook', 1.5], ['callResponse', 1]],
  rap: [['hook', 3.5], ['callResponse', 2.5], ['questionAnswer', 2], ['sequence', 1], ['trade', 1]],
};

const HOOK_CONTOURS: ContourKind[] = ['pedal', 'repeat', 'octave', 'turn'];

/** How often a hook is a two-bar riff, against one of the contours above. */
const RIFF: Record<StyleId, number> = { ukg: 1.5, house: 3, deepHouse: 1.5, melodicHouse: 0.7, rap: 1.5 };

/** Chance that a downbeat note is pushed a sixteenth-pair early, across the barline. */
const ANTICIPATION: Record<StyleId, number> = { ukg: 0.45, house: 0.35, deepHouse: 0.3, melodicHouse: 0.15, rap: 0.15 };

type Ending = 'open' | 'closed' | null;

interface BarPlan {
  role: PhraseRole;
  voice: 'melody' | 'counter';
  /** Null when another part plays this bar. */
  motif: Motif | null;
  /** Absolute pool index, or an offset from wherever the previous phrase ended. */
  start: { at: number } | { follow: number };
  ending: Ending;
  accent: number;
  /** Played exactly the same when the phrase comes round again (a riff), rather than varied. */
  fixed?: boolean;
}

interface Ctx {
  rng: Rng;
  style: StyleDef;
  settings: CompositionSettings;
  progression: readonly Chord[];
  pool: number[];
  /** Scale steps per octave (7, or 5 for pentatonics). */
  octave: number;
  centre: number;
  /** How often the parts already written start a note on each sixteenth: the rhythm the melody leans on. */
  groove?: readonly number[];
}

const fresh = (ctx: Ctx, density = ctx.settings.density, contour?: ContourKind, avoid?: ReadonlySet<number>) =>
  makeMotif(ctx.rng, ctx.style, density, ctx.octave, { contour, avoid, creativity: ctx.settings.creativity, groove: ctx.groove });

const sameShape = (a: Motif, b: Motif) => JSON.stringify(a) === JSON.stringify(b);

/** An answer that contrasts with the call but is clearly made from it. */
export function respond(ctx: Ctx, call: Motif): Motif {
  const { rng } = ctx;
  const callSteps = new Set(call.map((n) => n.step));
  const options: [() => Motif, number][] = [
    [() => invert(call), 2],
    [() => retrograde(call), 1.5],
    [() => fragment(call, rng.pick([-1, 1, 2])), 1.5],
    [() => augment(call), call.length >= 5 ? 2 : 0.4],
    [() => displace(call, 2), 1.2],
    [() => fresh(ctx, ctx.settings.density * 0.85, undefined, callSteps), 2.5],
    [() => newTail(call, fresh(ctx), rng.pick([-1, 1])), 1.5],
    // Rhythmic surprises, as creativity rises.
    [() => syncopate(call), 1.2 * ctx.settings.creativity],
    [() => ornament(call, rng), ctx.settings.creativity],
  ];
  const answer = rng.weighted(options, options.map(([, w]) => w))[0]();
  return sameShape(answer, call) ? invert(call) : answer;
}

function plan(ctx: Ctx, form: ResolvedForm, final: boolean): BarPlan[] {
  const { rng, settings, centre, octave } = ctx;
  const v = settings.variation;
  const away = (m: Motif) => (motion(m) > 0 ? -1 : 1) * rng.pick([2, 3]);
  const close: Ending = final ? 'closed' : 'open';

  switch (form) {
    case 'callResponse':
    case 'trade': {
      const call = fresh(ctx);
      const voice = form === 'trade' ? 'counter' : 'melody';
      const r1 = form === 'trade' ? null : respond(ctx, call);
      // The second answer is the first one again, with a new ending.
      const r2 = r1 && vary(r1, rng, Math.max(0.3, v));
      return [
        { role: 'call', voice: 'melody', motif: call, start: { at: centre }, ending: 'open', accent: 2 },
        { role: 'response', voice, motif: r1, start: { follow: away(call) }, ending: 'open', accent: -6 },
        { role: 'call', voice: 'melody', motif: vary(call, rng, v * 0.8), start: { at: centre }, ending: 'open', accent: 2 },
        { role: 'response', voice, motif: r2, start: { follow: away(call) }, ending: close, accent: -4 },
      ];
    }
    case 'hook': {
      const kinds = [...HOOK_CONTOURS, 'riff' as const];
      const contour = rng.weighted(kinds, kinds.map((k) => (k === 'riff' ? RIFF[settings.style] : 1)));
      const a = fresh(ctx, settings.density, contour);
      if (contour === 'riff') {
        // A two-bar riff played twice: the second bar keeps the rhythm and answers on one note a
        // step from where the riff left off, or plays the riff's shape a step or two away.
        const mono = rng.chance(0.55);
        const answer = mono ? reshape(a, a.map(() => 0)) : a;
        const from = mono ? { follow: rng.pick([-1, 1]) } : { at: centre + rng.pick([-1, 1, 2]) };
        const end = rng.chance(v) ? vary(answer, rng, v) : answer;
        return [
          { role: 'hook', voice: 'melody', motif: a, start: { at: centre }, ending: null, accent: 0, fixed: true },
          { role: 'hook', voice: 'melody', motif: answer, start: from, ending: null, accent: -2, fixed: true },
          { role: 'hook', voice: 'melody', motif: a, start: { at: centre }, ending: null, accent: 0, fixed: true },
          { role: 'hook', voice: 'melody', motif: final ? end : answer, start: from, ending: final ? 'closed' : null, accent: -2, fixed: true },
        ];
      }
      const b = rng.chance(0.55) ? vary(a, rng, Math.max(0.3, v)) : displace(a, rng.pick([1, 2]));
      const end = final ? newTail(b, fresh(ctx, settings.density * 0.7)) : vary(b, rng, v);
      return [
        { role: 'hook', voice: 'melody', motif: a, start: { at: centre }, ending: null, accent: 0 },
        { role: 'hook', voice: 'melody', motif: b, start: { at: centre }, ending: null, accent: -2 },
        { role: 'hook', voice: 'melody', motif: vary(a, rng, v * 0.6), start: { at: centre }, ending: null, accent: 0 },
        { role: 'hook', voice: 'melody', motif: end, start: { at: centre }, ending: final ? 'closed' : null, accent: -2 },
      ];
    }
    case 'questionAnswer': {
      const a = fresh(ctx);
      const b = fresh(ctx, settings.density * 0.8);
      return [
        { role: 'question', voice: 'melody', motif: a, start: { at: centre }, ending: null, accent: 2 },
        { role: 'question', voice: 'melody', motif: b, start: { follow: rng.pick([-1, 1]) }, ending: 'open', accent: 0 },
        { role: 'answer', voice: 'melody', motif: vary(a, rng, v * 0.5), start: { at: centre }, ending: null, accent: 0 },
        { role: 'answer', voice: 'melody', motif: newTail(b, fresh(ctx, settings.density * 0.7)), start: { follow: rng.pick([-1, 1]) }, ending: close, accent: -3 },
      ];
    }
    case 'sequence': {
      const a = fresh(ctx);
      const firstDegree = chordAt(ctx.progression, 0).degree;
      // Move the motif with the harmony: each bar starts where its chord's root sits relative to the first.
      const shiftFor = (bar: number) => {
        let d = chordAt(ctx.progression, bar * TICKS_PER_BAR).degree - firstDegree;
        if (d > 3) d -= 7;
        if (d < -3) d += 7;
        return Math.round((d * octave) / 7);
      };
      return [
        { role: 'motif', voice: 'melody', motif: a, start: { at: centre }, ending: null, accent: 2 },
        { role: 'motif', voice: 'melody', motif: vary(a, rng, v * 0.4), start: { at: centre + shiftFor(1) }, ending: null, accent: 0 },
        { role: 'motif', voice: 'melody', motif: vary(a, rng, v * 0.4), start: { at: centre + shiftFor(2) }, ending: null, accent: 0 },
        { role: 'answer', voice: 'melody', motif: fragment(a, rng.pick([-1, 1])), start: { at: centre + shiftFor(3) }, ending: close, accent: -3 },
      ];
    }
    case 'arc': {
      const low = centre - Math.round(octave * 0.6);
      const high = centre + Math.round(octave * 0.5);
      const a = fresh(ctx, settings.density, rng.pick(['arpUp', 'zigzag'] as ContourKind[]));
      return [
        { role: 'rise', voice: 'melody', motif: a, start: { at: low }, ending: null, accent: -4 },
        { role: 'rise', voice: 'melody', motif: vary(a, rng, v * 0.5), start: { at: low + rng.pick([2, 3]) }, ending: null, accent: 0 },
        // The peak and the fall are made from the rising motif: its head at half speed, then its rhythm stepping down.
        { role: 'peak', voice: 'melody', motif: augment(a), start: { at: high }, ending: null, accent: 8 },
        { role: 'fall', voice: 'melody', motif: reshape(a, contour('stepDown', a.length, rng, octave)), start: { follow: -1 }, ending: close, accent: -2 },
      ];
    }
  }
}

function planBars(ctx: Ctx, form: ResolvedForm): BarPlan[] {
  const { bars, variation } = ctx.settings;
  if (bars === 2) {
    const unit = plan(ctx, form, true);
    return [unit[0], unit[3]];
  }
  if (bars === 4) return plan(ctx, form, true);
  const first = plan(ctx, form, false);
  const last = plan(ctx, form, true)[3];
  const second = first.map((p, i): BarPlan => {
    // A riff comes round exactly as it was, only settling at the very end.
    if (p.fixed) return i === 3 ? { ...p, ending: 'closed' } : p;
    return i === 3
      ? { ...p, motif: p.motif && last.motif ? newTail(p.motif, last.motif) : p.motif, ending: 'closed' }
      : { ...p, motif: p.motif && vary(p.motif, ctx.rng, variation * 0.7) };
  });
  return [...first, ...second];
}

/** Last-note choice: `closed` lands on the chord's triad (root first), `open` avoids home. */
function endingIndex(pool: readonly number[], chord: Chord, tonic: number, near: number, ending: 'open' | 'closed', strong: boolean): number {
  let best = near;
  let bestScore = Infinity;
  pool.forEach((p, i) => {
    const pcs = pc(p);
    let score: number;
    if (ending === 'closed') {
      if (!chord.tones.slice(0, 3).includes(pcs)) return;
      score = Math.abs(i - near) - (pcs === chord.root ? 1.5 : 0) - (pcs === tonic ? 0.5 : 0);
    } else {
      if (pcs === tonic || pcs === chord.root) return;
      const chordTone = chord.tones.includes(pcs);
      if (strong && !chordTone) return;
      score = Math.abs(i - near) - (chordTone ? 0.5 : 0);
    }
    if (score < bestScore) [best, bestScore] = [i, score];
  });
  return best;
}

export interface Realised {
  tick: number;
  len: number;
  pitch: number;
  strong: boolean;
}

/** Places a motif over the harmony, starting at a pool index, keeping the whole phrase in range. */
export function realise(
  ctx: Pick<Ctx, 'pool' | 'octave' | 'progression' | 'settings'>,
  motif: Motif,
  barStart: number,
  startIndex: number,
  ending: Ending,
): { notes: Realised[]; lastIndex: number } {
  const { pool, octave, progression, settings } = ctx;
  const degs = motif.map((n) => n.deg);
  let base = Math.round(startIndex);
  const lo = Math.min(...degs);
  const hi = Math.max(...degs);
  while (base + lo < 0 && base + hi + octave <= pool.length - 1) base += octave;
  while (base + hi > pool.length - 1 && base + lo - octave >= 0) base -= octave;

  const notes: Realised[] = [];
  let index = clamp(base, 0, pool.length - 1);
  motif.forEach((n, i) => {
    const tick = barStart + n.step * STEP;
    const chord = chordAt(progression, tick);
    let idx = clamp(base + n.deg, 0, pool.length - 1);
    const strong = n.step % 8 === 0;
    const dir = Math.sign(n.deg - (motif[i - 1]?.deg ?? n.deg));
    // A repeated note stays repeated (that's the groove), unless it would sit off the chord on beat 1 or 3.
    const repeat = i > 0 && motif[i - 1].deg === n.deg && (!strong || chord.tones.includes(pc(pool[index])));
    if (repeat) idx = index;
    // Other beats land on chord tones, so the same motif over the same chord always comes out the same.
    else if (n.step % 4 === 0) idx = snapToChordTone(pool, chord.tones, idx, dir);
    if (ending && i === motif.length - 1) idx = endingIndex(pool, chord, settings.key, idx, ending, strong);
    index = idx;
    notes.push({ tick, len: n.len, pitch: pool[idx], strong });
  });
  return { notes, lastIndex: index };
}

export function melodyPool(settings: CompositionSettings, track: 'melody' | 'counter' = 'melody'): number[] {
  const { low, high } = REGISTERS[track];
  return pitchesInRange(scalePitchClasses(settings.key, settings.scale), low, high);
}

export function resolveForm(settings: Pick<CompositionSettings, 'phrase' | 'style' | 'trackSeeds'>): ResolvedForm {
  if (settings.phrase !== 'auto') return settings.phrase;
  const table = AUTO_FORMS[settings.style];
  const rng = createRng(deriveSeed(settings.trackSeeds.melody, 'form'));
  return rng.weighted(table.map(([f]) => f), table.map(([, w]) => w));
}

/** How readily each style decorates its line at full creativity: chromatic approaches, octave pops, a pickup into the loop. */
const FLOURISH: Record<StyleId, { approach: number; pop: number; pickup: number }> = {
  ukg: { approach: 0.35, pop: 0.12, pickup: 0.5 },
  house: { approach: 0.2, pop: 0.12, pickup: 0.45 },
  deepHouse: { approach: 0.4, pop: 0.05, pickup: 0.5 },
  melodicHouse: { approach: 0.12, pop: 0.08, pickup: 0.4 },
  rap: { approach: 0.3, pop: 0.05, pickup: 0.35 },
};

const onBeat = (n: NoteEvent) => n.start % (STEP * 4) === 0;

/**
 * The finishing touches, scaled by creativity. Notes over a borrowed or secondary chord move onto
 * its scale; short off-beat notes may slide chromatically into the next beat or pop up an octave;
 * and the last beat may run up or down into the loop's first note. Beats are never touched, so
 * the line still lands on chord tones.
 */
function embellish(notes: NoteEvent[], ctx: Ctx, rng: Rng, pickup: boolean, roleAt: (bar: number) => PhraseRole): NoteEvent[] {
  const { progression, settings, pool } = ctx;
  const c = settings.creativity;
  const { low, high } = REGISTERS.melody;
  const flourish = FLOURISH[settings.style];
  for (const n of notes) n.pitch = fitToChord(n.pitch, chordAt(progression, n.start));
  if (c <= 0) return notes;

  // Decided once per place in the phrase, so a repeated bar is decorated the same way each time.
  const decided = new Map<string, 'below' | 'above' | 'pop' | null>();
  const decide = (n: NoteEvent, approach: boolean) => {
    const key = [roleAt(Math.floor(n.start / TICKS_PER_BAR)), n.start % TICKS_PER_BAR, approach].join(':');
    if (!decided.has(key)) {
      if (approach) decided.set(key, rng.chance(flourish.approach * c) ? (rng.chance(0.7) ? 'below' : 'above') : null);
      else decided.set(key, rng.chance(flourish.pop * c) ? 'pop' : null);
    }
    return decided.get(key);
  };
  notes.forEach((n, i) => {
    const prev = notes[i - 1];
    const next = notes[i + 1];
    if (!prev || !next || onBeat(n) || n.duration > STEP * 2) return;
    if (onBeat(next) && next.start - (n.start + n.duration) <= STEP) {
      const side = decide(n, true);
      const from = next.pitch + (side === 'below' ? -1 : 1);
      if (side && from >= low && from <= high) n.pitch = from;
    } else if (n.pitch + 12 <= high && decide(n, false)) {
      // Up only: the counter-melody sits below the line.
      n.pitch += 12;
    }
  });

  // A pickup into the top of the loop, ending on a tone of the last chord.
  const first = notes[0];
  const last = notes[notes.length - 1];
  const end = totalTicks(settings.bars);
  if (!pickup || !first || first.start !== 0 || last.start + last.duration > end - STEP * 4 || !rng.chance(flourish.pickup * c)) return notes;
  const final = chordAt(progression, end - STEP);
  const at = nearestIndex(pool, first.pitch);
  for (const dir of rng.chance(0.5) ? [1, -1] : [-1, 1]) {
    const path = [3, 2, 1].map((k) => fitToChord(pool[clamp(at - dir * k, 0, pool.length - 1)], final));
    if (!final.tones.slice(0, 3).includes(pc(path[2])) || path[2] === first.pitch) continue;
    path.forEach((pitch, i) =>
      notes.push({
        id: noteId('melody', settings.trackSeeds.melody, notes.length),
        track: 'melody',
        pitch,
        start: end - (3 - i) * STEP,
        duration: STEP,
        velocity: velocity(78 + i * 6),
      }),
    );
    break;
  }
  return notes;
}

/**
 * Pushes downbeat notes a sixteenth-pair early, tying them over the barline. Decided once per
 * phrase role, so every call (or every hook) is pushed the same way.
 */
function anticipate(notes: NoteEvent[], rng: Rng, chance: number, roleAt: (bar: number) => PhraseRole): void {
  const pushed = new Map<PhraseRole, boolean>();
  for (let i = 1; i < notes.length; i++) {
    const n = notes[i];
    if (n.start === 0 || n.start % TICKS_PER_BAR !== 0) continue;
    const prev = notes[i - 1];
    if (prev.start + prev.duration > n.start - STEP * 2) continue;
    const role = roleAt(n.start / TICKS_PER_BAR);
    if (!pushed.has(role)) pushed.set(role, rng.chance(chance));
    if (!pushed.get(role)) continue;
    n.start -= STEP * 2;
    n.duration += STEP * 2;
  }
}

/** `around`: parts already written, whose rhythm the melody leans on. */
export function generateMelody(
  settings: CompositionSettings,
  progression: readonly Chord[],
  around: readonly NoteEvent[] = [],
): { notes: NoteEvent[]; phrasing: Phrasing } {
  const seed = settings.trackSeeds.melody;
  const rng = createRng(seed);
  const style = STYLES[settings.style];
  const pool = melodyPool(settings);
  const octave = SCALES[settings.scale].intervals.length;
  const centre = nearestIndex(pool, rng.int(67, 74));
  const groove = around.length ? onsetProfile(around, settings.bars) : undefined;
  const ctx: Ctx = { rng, style, settings, progression, pool, octave, centre, groove };
  const form = resolveForm(settings);
  const bars = planBars(ctx, form);

  const notes: NoteEvent[] = [];
  let lastIndex = centre;
  // Accents decided once for each sixteenth of the bar, so every repeat is played with the same feel.
  const dynamics = createRng(deriveSeed(seed, 'dynamics'));
  const feel = Array.from({ length: STEPS_PER_BAR }, (_, s) => dynamics.float(-8, 8) + (s % 2 === 1 ? 3 : 0));
  bars.forEach((p, bar) => {
    if (p.voice !== 'melody' || !p.motif) return;
    const start = 'at' in p.start ? p.start.at : lastIndex + p.start.follow;
    const { notes: placed, lastIndex: end } = realise(ctx, tidy(p.motif), bar * TICKS_PER_BAR, start, p.ending);
    lastIndex = end;
    for (const n of placed) {
      const accent = (n.strong ? 100 : n.tick % (STEP * 4) === 0 ? 92 : 84) + p.accent;
      notes.push({
        id: noteId('melody', seed, notes.length),
        track: 'melody',
        pitch: n.pitch,
        start: n.tick,
        duration: n.len * STEP,
        velocity: velocity(accent + feel[(n.tick % TICKS_PER_BAR) / STEP] + rng.float(-2, 2)),
      });
    }
  });
  const roleAt = (bar: number) => bars[Math.min(bars.length - 1, bar)].role;
  anticipate(notes, rng, ANTICIPATION[settings.style], roleAt);
  // Its own stream, so the line underneath is the same whatever the creativity.
  // In a trade the counter-melody has the last bar, so the melody leaves the pickup to it.
  embellish(notes, ctx, createRng(deriveSeed(seed, 'flair')), bars[bars.length - 1].voice === 'melody', roleAt);

  const phrasing: Phrasing = {
    form,
    sections: bars.map((p, bar) => ({ start: bar * TICKS_PER_BAR, duration: TICKS_PER_BAR, role: p.role, voice: p.voice })),
  };
  return { notes, phrasing };
}

/** Turns played notes back into a motif, measured in steps of `pool`. */
function motifFromNotes(notes: readonly NoteEvent[], barStart: number, pool: readonly number[]): Motif {
  const first = nearestIndex(pool, notes[0].pitch);
  return tidy(
    notes.map((n) => {
      const step = Math.round((n.start - barStart) / STEP);
      return { step, len: Math.min(Math.round(n.duration / STEP), STEPS_PER_BAR - step), deg: nearestIndex(pool, n.pitch) - first };
    }),
  );
}

/**
 * For the `trade` form: the counter-melody answers each melody call, using a
 * development of what the melody just played, an octave or so lower.
 */
export function tradeResponses(
  settings: CompositionSettings,
  progression: readonly Chord[],
  melody: readonly NoteEvent[],
  phrasing: Phrasing,
  rng: Rng,
): { pitch: number; start: number; duration: number; accent: number }[] {
  const style = STYLES[settings.style];
  const pool = melodyPool(settings, 'counter');
  const melodyNotes = melodyPool(settings);
  const octave = SCALES[settings.scale].intervals.length;
  const ctx: Ctx = { rng, style, settings, progression, pool, octave, centre: Math.floor(pool.length / 2) };
  const out: { pitch: number; start: number; duration: number; accent: number }[] = [];
  const lastSection = phrasing.sections.length - 1;
  // One answer, worked out from the first call and given again to every call after it (the last
  // with a new ending), so the two parts hold a conversation rather than trading random ideas.
  let answer: Motif | null = null;

  phrasing.sections.forEach((section, i) => {
    if (section.voice !== 'counter') return;
    const call = phrasing.sections[i - 1];
    const callNotes = call ? melody.filter((n) => n.start >= call.start && n.start < call.start + call.duration) : [];
    answer ??= callNotes.length ? respond(ctx, motifFromNotes(callNotes, call.start, melodyNotes)) : fresh(ctx);
    const motif = i === lastSection ? vary(answer, rng, Math.max(0.3, settings.variation)) : answer;
    const startIndex = callNotes.length ? nearestIndex(pool, callNotes[callNotes.length - 1].pitch - 12) : ctx.centre;
    const { notes } = realise(ctx, motif, section.start, startIndex, i === lastSection ? 'closed' : 'open');
    for (const n of notes) {
      let duration = n.len * STEP;
      // Give way to the melody if its next call is pushed early into this bar.
      const clash = melody.find((m) => m.start > n.tick && m.start < n.tick + duration);
      if (clash) duration = clash.start - n.tick;
      const inside = melody.some((m) => m.start <= n.tick && n.tick < m.start + m.duration);
      if (duration < STEP || inside) continue;
      out.push({ pitch: n.pitch, start: n.tick, duration, accent: n.strong ? 90 : 82 });
    }
  });
  return out;
}
