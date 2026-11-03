import { STEP, totalTicks, type Composition, type NoteEvent } from './types';

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
  return { ...composition, notes: [...composition.notes, clampNote(note, composition.settings.bars)] };
}

export type NotePatch = Partial<Pick<NoteEvent, 'pitch' | 'start' | 'duration' | 'velocity'>>;

export function updateNote(composition: Composition, id: string, patch: NotePatch): Composition {
  let changed = false;
  const notes = composition.notes.map((n) => {
    if (n.id !== id) return n;
    const next = clampNote({ ...n, ...patch }, composition.settings.bars);
    changed =
      next.pitch !== n.pitch || next.start !== n.start || next.duration !== n.duration || next.velocity !== n.velocity;
    return changed ? next : n;
  });
  return changed ? { ...composition, notes } : composition;
}

export function removeNote(composition: Composition, id: string): Composition {
  const notes = composition.notes.filter((n) => n.id !== id);
  return notes.length === composition.notes.length ? composition : { ...composition, notes };
}

let userNoteCounter = 0;
export function createNoteId(): string {
  userNoteCounter += 1;
  return `u${Date.now().toString(36)}${userNoteCounter.toString(36)}`;
}
