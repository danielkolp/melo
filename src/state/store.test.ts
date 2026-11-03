import { describe, expect, it } from 'vitest';
import { createSettings, generateComposition } from '../core/generator';
import { STEP } from '../core/types';
import { COALESCE_WINDOW_MS, commit, createHistory, redo, undo } from './history';
import { createStudioStore } from './store';

function makeStore() {
  let seed = 100;
  return createStudioStore({
    composition: generateComposition(createSettings({ seed: 1 })),
    random: () => ++seed,
  });
}
const notesOf = (store: ReturnType<typeof makeStore>, track: string) =>
  store.getState().history.present.notes.filter((n) => n.track === track);

describe('history', () => {
  it('undoes and redoes in order', () => {
    let h = createHistory(1);
    h = commit(h, 2);
    h = commit(h, 3);
    h = undo(h);
    expect(h.present).toBe(2);
    h = undo(h);
    expect(h.present).toBe(1);
    expect(undo(h)).toBe(h);
    h = redo(redo(h));
    expect(h.present).toBe(3);
  });

  it('drops the redo stack on a new commit', () => {
    let h = commit(commit(createHistory('a'), 'b'), 'c');
    h = commit(undo(h), 'd');
    expect(h.future).toEqual([]);
    expect(h.past).toEqual(['a', 'b']);
  });

  it('coalesces rapid commits that share a key', () => {
    let h = createHistory(0);
    h = commit(h, 1, { coalesceKey: 'v', now: 1000 });
    h = commit(h, 2, { coalesceKey: 'v', now: 1200 });
    h = commit(h, 3, { coalesceKey: 'v', now: 1400 });
    expect(h.past).toEqual([0]);
    h = commit(h, 4, { coalesceKey: 'v', now: 1400 + COALESCE_WINDOW_MS + 1 });
    expect(h.past).toEqual([0, 3]);
  });
});

describe('studio store', () => {
  it('regenerates one part, and undo restores it', () => {
    const store = makeStore();
    const melody = notesOf(store, 'melody');
    const bass = notesOf(store, 'bass');
    store.getState().regenerateTrack('melody');
    expect(notesOf(store, 'melody')).not.toEqual(melody);
    expect(notesOf(store, 'bass')).toEqual(bass);
    store.getState().undo();
    expect(notesOf(store, 'melody')).toEqual(melody);
    store.getState().redo();
    expect(notesOf(store, 'melody')).not.toEqual(melody);
  });

  it('keeps seeds when musical settings change, so the idea is recognisable', () => {
    const store = makeStore();
    const before = store.getState().history.present.settings;
    store.getState().changeMusic({ density: 0.9 });
    const after = store.getState().history.present.settings;
    expect(after.seed).toBe(before.seed);
    expect(after.trackSeeds).toEqual(before.trackSeeds);
    expect(after.density).toBe(0.9);
  });

  it('sets tempo and swing from the style', () => {
    const store = makeStore();
    store.getState().setStyle('deepHouse');
    expect(store.getState().history.present.settings).toMatchObject({ style: 'deepHouse', bpm: 122, swing: 56 });
  });

  it('changes tempo without touching the notes', () => {
    const store = makeStore();
    const notes = store.getState().history.present.notes;
    store.getState().setTempo(140);
    expect(store.getState().history.present.settings.bpm).toBe(140);
    expect(store.getState().history.present.notes).toBe(notes);
  });

  it('records a whole drag as a single undo step', () => {
    const store = makeStore();
    const note = notesOf(store, 'melody')[0];
    const pastBefore = store.getState().history.past.length;
    store.getState().beginGesture();
    store.getState().previewNote(note.id, { pitch: note.pitch + 1 });
    store.getState().previewNote(note.id, { pitch: note.pitch + 2, start: note.start + STEP });
    store.getState().endGesture();
    expect(store.getState().history.past.length).toBe(pastBefore + 1);
    store.getState().undo();
    expect(notesOf(store, 'melody')[0]).toEqual(note);
  });

  it('adds a note, selects it and clears the selection when it is undone', () => {
    const store = makeStore();
    const id = store.getState().addNote({ track: 'bass', pitch: 40, start: 0, duration: STEP * 2, velocity: 100 });
    expect(store.getState().selectedId).toBe(id);
    expect(store.getState().activeTrack).toBe('bass');
    store.getState().undo();
    expect(store.getState().selectedId).toBeNull();
  });

  it('deletes notes', () => {
    const store = makeStore();
    const note = notesOf(store, 'counter')[0];
    store.getState().select(note.id);
    store.getState().deleteNote(note.id);
    expect(notesOf(store, 'counter').some((n) => n.id === note.id)).toBe(false);
    expect(store.getState().selectedId).toBeNull();
  });

  it('changes the phrase form and keeps the seeds', () => {
    const store = makeStore();
    const before = store.getState().history.present.settings;
    store.getState().changeMusic({ phrase: 'hook' });
    const after = store.getState().history.present;
    expect(after.settings.phrase).toBe('hook');
    expect(after.phrasing.form).toBe('hook');
    expect(after.settings.trackSeeds).toEqual(before.trackSeeds);
  });

  it('toggles automation lanes as undoable steps, and keeps the choice through regeneration', () => {
    const store = makeStore();
    const lane = store.getState().history.present.automation[0];
    store.getState().toggleAutomation(lane.id);
    expect(store.getState().history.present.automation[0].enabled).toBe(false);
    store.getState().changeMusic({ density: 0.8 });
    const same = store.getState().history.present.automation.find((l) => l.id === lane.id);
    if (same) expect(same.enabled).toBe(false);
    store.getState().undo();
    store.getState().undo();
    expect(store.getState().history.present.automation[0].enabled).toBe(true);
  });

  it('re-rolls automation without touching the notes', () => {
    const store = makeStore();
    const before = store.getState().history.present;
    store.getState().focusLane(before.automation[1].id);
    store.getState().rerollAutomation();
    const after = store.getState().history.present;
    expect(after.notes).toBe(before.notes);
    expect(after.settings.automationSeed).not.toBe(before.settings.automationSeed);
    expect(store.getState().focusedLane).toBeNull();
  });

  it('gives a new idea new automation', () => {
    const store = makeStore();
    const before = store.getState().history.present.settings.automationSeed;
    store.getState().generate(424242);
    expect(store.getState().history.present.settings.automationSeed).not.toBe(before);
  });
});

describe('saved sessions', () => {
  it('reads current saves and brings old ones up to date without losing notes', async () => {
    const { readComposition } = await import('../core/validate');
    const current = generateComposition(createSettings({ seed: 3 }));
    expect(readComposition(JSON.parse(JSON.stringify(current)))).toEqual(current);

    const { phrasing: _p, automation: _a, ...rest } = current;
    const { phrase: _f, automationSeed: _s, ...oldSettings } = current.settings;
    const old = JSON.parse(JSON.stringify({ ...rest, settings: oldSettings }));
    const migrated = readComposition(old)!;
    expect(migrated.notes).toEqual(current.notes);
    expect(migrated.settings.phrase).toBe('auto');
    expect(migrated.phrasing.sections).toHaveLength(current.settings.bars);
    expect(migrated.automation.length).toBeGreaterThan(0);
    expect(readComposition({ settings: {}, notes: [] })).toBeNull();
  });
});
