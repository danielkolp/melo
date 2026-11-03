import { describe, expect, it } from 'vitest';
import { addNote, clampNote, removeNote, updateNote } from './edit';
import { createSettings, generateComposition } from './generator';
import { STEP, totalTicks, type NoteEvent } from './types';

const comp = generateComposition(createSettings({ seed: 21, bars: 4 }));
const first = comp.notes[0];

describe('note editing', () => {
  it('snaps notes to the grid and keeps them inside the loop', () => {
    const note: NoteEvent = { id: 'x', track: 'melody', pitch: 70.4, start: 130, duration: 10, velocity: 300 };
    expect(clampNote(note, 4)).toEqual({ ...note, pitch: 70, start: STEP, duration: STEP, velocity: 127 });
    const late = clampNote({ ...note, start: totalTicks(4), duration: STEP * 2 }, 4);
    expect(late.start + late.duration).toBe(totalTicks(4));
  });

  it('adds, updates and removes notes without mutating the original', () => {
    const before = JSON.stringify(comp);
    const added = addNote(comp, { id: 'new', track: 'bass', pitch: 40, start: 0, duration: STEP, velocity: 90 });
    expect(added.notes).toHaveLength(comp.notes.length + 1);

    const moved = updateNote(comp, first.id, { pitch: first.pitch + 1, start: first.start + STEP });
    expect(moved.notes.find((n) => n.id === first.id)).toMatchObject({ pitch: first.pitch + 1, start: first.start + STEP });

    const removed = removeNote(comp, first.id);
    expect(removed.notes.some((n) => n.id === first.id)).toBe(false);
    expect(JSON.stringify(comp)).toBe(before);
  });

  it('returns the same object when nothing changes', () => {
    expect(updateNote(comp, first.id, { pitch: first.pitch })).toBe(comp);
    expect(updateNote(comp, 'missing', { pitch: 1 })).toBe(comp);
    expect(removeNote(comp, 'missing')).toBe(comp);
  });

  it('rejects duplicate ids', () => {
    expect(() => addNote(comp, first)).toThrow();
  });
});
