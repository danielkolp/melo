import { describe, expect, it } from 'vitest';
import { BRASS_KINDS, brassPlan, type BrassKind } from './brass';
import { chordAt, createSettings, generateComposition, regenerateTrack } from './generator';
import { isTurnaround } from './shared';
import { STYLE_IDS } from './styles';
import { scalePitchClasses } from './theory';
import { TICKS_PER_BAR, type BarCount, type NoteEvent, type TrackId } from './types';
import { readComposition } from './validate';

const SEEDS = Array.from({ length: 24 }, (_, i) => 300 + i * 977);
const pc = (p: number) => ((p % 12) + 12) % 12;
const byTrack = (notes: readonly NoteEvent[], track: TrackId) => notes.filter((n) => n.track === track);

function* loops() {
  for (const style of STYLE_IDS)
    for (const bars of [2, 4, 8] as BarCount[])
      for (const seed of SEEDS.slice(0, 8)) yield createSettings({ style, bars, seed, key: seed % 12, density: (seed % 10) / 10 });
}

describe('brass', () => {
  it('plays in every loop, and every style uses every kind of part', () => {
    for (const style of STYLE_IDS) {
      const kinds = new Set<BrassKind>();
      for (const seed of SEEDS) {
        const settings = createSettings({ style, seed, bars: 8 });
        kinds.add(brassPlan(settings).kind);
        expect(byTrack(generateComposition(settings).notes, 'brass').length, `${style} ${seed}`).toBeGreaterThan(0);
      }
      expect([...kinds].sort(), style).toEqual(Object.keys(BRASS_KINDS).sort());
    }
  });

  it('stays in the key (or the chord’s own scale) and under the melody wherever they meet', () => {
    for (const settings of loops()) {
      const { notes, progression } = generateComposition(settings);
      const key = scalePitchClasses(settings.key, settings.scale);
      const melody = byTrack(notes, 'melody');
      for (const b of byTrack(notes, 'brass')) {
        const chord = chordAt(progression, b.start);
        expect(new Set([...key, ...(chord.scale ?? []), ...chord.tones]).has(pc(b.pitch))).toBe(true);
        for (const m of melody) if (m.start < b.start + b.duration && m.start + m.duration > b.start) expect(b.pitch).toBeLessThan(m.pitch - 1);
      }
    }
  });

  it('comes in where its plan says: the second half of the loop, or the end of each phrase', () => {
    for (const settings of loops()) {
      const plan = brassPlan(settings);
      const bars = byTrack(generateComposition(settings).notes, 'brass').map((n) => Math.floor(n.start / TICKS_PER_BAR));
      if (plan.entry === 'late') expect(bars.every((b) => b >= settings.bars / 2)).toBe(true);
      if (plan.entry === 'ends') expect(bars.every((b) => isTurnaround(b, settings.bars))).toBe(true);
    }
  });

  it('leaves the answering to the counter-melody in a trade', () => {
    for (const style of STYLE_IDS) for (const seed of SEEDS) expect(brassPlan(createSettings({ style, seed, phrase: 'trade' })).kind).not.toBe('answer');
  });

  it('follows a new melody, and rerolls on its own without touching the rest', () => {
    const comp = generateComposition(createSettings({ seed: 21, bars: 8 }));
    const melody = regenerateTrack(comp, 'melody', 99);
    expect(byTrack(melody.notes, 'brass')).not.toEqual(byTrack(comp.notes, 'brass'));
    const brass = regenerateTrack(comp, 'brass', 1234);
    expect(brass.settings.trackSeeds.brass).toBe(1234);
    for (const track of ['melody', 'counter', 'chords', 'bass'] as const) expect(byTrack(brass.notes, track)).toEqual(byTrack(comp.notes, track));
  });

  it('gives a loop saved before the brass existed a brass part, keeping its notes', () => {
    const comp = generateComposition(createSettings({ seed: 5, bars: 4 }));
    const { brass: _, ...seeds } = comp.settings.trackSeeds;
    const old = {
      ...comp,
      settings: { ...comp.settings, trackSeeds: seeds },
      notes: comp.notes.filter((n) => n.track !== 'brass'),
      arrangement: { ...comp.arrangement, sections: comp.arrangement.sections.map(({ parts: { brass: __, ...parts }, ...s }) => ({ ...s, parts })) },
    };
    const loaded = readComposition(JSON.parse(JSON.stringify(old)))!;
    expect(loaded).not.toBeNull();
    expect(byTrack(loaded.notes, 'brass').length).toBeGreaterThan(0);
    expect(loaded.notes.filter((n) => n.track !== 'brass')).toEqual(old.notes);
    expect(loaded.arrangement.sections.every((s) => typeof s.parts.brass === 'boolean')).toBe(true);
  });
});
