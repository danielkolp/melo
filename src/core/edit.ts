import { STEP, TICKS_PER_BAR, TRACK_IDS, totalTicks, type Composition, type NoteEvent, type TrackId } from './types';

export const MIN_PITCH = 21;
export const MAX_PITCH = 108;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Forces a note into the pattern: on the grid, inside the loop, valid MIDI values. */
export function clampNote(note: NoteEvent, bars: number): NoteEvent {
  const end = totalTicks(bars);
  const duration = clamp(Math.round(note.duration / STEP) * STEP, STEP, end);
  const start = clamp(Math.round(note.start / STEP) * STEP, 0, end - duration);
  return {
    ...note,
    pitch: clamp(Math.round(note.pitch), MIN_PITCH, MAX_PITCH),
    start,
    duration,
    velocity: clamp(Math.round(note.velocity), 1, 127),
  };
}

export function findNote(composition: Composition, id: string): NoteEvent | undefined {
  return composition.notes.find((n) => n.id === id);
}

export function addNote(composition: Composition, note: NoteEvent): Composition {
  if (findNote(composition, note.id)) throw new Error(`Duplicate note id ${note.id}`);
  return markEdited({ ...composition, notes: [...composition.notes, clampNote(note, composition.settings.bars)] }, note.track);
}

export type NotePatch = Partial<Pick<NoteEvent, 'pitch' | 'start' | 'duration' | 'velocity'>>;

export function updateNote(composition: Composition, id: string, patch: NotePatch): Composition {
  let changed: TrackId | null = null;
  const notes = composition.notes.map((n) => {
    if (n.id !== id) return n;
    const next = clampNote({ ...n, ...patch }, composition.settings.bars);
    if (next.pitch === n.pitch && next.start === n.start && next.duration === n.duration && next.velocity === n.velocity) return n;
    changed = n.track;
    return next;
  });
  return changed ? markEdited({ ...composition, notes }, changed) : composition;
}

export function removeNote(composition: Composition, id: string): Composition {
  const note = findNote(composition, id);
  return note ? markEdited({ ...composition, notes: composition.notes.filter((n) => n.id !== id) }, note.track) : composition;
}

/** Marks parts as changed by hand. */
export function markEdited(composition: Composition, ...tracks: TrackId[]): Composition {
  const edited = composition.edited ?? [];
  if (tracks.every((t) => edited.includes(t))) return composition;
  return { ...composition, edited: TRACK_IDS.filter((t) => edited.includes(t) || tracks.includes(t)) };
}

/** Clears the mark on parts that were written again. */
export function clearEdited(composition: Composition, tracks: Iterable<TrackId>): Composition {
  const rewritten = new Set(tracks);
  const edited = (composition.edited ?? []).filter((t) => !rewritten.has(t));
  if (edited.length === (composition.edited?.length ?? 0)) return composition;
  const { edited: _, ...rest } = composition;
  return edited.length ? { ...rest, edited } : rest;
}

/** Parts written one note at a time. The brass stacks its stabs, like the chords. */
export const MONO_TRACKS: ReadonlySet<TrackId> = new Set(['melody', 'counter', 'bass']);

/**
 * `notes` with the bars in `bars` taken from `old`, in every part: the locked bars kept while the
 * rest is written again. New notes stop where a kept bar starts, and in one-line parts a new note
 * never sounds under a kept one.
 */
export function keepBars(notes: readonly NoteEvent[], old: readonly NoteEvent[], bars: readonly number[]): NoteEvent[] {
  if (!bars.length) return [...notes];
  const locked = new Set(bars);
  const barOf = (tick: number) => Math.floor(tick / TICKS_PER_BAR);
  const kept = old.filter((n) => locked.has(barOf(n.start)));
  const fresh: NoteEvent[] = [];
  for (const n of notes) {
    if (locked.has(barOf(n.start))) continue;
    let end = n.start + n.duration;
    for (let bar = barOf(n.start) + 1; bar * TICKS_PER_BAR < end; bar++) if (locked.has(bar)) end = Math.min(end, bar * TICKS_PER_BAR);
    if (MONO_TRACKS.has(n.track)) {
      // Under a kept note that rings on past its bar: dropped. Running into one: cut short.
      if (kept.some((k) => k.track === n.track && k.start <= n.start && k.start + k.duration > n.start)) continue;
      for (const k of kept) if (k.track === n.track && k.start > n.start && k.start < end) end = k.start;
    }
    fresh.push(end - n.start === n.duration ? n : { ...n, duration: end - n.start });
  }
  return [...fresh, ...kept].sort(
    (a, b) => a.start - b.start || TRACK_IDS.indexOf(a.track) - TRACK_IDS.indexOf(b.track) || a.pitch - b.pitch,
  );
}

let userNoteCounter = 0;
export function createNoteId(): string {
  userNoteCounter += 1;
  return `u${Date.now().toString(36)}${userNoteCounter.toString(36)}`;
}
