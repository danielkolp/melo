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
  type MotifNote,
} from './motif';
import { makePlan, type BarPlan as Planned } from './plan';
import { pickTake, scoreMelody } from './score';
import { createRng, deriveSeed, type Rng } from './random';
import { REGISTERS, chordAt, clamp, fitToChord, nearestIndex, noteId, pc, snapToChordTone, velocity } from './shared';
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

/** Hook shapes, weighted: the anchored vocal-chop figure leads. */
const HOOK_CONTOURS: [ContourKind, number][] = [['anchor', 2], ['pedal', 1], ['repeat', 1], ['octave', 1], ['turn', 1]];

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
}

/**
 * A new motif. It depends only on the style, the density and the melody's own seed, not on the
 * notes of the other parts, so the idea survives new chords or a new bassline.
 */
const fresh = (ctx: Ctx, density = ctx.settings.density, contour?: ContourKind, avoid?: ReadonlySet<number>) =>
  makeMotif(ctx.rng, ctx.style, density, ctx.octave, { contour, avoid, creativity: ctx.settings.creativity });

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
    // Mostly made from the call; a new idea only now and then.
    [() => fresh(ctx, ctx.settings.density * 0.85, undefined, callSteps), 0.5],
    [() => newTail(call, fresh(ctx), rng.pick([-1, 1])), 2.5],
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
        // The call comes back a step or two higher: the phrase's push before it settles.
        { role: 'call', voice: 'melody', motif: vary(call, rng, v * 0.8), start: { at: centre + rng.pick([1, 2]) }, ending: 'open', accent: 2 },
        { role: 'response', voice, motif: r2, start: { follow: away(call) }, ending: close, accent: -4 },
      ];
    }
    case 'hook': {
      const kinds = [...HOOK_CONTOURS, ['riff', RIFF[settings.style]] as [ContourKind, number]];
      const contour = rng.weighted(kinds.map(([k]) => k), kinds.map(([, w]) => w));
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
        // The third time round it may lift a step or two, so the hook builds before the turnaround.
        { role: 'hook', voice: 'melody', motif: vary(a, rng, v * 0.6), start: { at: centre + (rng.chance(0.6) ? rng.pick([1, 2]) : 0) }, ending: null, accent: 0 },
        { role: 'hook', voice: 'melody', motif: end, start: { at: centre }, ending: final ? 'closed' : null, accent: -2 },
      ];
    }
    case 'questionAnswer': {
      const a = fresh(ctx);
      // The second half of the question starts like the first and turns somewhere new.
      const b = newTail(a, fresh(ctx, settings.density * 0.8), rng.pick([-1, 1]));
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

  // The whole figure slides along the scale to where it sits best on the bar's harmony, so it keeps
  // its intervals (its identity) instead of being bent note by note onto each chord.
  const tickOf = (n: MotifNote) => barStart + n.step * STEP;
  const isTone = (idx: number, tick: number) => chordAt(progression, tick).tones.includes(pc(pool[clamp(idx, 0, pool.length - 1)]));
  const weight = (n: MotifNote) => (n.step % 8 === 0 ? 2 : n.step % 4 === 0 ? 1 : 0.3) * Math.min(2, n.len / 2 + 0.5);
  let shift = 0;
  let bestCost = Infinity;
  for (const s of [0, -1, 1, -2, 2]) {
    if (base + lo + s < 0 || base + hi + s > pool.length - 1) continue;
    const cost = motif.reduce((a, n) => a + (isTone(base + s + n.deg, tickOf(n)) ? 0 : weight(n)), 0) + Math.abs(s) * 0.75;
    if (cost < bestCost) [shift, bestCost] = [s, cost];
  }
  base += shift;

  const idx = motif.map((n) => clamp(base + n.deg, 0, pool.length - 1));
  // A repeated note stays repeated: that's the groove.
  motif.forEach((n, i) => {
    if (i > 0 && motif[i - 1].deg === n.deg) idx[i] = idx[i - 1];
  });
  motif.forEach((n, i) => {
    const tick = tickOf(n);
    const chord = chordAt(progression, tick);
    if (ending && i === motif.length - 1) {
      idx[i] = endingIndex(pool, chord, settings.key, idx[i], ending, n.step % 8 === 0);
      return;
    }
    // A note on beat 1 or 3, or a long one, is a chord tone, or a suspension the next note
    // resolves by step onto one. Short notes in between may pass or turn freely.
    const structural = n.step % 8 === 0 || n.len >= 4;
    if (!structural || isTone(idx[i], tick)) return;
    const next = motif[i + 1];
    const resolves =
      !!next &&
      next.step <= n.step + n.len + 1 &&
      Math.abs(pool[idx[i + 1]] - pool[idx[i]]) <= 2 &&
      isTone(idx[i + 1], tickOf(next)) &&
      !(ending && i + 1 === motif.length - 1);
    if (resolves) return;
    const dir = Math.sign(n.deg - (motif[i - 1]?.deg ?? n.deg));
    const was = idx[i];
    idx[i] = snapToChordTone(pool, chord.tones, idx[i], dir);
    // Repeats of it move with it.
    for (let k = i + 1; k < motif.length && motif[k].deg === n.deg && idx[k] === was; k++) idx[k] = idx[i];
  });
  const notes: Realised[] = motif.map((n, i) => ({ tick: tickOf(n), len: n.len, pitch: pool[idx[i]], strong: n.step % 8 === 0 }));
  return { notes, lastIndex: idx[idx.length - 1] ?? clamp(base, 0, pool.length - 1) };
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
  for (const n of notes) n.pitch = fitToChord(n.pitch, chordAt(progression, n.start), REGISTERS.melody);
  if (c <= 0) return notes;

  // Decided once per place in the phrase, so a repeated bar is decorated the same way each time.
  const decided = new Map<string, 'below' | 'above' | 'pop' | 'enclose' | null>();
  const decide = (n: NoteEvent, kind: 'approach' | 'pop' | 'enclose') => {
    const key = [roleAt(Math.floor(n.start / TICKS_PER_BAR)), n.start % TICKS_PER_BAR, kind].join(':');
    if (!decided.has(key)) {
      if (kind === 'approach') decided.set(key, rng.chance(flourish.approach * c) ? (rng.chance(0.7) ? 'below' : 'above') : null);
      else if (kind === 'pop') decided.set(key, rng.chance(flourish.pop * c) ? 'pop' : null);
      else decided.set(key, rng.chance(0.4) ? 'enclose' : null);
    }
    return decided.get(key);
  };
  const suspended = (n: NoteEvent | undefined) => !!n && n.start % (STEP * 8) === 0 && !chordAt(progression, n.start).tones.includes(pc(n.pitch));
  const short = (n: NoteEvent) => !onBeat(n) && n.duration <= STEP * 2;
  const leadsInto = (a: NoteEvent, b: NoteEvent) => b.start - (a.start + a.duration) <= STEP;
  notes.forEach((n, i) => {
    const prev = notes[i - 1];
    const next = notes[i + 1];
    // A note resolving a suspension is where it has to be.
    if (!prev || !next || !short(n) || suspended(prev)) return;
    if (onBeat(next) && next.duration >= STEP * 2 && leadsInto(n, next)) {
      // Grace notes only lead into a long note on the beat: a semitone below or above it.
      const side = decide(n, 'approach');
      const from = next.pitch + (side === 'below' ? -1 : 1);
      if (!side || from < low || from > high) return;
      n.pitch = from;
      // Sometimes the note before closes in from the other side, a scale step away: an enclosure.
      if (short(prev) && leadsInto(prev, n) && !suspended(notes[i - 2]) && decide(prev, 'enclose')) {
        const other = pool[clamp(nearestIndex(pool, next.pitch) + (side === 'below' ? 1 : -1), 0, pool.length - 1)];
        if (other !== next.pitch && other >= low && other <= high) prev.pitch = other;
      }
    } else if (n.start % (STEP * 2) !== 0 && n.pitch + 12 <= high && decide(n, 'pop')) {
      // Octave pops on the weak sixteenths only, and up only: the counter-melody sits below the line.
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
    const path = [3, 2, 1].map((k) => fitToChord(pool[clamp(at - dir * k, 0, pool.length - 1)], final, REGISTERS.melody));
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

/**
 * Where the shared plan leaves space, the bar plays only its idea's head and holds its last note,
 * and the counter-melody takes the back half. A riff keeps its shape and breathes only at the
 * cadence; a trade, a sequence and an arc carry their own shape.
 */
function leaveSpace(bars: BarPlan[], planned: readonly Planned[], form: ResolvedForm, maxLen: number): BarPlan[] {
  if (form === 'trade' || form === 'sequence' || form === 'arc') return bars;
  const headOf = (motif: Motif | null | undefined) => JSON.stringify(motif?.filter((n) => n.step < 8).map((n) => [n.step, n.deg]));
  return bars.map((p, bar) => {
    if (!p.motif || planned[bar]?.melody !== 'sparse' || (p.fixed && planned[bar].role !== 'cadence')) return p;
    const head = p.motif.filter((n) => n.step < 8);
    if (head.length < 2 || head.length === p.motif.length) return p;
    const last = head[head.length - 1];
    const held = { ...last, len: Math.max(last.len, Math.min(maxLen + 2, 10 - last.step)) };
    // A response that differs from its call only in the tail lands its held note where the full
    // answer would have ended, so the answer isn't lost. If that's the same note, it plays in full.
    if (p.role === 'response' && headOf(p.motif) === headOf(bars[bar - 1]?.motif)) {
      const landing = p.motif[p.motif.length - 1].deg;
      return landing === last.deg ? p : { ...p, motif: tidy([...head.slice(0, -1), { ...held, deg: landing }]) };
    }
    return { ...p, motif: tidy([...head.slice(0, -1), held]) };
  });
}

/** One take of the melody, from the melody seed alone. */
function writeMelody(settings: CompositionSettings, progression: readonly Chord[]): { notes: NoteEvent[]; phrasing: Phrasing } {
  const seed = settings.trackSeeds.melody;
  const rng = createRng(seed);
  const style = STYLES[settings.style];
  const pool = melodyPool(settings);
  const octave = SCALES[settings.scale].intervals.length;
  const centre = nearestIndex(pool, rng.int(67, 74));
  const ctx: Ctx = { rng, style, settings, progression, pool, octave, centre };
  const form = resolveForm(settings);
  const bars = leaveSpace(planBars(ctx, form), makePlan(settings).bars, form, style.melodyMaxLen);

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

/** Melody takes written for each loop; the one that scores best is kept. */
export const MELODY_TAKES = 6;

export interface MelodyTake {
  notes: NoteEvent[];
  phrasing: Phrasing;
  score: number;
}

/** The takes a melody is chosen from: the seed's own, then ones from seeds derived from it, all in the seed's phrase form. */
export function melodyTakes(settings: CompositionSettings, progression: readonly Chord[]): MelodyTake[] {
  const phrase = resolveForm(settings);
  return Array.from({ length: MELODY_TAKES }, (_, i) => {
    const melody = i ? deriveSeed(settings.trackSeeds.melody, `take${i}`) : settings.trackSeeds.melody;
    const take = writeMelody({ ...settings, phrase, trackSeeds: { ...settings.trackSeeds, melody } }, progression);
    return { ...take, score: scoreMelody(take.notes, progression, settings) };
  });
}

/** The melody for a loop: the best-scoring of its takes. Same seed and harmony, same melody. */
export function generateMelody(settings: CompositionSettings, progression: readonly Chord[]): { notes: NoteEvent[]; phrasing: Phrasing } {
  const best = pickTake(melodyTakes(settings, progression));
  return { notes: best.notes, phrasing: best.phrasing };
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
