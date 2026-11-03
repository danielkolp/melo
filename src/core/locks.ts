import { MONO_TRACKS, clearEdited, keepBars, markEdited } from './edit';
import { generateComposition, generateProgression, refreshAutomation } from './generator';
import { composeAround, composeParts, fitToBars, heldFor, heldTracks, moveChords, moveNotes, renameNote } from './importing';
import { deriveSeed } from './random';
import { chordAt, pc } from './shared';
import { developPart } from './variations';
import {
  STEP,
  TICKS_PER_BAR,
  TRACK_IDS,
  type Chord,
  type Composition,
  type CompositionSettings,
  type Locks,
  type NoteEvent,
  type TrackId,
} from './types';

/**
 * Producer controls: what Generate leaves alone, and the small rewrites that change one thing at
 * a time. Locked parts and bars survive every rewrite of the loop; hand-edited parts survive
 * another part being rewritten and move with a key change.
 */

const NO_LOCKS: Locks = { tracks: [], bars: [] };
export const locksOf = (composition: Composition): Locks => composition.locks ?? NO_LOCKS;

/** Puts the hand-edit marks back on a rewritten loop, to be cleared where parts were written again. */
const withEdited = (composition: Composition, edited: readonly TrackId[] | undefined): Composition =>
  edited?.length ? { ...composition, edited: [...edited] } : composition;

/** Sets the locks, leaving the field off when nothing is locked. */
function withLocks(composition: Composition, locks: Locks): Composition {
  const { locks: _, ...rest } = composition;
  return locks.tracks.length || locks.bars.length ? { ...rest, locks } : rest;
}

export function toggleLock(composition: Composition, track: TrackId): Composition {
  const { tracks, bars } = locksOf(composition);
  const next = tracks.includes(track) ? tracks.filter((t) => t !== track) : TRACK_IDS.filter((t) => t === track || tracks.includes(t));
  return withLocks(composition, { tracks: next, bars });
}

export function toggleBarLock(composition: Composition, bar: number): Composition {
  if (bar < 0 || bar >= composition.settings.bars) return composition;
  const { tracks, bars } = locksOf(composition);
  const next = bars.includes(bar) ? bars.filter((b) => b !== bar) : [...bars, bar].sort((a, b) => a - b);
  return withLocks(composition, { tracks, bars: next });
}

/** The composition's notes, harmony and phrasing carried to new settings: moved to the new key, fitted to the new length. */
function carry(composition: Composition, next: CompositionSettings) {
  const { settings, phrasing } = composition;
  return {
    notes: fitToBars(moveNotes(composition.notes, settings, next), settings.bars, next.bars, renameNote),
    progression: fitToBars(moveChords(composition.progression, settings, next), settings.bars, next.bars),
    phrasing: { ...phrasing, sections: fitToBars(phrasing.sections, settings.bars, next.bars) },
  };
}

/**
 * The loop written again for new settings, keeping what the producer kept: uploaded parts, locked
 * parts and bars, and, with `keepEdited` (only the key moved), hand-edited parts. Kept parts move
 * to the new key and fit the new length, and while anything is kept the harmony stays with them.
 */
export function recompose(composition: Composition, settings: CompositionSettings, options: { keepEdited?: boolean } = {}): Composition {
  const { source, automation, arrangement } = composition;
  const locks = locksOf(composition);
  const fitted = { tracks: locks.tracks, bars: locks.bars.filter((b) => b < settings.bars) };
  const uploaded = heldTracks(source);
  const kept = new Set([...locks.tracks, ...(options.keepEdited ? (composition.edited ?? []) : [])].filter((t) => !uploaded.has(t)));
  // Marks stay on the parts that were kept.
  const rewritten = TRACK_IDS.filter((t) => !kept.has(t) && !uploaded.has(t));

  let next: Composition;
  if (!kept.size && !fitted.bars.length) {
    next = source ? composeAround(settings, source, heldFor(composition, settings), automation, arrangement) : generateComposition(settings, automation, arrangement);
  } else {
    const carried = carry(composition, settings);
    const held = source ? heldFor(composition, settings) : { progression: carried.progression, notes: [] };
    const fixed = {
      progression: held.progression,
      tracks: new Set([...uploaded, ...kept]),
      notes: [...held.notes, ...carried.notes.filter((n) => kept.has(n.track))],
      phrasing: kept.has('melody') ? carried.phrasing : undefined,
    };
    const written = composeParts(settings, fixed, automation, arrangement, source);
    next = refreshAutomation({ ...written, notes: keepBars(written.notes, carried.notes, fitted.bars) });
  }
  return clearEdited(withLocks(withEdited(next, composition.edited), fitted), rewritten);
}

// ---------------------------------------------------------------------------
// One bar at a time

/** Moves that keep a bar recognisable while changing it, by kind of part. */
const BAR_MOVES = {
  line: ['newNotes', 'newRhythm', 'invert', 'reverse', 'passing', 'octaves', 'syncopate'],
  /** The brass stacks its stabs, so it moves like the chords, plus the line moves that keep stacks whole. */
  brass: ['invertUp', 'invertDown', 'spread', 'octaves', 'syncopate'],
  bass: ['approach', 'walk', 'busier', 'octaves', 'anticipate', 'bassGroove', 'syncopate'],
  chords: ['addColour', 'invertUp', 'invertDown', 'spread', 'restab', 'offbeat', 'broken'],
};

const shapeOf = (notes: readonly NoteEvent[]) =>
  notes
    .map((n) => `${n.start}:${n.pitch}:${n.duration}`)
    .sort()
    .join();

/** Whether a part can be rewritten: it has notes, and it isn't uploaded or locked. */
export function canRewrite(composition: Composition, track: TrackId): boolean {
  return !heldTracks(composition.source).has(track) && !locksOf(composition).tracks.includes(track) && composition.notes.some((n) => n.track === track);
}

/**
 * One bar of one part written again as a related alternative: the part put through one of the
 * variation moves and only that bar taken. Each seed starts from a different move, so pressing
 * again gives another take. The part counts as edited afterwards. Locked bars and parts, and
 * uploads, are left alone.
 */
export function rewriteBar(composition: Composition, track: TrackId, bar: number, seed: number): Composition {
  const { settings, progression } = composition;
  if (!canRewrite(composition, track) || bar < 0 || bar >= settings.bars || locksOf(composition).bars.includes(bar)) return composition;
  const part = composition.notes.filter((n) => n.track === track);
  const from = bar * TICKS_PER_BAR;
  const to = from + TICKS_PER_BAR;
  const inBar = (n: NoteEvent) => n.start >= from && n.start < to;
  const was = shapeOf(part.filter(inBar));
  const moves = BAR_MOVES[track === 'chords' || track === 'bass' || track === 'brass' ? track : 'line'];
  const mono = MONO_TRACKS.has(track);

  for (let k = 0; k < moves.length * 2; k++) {
    const move = moves[(seed + k) % moves.length];
    const moved = developPart(part, settings, progression, [move], deriveSeed(seed, `${track}/${bar}/${k}`), 0.7);
    const fresh = moved?.filter(inBar).map((n) => (n.start + n.duration > to ? { ...n, duration: to - n.start } : n));
    if (!fresh?.length || shapeOf(fresh) === was) continue;
    const kept = part.filter((n) => !inBar(n)).map((n) => (mono && n.start < from && n.start + n.duration > from ? { ...n, duration: from - n.start } : n));
    const others = composition.notes.filter((n) => n.track !== track);
    const notes = [...others, ...kept, ...fresh].sort((a, b) => a.start - b.start || TRACK_IDS.indexOf(a.track) - TRACK_IDS.indexOf(b.track) || a.pitch - b.pitch);
    return refreshAutomation(markEdited({ ...composition, notes }, track));
  }
  return composition;
}

// ---------------------------------------------------------------------------
// New harmony

/** How well a melody sits on a progression: long and strong notes on chord tones, nothing outside a borrowed chord's scale. */
export function harmonyFit(melody: readonly NoteEvent[], progression: readonly Chord[]): number {
  let fit = 0;
  let total = 0;
  for (const n of melody) {
    const weight = n.duration * (n.start % (STEP * 8) === 0 ? 2 : 1);
    const chord = chordAt(progression, n.start);
    total += weight;
    if (chord.tones.includes(pc(n.pitch))) fit += weight;
    else if (chord.scale && !chord.scale.includes(pc(n.pitch))) fit -= weight;
  }
  return total ? fit / total : 0;
}

const sameChord = (a: Chord, b: Chord) => a.root === b.root && a.tones.join() === b.tones.join();

/** `next`, with the chords under locked bars taken from `old`. */
function spliceChords(next: readonly Chord[], old: readonly Chord[], bars: number, locked: readonly number[]): Chord[] {
  if (!locked.length) return [...next];
  const out: Chord[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const from = bar * TICKS_PER_BAR;
    const to = from + TICKS_PER_BAR;
    for (const c of locked.includes(bar) ? old : next) {
      const start = Math.max(c.start, from);
      const end = Math.min(c.start + c.duration, to);
      if (end <= start) continue;
      const prev = out[out.length - 1];
      if (prev && prev.start + prev.duration === start && sameChord(prev, c)) prev.duration += end - start;
      else out.push({ ...c, start, duration: end - start });
    }
  }
  return out;
}

/** Whether New chords can run: not while the chords or bass are uploaded or locked. */
export function canChangeChords(composition: Composition): boolean {
  const fixed = new Set([...heldTracks(composition.source), ...locksOf(composition).tracks]);
  return !fixed.has('chords') && !fixed.has('bass');
}

/**
 * A new progression for the loop. Chords, bass, counter and brass are written again over it, and
 * the melody is placed over the new chords from its own plan. A kept melody (uploaded, locked or
 * edited) stays, and the progression that suits it best out of six is chosen. Locked parts and
 * bars keep their notes, and locked bars their chords.
 */
export function newChords(composition: Composition, seed: number): Composition {
  if (!canChangeChords(composition)) return composition;
  const locks = locksOf(composition);
  const uploaded = heldTracks(composition.source);
  const kept = new Set<TrackId>([...uploaded, ...locks.tracks]);
  if (composition.edited?.includes('melody')) kept.add('melody');
  const melody = composition.notes.filter((n) => n.track === 'melody');
  let best: { settings: CompositionSettings; progression: Chord[]; fit: number } | null = null;
  for (let i = 0; i < (kept.has('melody') ? 6 : 1); i++) {
    const settings = { ...composition.settings, harmonySeed: deriveSeed(seed, `chords/${i}`) };
    const progression = spliceChords(generateProgression(settings), composition.progression, settings.bars, locks.bars);
    const fit = kept.has('melody') ? harmonyFit(melody, progression) : 0;
    if (!best || fit > best.fit) best = { settings, progression, fit };
  }
  const { settings, progression } = best!;
  const fixed = {
    progression,
    tracks: kept,
    notes: composition.notes.filter((n) => kept.has(n.track)),
    phrasing: kept.has('melody') && !uploaded.has('melody') ? composition.phrasing : undefined,
  };
  const written = composeParts(settings, fixed, composition.automation, composition.arrangement, composition.source);
  const next = refreshAutomation({ ...written, notes: keepBars(written.notes, composition.notes, locks.bars) });
  return clearEdited(withLocks(withEdited(next, composition.edited), locks), TRACK_IDS.filter((t) => !kept.has(t)));
}
