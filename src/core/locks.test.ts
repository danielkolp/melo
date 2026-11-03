import { describe, expect, it } from 'vitest';
import { createStudioStore } from '../state/store';
import { MONO_TRACKS, addNote } from './edit';
import { createSettings, generateComposition, generateProgression, regenerateTrack } from './generator';
import { harmonyFit, newChords, recompose, rewriteBar, toggleBarLock, toggleLock } from './locks';
import { makePlan } from './plan';
import { deriveSeed } from './random';
import { STYLE_IDS } from './styles';
import { TICKS_PER_BAR, TRACK_IDS, type Composition, type NoteEvent, type TrackId } from './types';
import { readComposition } from './validate';

const SEEDS = Array.from({ length: 8 }, (_, i) => 3 + i * 7919);
const compose = (overrides: Parameters<typeof createSettings>[0] = {}) => generateComposition(createSettings({ seed: 7, bars: 4, ...overrides }));
const part = (c: Composition, track: TrackId) => c.notes.filter((n) => n.track === track);
const shape = (notes: readonly NoteEvent[]) =>
  [...notes]
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch)
    .map((n) => `${n.start}:${n.pitch}:${n.duration}`)
    .join();
const pitches = (notes: readonly NoteEvent[]) => [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch).map((n) => n.pitch);
const inBar = (notes: readonly NoteEvent[], bar: number) => notes.filter((n) => Math.floor(n.start / TICKS_PER_BAR) === bar);
/** A fresh seed, the way Generate makes one. */
const reseeded = (c: Composition, seed: number) => {
  const { harmonySeed: _, ...settings } = c.settings;
  return { ...settings, seed, trackSeeds: Object.fromEntries(TRACK_IDS.map((t) => [t, deriveSeed(seed, t)])) as typeof settings.trackSeeds };
};
const monophonic = (notes: readonly NoteEvent[]) => notes.every((n, i) => i === 0 || notes[i - 1].start + notes[i - 1].duration <= n.start);

describe('locks', () => {
  it('toggles parts and bars, leaving the field off when nothing is locked', () => {
    const c = compose();
    const locked = toggleBarLock(toggleLock(c, 'bass'), 2);
    expect(locked.locks).toEqual({ tracks: ['bass'], bars: [2] });
    expect(toggleBarLock(toggleLock(locked, 'bass'), 2).locks).toBeUndefined();
    expect(toggleBarLock(c, 9)).toBe(c);
  });

  it('keeps locked parts, and the harmony under them, through Generate', () => {
    for (const style of STYLE_IDS) {
      for (const seed of SEEDS.slice(0, 4)) {
        const c = toggleLock(compose({ style, seed }), 'melody');
        const next = recompose(c, reseeded(c, seed + 1));
        expect(shape(part(next, 'melody'))).toBe(shape(part(c, 'melody')));
        expect(next.progression.map((x) => x.tones.join())).toEqual(c.progression.map((x) => x.tones.join()));
        expect(shape(part(next, 'bass'))).not.toBe(shape(part(c, 'bass')));
        expect(next.locks).toEqual(c.locks);
      }
    }
  });

  it('keeps locked parts through density and style changes, and moves them with the key', () => {
    const c = toggleLock(compose({ style: 'ukg', key: 0 }), 'chords');
    expect(shape(part(recompose(c, { ...c.settings, density: 0.9 }), 'chords'))).toBe(shape(part(c, 'chords')));
    expect(shape(part(recompose(c, { ...c.settings, style: 'house' }), 'chords'))).toBe(shape(part(c, 'chords')));
    const moved = part(recompose(c, { ...c.settings, key: 2 }), 'chords');
    expect(moved.map((n) => n.pitch - 2)).toEqual(part(c, 'chords').map((n) => n.pitch));
  });

  it('fits locked parts to a new length', () => {
    const c = toggleLock(compose({ bars: 4 }), 'bass');
    const longer = recompose(c, { ...c.settings, bars: 8 });
    const bass = part(c, 'bass');
    expect(part(longer, 'bass').filter((n) => n.start < 4 * TICKS_PER_BAR).map((n) => n.pitch)).toEqual(bass.map((n) => n.pitch));
    expect(part(longer, 'bass').length).toBe(bass.length * 2);
  });

  it('keeps every part of a locked bar, and keeps one-line parts one note at a time', () => {
    for (const seed of SEEDS) {
      const c = toggleBarLock(compose({ seed, style: 'ukg' }), 1);
      const next = recompose(c, reseeded(c, seed + 99));
      for (const t of TRACK_IDS) {
        expect(shape(inBar(part(next, t), 1)), t).toBe(shape(inBar(part(c, t), 1)));
        if (MONO_TRACKS.has(t)) expect(monophonic(part(next, t)), t).toBe(true);
      }
      expect(TRACK_IDS.some((t) => shape(inBar(part(next, t), 0)) !== shape(inBar(part(c, t), 0)))).toBe(true);
    }
  });

  it('never rewrites a locked part, and keeps locked bars when another part is rewritten', () => {
    const c = toggleBarLock(toggleLock(compose(), 'bass'), 0);
    expect(regenerateTrack(c, 'bass', 99)).toBe(c);
    const next = regenerateTrack(c, 'chords', 99);
    expect(shape(inBar(part(next, 'chords'), 0))).toBe(shape(inBar(part(c, 'chords'), 0)));
    expect(shape(part(next, 'chords'))).not.toBe(shape(part(c, 'chords')));
  });
});

describe('hand edits', () => {
  const edit = (c: Composition, track: TrackId) => {
    const n = part(c, track)[0];
    return addNote(c, { ...n, id: `u-${track}`, pitch: n.pitch + 12 > 108 ? n.pitch - 12 : n.pitch + 12 });
  };

  it('marks a part edited, and clears the mark when the part is written again', () => {
    const c = edit(compose(), 'counter');
    expect(c.edited).toEqual(['counter']);
    expect(regenerateTrack(c, 'counter', 5).edited).toBeUndefined();
    expect(regenerateTrack(c, 'bass', 5).edited).toEqual(['counter']);
  });

  it('keeps an edited counter-melody and brass when the melody is rewritten', () => {
    for (const seed of SEEDS) {
      const c = edit(edit(compose({ seed, phrase: 'hook' }), 'counter'), 'brass');
      const next = regenerateTrack(c, 'melody', seed + 1);
      expect(shape(part(next, 'counter'))).toBe(shape(part(c, 'counter')));
      expect(shape(part(next, 'brass'))).toBe(shape(part(c, 'brass')));
    }
  });

  it('moves edited parts with a key change, but writes them again for other changes', () => {
    const c = edit(compose({ key: 0 }), 'melody');
    const moved = recompose(c, { ...c.settings, key: 3 }, { keepEdited: true });
    expect(pitches(part(moved, 'melody')).map((p) => p - 3)).toEqual(pitches(part(c, 'melody')));
    expect(moved.edited).toEqual(['melody']);
    const denser = recompose(c, { ...c.settings, density: 0.9 });
    expect(part(denser, 'melody').some((n) => n.id === 'u-melody')).toBe(false);
    expect(denser.edited).toBeUndefined();
  });
});

describe('rewriteBar', () => {
  it('changes only that bar of that part, and marks it edited', () => {
    let rewritten = 0;
    for (const track of TRACK_IDS) {
      for (const seed of SEEDS.slice(0, 4)) {
        const c = compose({ seed, style: 'house' });
        const next = rewriteBar(c, track, 2, seed);
        if (next === c) continue;
        rewritten++;
        for (const t of TRACK_IDS) if (t !== track) expect(shape(part(next, t))).toBe(shape(part(c, t)));
        // Other bars keep their notes; one held into bar 2 may stop at the barline.
        for (const bar of [0, 1, 3]) {
          const onsets = (ns: NoteEvent[]) => pitches(inBar(ns, bar)).join() + '|' + inBar(ns, bar).map((n) => n.start).sort((a, b) => a - b).join();
          expect(onsets(part(next, track)), `${track} bar ${bar}`).toBe(onsets(part(c, track)));
        }
        expect(shape(inBar(part(next, track), 2))).not.toBe(shape(inBar(part(c, track), 2)));
        expect(next.edited).toContain(track);
        if (MONO_TRACKS.has(track)) expect(monophonic(part(next, track))).toBe(true);
      }
    }
    expect(rewritten).toBeGreaterThan(TRACK_IDS.length * 3);
  });

  it('gives another take for another seed, the same one for the same seed', () => {
    const c = compose({ seed: 21, style: 'ukg' });
    expect(rewriteBar(c, 'melody', 1, 4)).toEqual(rewriteBar(c, 'melody', 1, 4));
    const takes = new Set([1, 2, 3, 4, 5].map((s) => shape(inBar(part(rewriteBar(c, 'melody', 1, s), 'melody'), 1))));
    expect(takes.size).toBeGreaterThan(2);
  });

  it('leaves locked bars and parts alone', () => {
    const c = compose();
    const bar = toggleBarLock(c, 1);
    expect(rewriteBar(bar, 'melody', 1, 3)).toBe(bar);
    const track = toggleLock(c, 'melody');
    expect(rewriteBar(track, 'melody', 1, 3)).toBe(track);
  });
});

describe('newChords', () => {
  it('writes new harmony under the loop without touching the drums', () => {
    for (const seed of SEEDS.slice(0, 4)) {
      const c = compose({ seed });
      const next = newChords(c, seed + 1);
      expect(next.progression.map((x) => x.tones.join())).not.toEqual(c.progression.map((x) => x.tones.join()));
      expect(next.settings.seed).toBe(c.settings.seed);
      expect(makePlan(next.settings).drums).toEqual(makePlan(c.settings).drums);
    }
  });

  it('keeps a locked melody and picks a progression that suits it', () => {
    let better = 0;
    for (const seed of SEEDS) {
      const c = toggleLock(compose({ seed }), 'melody');
      const next = newChords(c, seed + 1);
      expect(shape(part(next, 'melody'))).toBe(shape(part(c, 'melody')));
      const first = generateProgression({ ...c.settings, harmonySeed: deriveSeed(seed + 1, 'chords/0') });
      const fit = harmonyFit(part(c, 'melody'), next.progression);
      expect(fit).toBeGreaterThanOrEqual(harmonyFit(part(c, 'melody'), first));
      if (fit > harmonyFit(part(c, 'melody'), first)) better++;
    }
    expect(better).toBeGreaterThan(0);
  });

  it('does nothing while the chords or the bass are locked', () => {
    const c = toggleLock(compose(), 'chords');
    expect(newChords(c, 3)).toBe(c);
  });

  it('keeps the chords under a locked bar', () => {
    const c = toggleBarLock(compose(), 0);
    const next = newChords(c, 11);
    const at = (comp: Composition) => comp.progression.filter((x) => x.start < TICKS_PER_BAR).map((x) => x.tones.join());
    expect(at(next)).toEqual(at(c));
    expect(shape(inBar(part(next, 'chords'), 0))).toBe(shape(inBar(part(c, 'chords'), 0)));
  });
});

describe('studio', () => {
  it('undoes and redoes locks, bar rewrites and new chords', () => {
    let n = 100;
    const store = createStudioStore({ composition: compose(), random: () => n++ });
    const s = () => store.getState();
    const start = s().history.present;
    s().toggleLock('bass');
    s().rewriteBar('melody', 1);
    s().newChords();
    s().generate();
    expect(shape(part(s().history.present, 'bass'))).not.toBe('');
    const steps = [start];
    expect(s().history.present.locks?.tracks).toEqual(['bass']);
    for (let i = 0; i < 4; i++) s().undo();
    expect(s().history.present).toBe(steps[0]);
    for (let i = 0; i < 4; i++) s().redo();
    expect(s().history.present.locks?.tracks).toEqual(['bass']);
  });

  it('keeps hand edits through a key change in the studio', () => {
    const store = createStudioStore({ composition: compose({ key: 0 }), random: () => 9 });
    const s = () => store.getState();
    const first = part(s().history.present, 'melody')[0];
    s().updateNote(first.id, { pitch: first.pitch + 1 });
    s().changeMusic({ key: 5 });
    expect(part(s().history.present, 'melody').find((x) => x.id === first.id)?.pitch).toBe(first.pitch + 1 + 5);
  });

  it('loads saves with and without locks', () => {
    const saved = JSON.parse(JSON.stringify({ ...toggleBarLock(toggleLock(compose(), 'melody'), 3), edited: ['bass', 'nope'] }));
    const read = readComposition(saved)!;
    expect(read.locks).toEqual({ tracks: ['melody'], bars: [3] });
    expect(read.edited).toEqual(['bass']);
    saved.locks = { tracks: ['x'], bars: [12, -1] };
    expect(readComposition(saved)!.locks).toBeUndefined();
    const { locks: _, edited: __, ...old } = saved;
    expect(readComposition(old)!.locks).toBeUndefined();
    expect(readComposition(old)!.edited).toBeUndefined();
  });
});
