import { hornVoicing } from './brass';
import { melodyPool } from './melody';
import { createRng, deriveSeed } from './random';
import { REGISTERS, chordAt, clamp, fitToChord, nearestIndex, noteId, pc, velocity } from './shared';
import { harmonyPitchClasses, pitchesInRange } from './theory';
import {
  STEP,
  TICKS_PER_BAR,
  totalTicks,
  type Chord,
  type CompositionSettings,
  type NoteEvent,
  type StyleId,
  type TrackId,
  type TransitionChoice,
  type TransitionKind,
} from './types';

/**
 * The end of an 8-bar loop, where the music hands over to what comes next: the loop's top, or the
 * next section of the song. One transition is chosen for the loop, and the guide beat and every
 * part play their share of it, so the bar sounds like one move rather than four parts doing their
 * own thing. The part carrying the last phrase (the lead) keeps its line.
 */

export const TRANSITIONS: Record<TransitionChoice, { label: string; description: string }> = {
  auto: { label: 'Auto', description: 'Picks a transition that suits the style.' },
  roll: {
    label: 'Roll',
    description: 'A clap roll over the last two beats, speeding up and getting louder. The chords stab along with it and the bass walks up into bar 1.',
  },
  stop: {
    label: 'Stop',
    description: 'The band hits once together and cuts out, leaving the lead on its own until bar 1 slams back in.',
  },
  lift: {
    label: 'Lift',
    description: 'The kick drops out for the last bar. The bass and chords hold long notes and the hats double up into bar 1.',
  },
  none: { label: 'None', description: 'Bar 8 plays like the rest of the loop.' },
};

export const TRANSITION_IDS = Object.keys(TRANSITIONS) as TransitionChoice[];

export interface Transition {
  kind: TransitionKind;
  /** The sixteenth of the last bar where the transition takes over. */
  from: number;
}

const AUTO: Record<StyleId, [TransitionKind, number][]> = {
  ukg: [['stop', 2.5], ['roll', 1.5], ['lift', 1]],
  house: [['lift', 2.5], ['roll', 2], ['stop', 1]],
  deepHouse: [['lift', 2], ['roll', 1], ['stop', 1]],
  melodicHouse: [['roll', 2.5], ['lift', 2], ['stop', 0.5]],
  // A beat stop before the next bar is the rap and grime staple.
  rap: [['stop', 3], ['roll', 1.5], ['lift', 0.5]],
};

/** The transition at the end of the loop: only 8-bar loops have one. */
export function resolveTransition(
  settings: Pick<CompositionSettings, 'bars' | 'seed' | 'style' | 'creativity' | 'transition'>,
): Transition | null {
  const choice = settings.transition ?? 'auto';
  if (settings.bars !== 8 || choice === 'none') return null;
  const rng = createRng(deriveSeed(settings.seed, 'transition'));
  const table = AUTO[settings.style];
  const kind = choice === 'auto' ? rng.weighted(table.map(([k]) => k), table.map(([, w]) => w)) : choice;
  // A stop takes the last beat or, more boldly, the last two.
  const from = kind === 'roll' ? 8 : kind === 'lift' ? 0 : rng.chance(0.25 + settings.creativity * 0.4) ? 8 : 12;
  return { kind, from };
}

export interface TransitionContext {
  settings: CompositionSettings;
  progression: readonly Chord[];
  /** The part that carries the last bar's phrase; it keeps its line. */
  lead: TrackId;
  /** The melody, which the brass's hit stays under. */
  under?: readonly NoteEvent[];
}

/** Ends every note at `at`: later ones go, ones still sounding are cut short. */
function cut(notes: readonly NoteEvent[], at: number): NoteEvent[] {
  return notes.filter((n) => n.start < at).map((n) => (n.start + n.duration > at ? { ...n, duration: at - n.start } : n));
}

/** A chord's hits in the chord part: those that start inside it, and those pushed ahead of it that ring into it. */
function hitsOf(notes: readonly NoteEvent[], progression: readonly Chord[], chord: Chord): NoteEvent[] {
  return notes.filter(
    (n) =>
      chordAt(progression, n.start) === chord ||
      (n.start < chord.start && n.start + n.duration > chord.start && chordAt(progression, n.start + STEP * 2) === chord),
  );
}

/** The chord part's voicing for a chord: the pitches of its first hit. */
function voicingOf(notes: readonly NoteEvent[], progression: readonly Chord[], chord: Chord): number[] {
  const own = hitsOf(notes, progression, chord);
  if (!own.length) return [];
  const first = Math.min(...own.map((n) => n.start));
  return own.filter((n) => n.start === first).map((n) => n.pitch);
}

/** A chord's root in the bass register, nearest `near`. */
function bassRoot(chord: Chord, near: number): number {
  const { low, high } = REGISTERS.bass;
  const options = [36, 48].map((o) => o + chord.root).filter((p) => p >= low && p <= high);
  return options.reduce((a, p) => (Math.abs(p - near) < Math.abs(a - near) ? p : a));
}

/** A run of three sixteenths into the loop's first note, ending on a tone of the last chord; null if none fits. */
function pickup(pool: readonly number[], target: number, chord: Chord, flip: boolean): number[] | null {
  const at = nearestIndex(pool, target);
  for (const dir of flip ? [-1, 1] : [1, -1]) {
    const range = { low: pool[0], high: pool[pool.length - 1] };
    const path = [3, 2, 1].map((k) => fitToChord(pool[clamp(at - dir * k, 0, pool.length - 1)], chord, range));
    if (chord.tones.slice(0, 3).includes(pc(path[2])) && path[2] !== target && new Set(path).size === 3) return path;
  }
  return null;
}

/** One part's share of the transition, in the last bar of the loop. */
export function transitionPart(track: TrackId, notes: readonly NoteEvent[], t: Transition, ctx: TransitionContext): NoteEvent[] {
  const { settings, progression, lead } = ctx;
  const end = totalTicks(settings.bars);
  const bar = end - TICKS_PER_BAR;
  const from = bar + t.from * STEP;
  const seed = settings.trackSeeds[track];
  let added = 0;
  const note = (pitch: number, start: number, length: number, accent: number): NoteEvent => ({
    id: noteId(track, seed, 1000 + added++),
    track,
    pitch,
    start,
    duration: length,
    velocity: velocity(accent),
  });
  const melodic = track === 'melody' || track === 'counter';
  const before = (at: number) => notes.filter((n) => n.start < at).at(-1)?.pitch;

  // The lead keeps its line; in a stop it gets the gap to itself, and runs into bar 1 if it would otherwise rest.
  if (melodic && track === lead) {
    if (t.kind !== 'stop' || notes.some((n) => n.start >= end - STEP * 4) || !notes.length) return [...notes];
    const first = notes.reduce((a, n) => (n.start < a.start ? n : a));
    const path = pickup(melodyPool(settings, track), first.pitch, chordAt(progression, end - STEP), settings.seed % 2 === 0);
    if (!path) return [...notes];
    const run = path.map((pitch, i) => note(pitch, end - (3 - i) * STEP, STEP, 82 + i * 8));
    return [...cut(notes, end - STEP * 3), ...run];
  }
  // A part that isn't leading makes room.
  if (melodic) return cut(notes, t.kind === 'lift' ? bar + STEP * 8 : from);

  if (track === 'brass') {
    const out = cut(notes, t.kind === 'lift' ? bar + STEP * 8 : from);
    if (t.kind !== 'stop' || !notes.length) return out;
    // The horns hit with the band, under the lead.
    const near = notes.filter((n) => n.start < from).at(-1)?.pitch ?? notes[0].pitch;
    const sounding = (ctx.under ?? []).filter((n) => n.start < from + STEP * 2 && n.start + n.duration > from).map((n) => n.pitch);
    const ceiling = Math.min(REGISTERS.brass.high, ...sounding.map((p) => p - 2));
    for (const pitch of hornVoicing(chordAt(progression, from), near, 3, ceiling)) out.push(note(pitch, from, STEP * 2, 108));
    return out;
  }

  const chord = chordAt(progression, from);
  if (track === 'chords') {
    if (t.kind === 'lift') {
      // Each chord of the bar held for its whole length, in place of its stabs.
      const held = progression.filter((c) => c.start >= bar);
      const replaced = new Set(held.flatMap((c) => hitsOf(notes, progression, c)));
      const out = notes.filter((n) => !replaced.has(n));
      for (const c of held) {
        const own = hitsOf(notes, progression, c);
        if (!own.length) continue;
        // From the downbeat, or from earlier if the change was pushed ahead of it.
        const start = Math.min(c.start, ...own.map((n) => n.start));
        for (const pitch of voicingOf(notes, progression, c)) out.push(note(pitch, start, c.start + c.duration - start, 80));
      }
      return out;
    }
    const voicing = voicingOf(notes, progression, chord);
    const out = cut(notes, from);
    // A roll gets eighth-note stabs that build with it; a stop gets one hit.
    const stabs = t.kind === 'roll' ? [0, 2, 4, 6].map((s) => from + s * STEP) : [from];
    stabs.forEach((start, i) => {
      for (const pitch of voicing) out.push(note(pitch, start, t.kind === 'roll' ? STEP : STEP * 2, t.kind === 'roll' ? 74 + i * 9 : 104));
    });
    return out;
  }

  // Bass.
  const { low, high } = REGISTERS.bass;
  const last = before(from) ?? before(end) ?? 43;
  if (t.kind === 'lift') {
    // One long root for each chord of the bar, with a breath before bar 1.
    const held = progression.filter((c) => c.start >= bar);
    const out = notes.filter((n) => n.start < bar);
    let near = last;
    for (const c of held) {
      near = bassRoot(c, near);
      const length = c.duration - (c.start + c.duration === end ? STEP * 2 : 0);
      out.push(note(near, c.start, length, 100));
    }
    return out;
  }
  const out = cut(notes, from);
  const root = bassRoot(chord, last);
  if (t.kind === 'stop') return [...out, note(root, from, STEP * 2, 110)];
  // A roll: the root on the roll's first stroke, then three scale steps into bar 1's first note.
  const pool = pitchesInRange(harmonyPitchClasses(settings.key, settings.scale), low, high);
  const target = notes.reduce((a, n) => (n.start < a.start ? n : a), notes[0])?.pitch ?? root;
  const to = nearestIndex(pool, target);
  const dir = target >= root ? 1 : -1;
  const walk = [3, 2, 1].map((k) => pool[clamp(to - dir * k, 0, pool.length - 1)]);
  return [...out, note(root, from, STEP * 2, 104), ...walk.map((pitch, i) => note(pitch, from + (i + 1) * 2 * STEP, STEP * 2, 92 + i * 6))];
}
