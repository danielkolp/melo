import { Midi } from '@tonejs/midi';
import { describe, expect, it } from 'vitest';
import { createStudioStore } from '../state/store';
import {
  buildRoll,
  cycleDrums,
  duplicateSection,
  fitArrangement,
  insertSection,
  loopTickAt,
  resolveMaterial,
  moveSection,
  removeSection,
  sectionAt,
  songAutomation,
  songBeat,
  songLength,
  songNotes,
  songSpans,
  suggestArrangement,
  templateCount,
  toggleSectionPart,
  updateSection,
} from './arrangement';
import { BASELINE } from './automation';
import { createSettings, generateComposition } from './generator';
import { songToMidi } from './midi';
import { STYLE_IDS } from './styles';
import { TICKS_PER_BAR, TRACK_IDS, totalTicks, type Composition, type ImportSource, type NoteEvent, type SectionMaterial, type TrackId } from './types';
import { readComposition } from './validate';

const compose = (overrides: Parameters<typeof createSettings>[0] = {}): Composition => generateComposition(createSettings({ seed: 7, ...overrides }));

describe('song templates', () => {
  it('gives every style full-length structures with a peak where every part plays', () => {
    for (const style of STYLE_IDS) {
      for (let t = 0; t < templateCount(style); t++) {
        for (const loopBars of [2, 4, 8]) {
          const arr = suggestArrangement(style, loopBars, t);
          const bars = arr.sections.reduce((n, s) => n + s.bars, 0);
          expect(bars).toBeGreaterThanOrEqual(48);
          expect(bars).toBeLessThanOrEqual(160);
          for (const s of arr.sections) expect(s.bars % loopBars).toBe(0);
          expect(arr.sections.some((s) => TRACK_IDS.every((t) => s.parts[t]) && s.drums === 'full')).toBe(true);
          expect(new Set(arr.sections.map((s) => s.id)).size).toBe(arr.sections.length);
        }
      }
    }
  });

  it('keeps the structure across a new seed and a new length, and suggests a new one for a new style', () => {
    const comp = compose({ style: 'house', bars: 4 });
    const edited = { ...comp.arrangement, sections: comp.arrangement.sections.slice(0, 3) };
    const again = generateComposition({ ...comp.settings, seed: 99 }, comp.automation, edited);
    expect(again.arrangement).toBe(edited);
    const longer = generateComposition({ ...comp.settings, bars: 8 }, comp.automation, edited);
    expect(longer.arrangement.sections.map((s) => s.bars)).toEqual(edited.sections.map((s) => Math.max(8, Math.ceil(s.bars / 8) * 8)));
    const rap = generateComposition({ ...comp.settings, style: 'rap' }, comp.automation, edited);
    expect(rap.arrangement.style).toBe('rap');
    expect(fitArrangement(edited, 4)).toBe(edited);
  });
});

describe('song timeline', () => {
  it('lays sections end to end and restarts the loop at each one', () => {
    const comp = compose({ bars: 4 });
    const spans = songSpans(comp.arrangement);
    spans.forEach((s, i) => {
      expect(s.start).toBe(i === 0 ? 0 : spans[i - 1].end);
      expect(s.end - s.start).toBe(s.section.bars * TICKS_PER_BAR);
    });
    const loop = totalTicks(4);
    const second = spans[1];
    expect(loopTickAt(spans, loop, second.start)).toBe(0);
    expect(loopTickAt(spans, loop, second.start + loop + 240)).toBe(240);
    expect(sectionAt(spans, second.start)).toBe(second);
    expect(sectionAt(spans, songLength(spans) + 10)).toBe(spans[spans.length - 1]);
  });

  it('writes only the parts each section has, pass by pass', () => {
    const base = compose({ style: 'house', bars: 4 });
    // Every section on the loop as written; only the turnaround into a drop changes it.
    const comp = { ...base, arrangement: { ...base.arrangement, sections: base.arrangement.sections.map((s) => ({ ...s, material: 'A' as const })) } };
    const notes = songNotes(comp);
    const spans = songSpans(comp.arrangement);
    for (const span of spans) {
      const inside = notes.filter((n) => n.start >= span.start && n.start < span.end);
      const turns = ['drop', 'hook'].includes(spans[span.index + 1]?.section.kind ?? '');
      for (const t of TRACK_IDS) {
        const count = inside.filter((n) => n.track === t).length;
        const perLoop = comp.notes.filter((n) => n.track === t).length;
        if (!span.section.parts[t]) expect(count).toBe(0);
        else if (!turns) expect(count).toBe(perLoop * (span.section.bars / 4));
        else expect(count).toBeGreaterThan(0);
      }
      for (const n of inside) expect(n.start + n.duration).toBeLessThanOrEqual(span.end);
    }
    expect(new Set(notes.map((n) => n.id)).size).toBe(notes.length);
  });

  it('drops the kick and rolls the clap in a build, and plays nothing when drums are off', () => {
    const comp = compose({ style: 'house', bars: 4 });
    const beat = songBeat(comp);
    for (const span of songSpans(comp.arrangement)) {
      const hits = beat.filter((h) => h.tick >= span.start && h.tick < span.end);
      if (span.section.drums === 'off') expect(hits).toHaveLength(0);
      if (span.section.drums === 'build') {
        expect(hits.some((h) => h.voice === 'kick')).toBe(false);
        const claps = hits.filter((h) => h.voice === 'clap');
        expect(claps.length).toBe(buildRoll(span.section.bars).length);
        expect(claps[claps.length - 1].velocity).toBeGreaterThan(claps[0].velocity);
      }
      if (span.section.drums === 'light') expect(hits.some((h) => h.voice === 'clap')).toBe(false);
    }
  });

  it('holds the cutoff low in dark sections and opens it through a rise', () => {
    const comp = compose({ style: 'house', bars: 4 });
    const spans = songSpans(comp.arrangement);
    const cutoff = songAutomation(comp).find((l) => l.track === 'chords' && l.param === 'cutoff')!;
    const dark = spans.find((s) => s.section.filter === 'dark' && s.section.parts.chords)!;
    const rise = spans.find((s) => s.section.filter === 'rise' && s.section.parts.chords)!;
    const at = (tick: number) => cutoff.points.filter((p) => p.tick === tick).map((p) => p.value);
    const base = BASELINE.chords.cutoff;
    expect(Math.min(...at(dark.start))).toBeLessThan(base - 0.3);
    expect(Math.min(...at(rise.start))).toBeLessThan(base - 0.3);
    expect(Math.max(...at(rise.end))).toBeCloseTo(base, 5);
  });
});

describe('song edits', () => {
  const arr = suggestArrangement('house', 4);
  const first = arr.sections[0];

  it('toggles parts, cycles drums and swaps kinds with their defaults', () => {
    expect(toggleSectionPart(arr, first.id, 'bass').sections[0].parts.bass).toBe(!first.parts.bass);
    expect(cycleDrums(arr, first.id).sections[0].drums).not.toBe(first.drums);
    const asDrop = updateSection(arr, first.id, { kind: 'drop' }).sections[0];
    expect(asDrop).toMatchObject({ kind: 'drop', bars: first.bars, drums: 'full', filter: 'open' });
    expect(updateSection(arr, first.id, { bars: first.bars })).toBe(arr);
  });

  it('moves, duplicates, inserts and removes sections, always keeping one', () => {
    expect(moveSection(arr, first.id, 1).sections[1].id).toBe(first.id);
    expect(moveSection(arr, first.id, -1)).toBe(arr);
    const dup = duplicateSection(arr, first.id);
    expect(dup.sections).toHaveLength(arr.sections.length + 1);
    expect(dup.sections[1].id).not.toBe(first.id);
    expect(insertSection(arr, 'bridge', first.id, 4).sections[1].kind).toBe('bridge');
    let only = arr;
    for (const s of arr.sections) only = removeSection(only, s.id);
    expect(only.sections).toHaveLength(1);
  });

  it('records arrangement edits as undo steps in the studio', () => {
    const store = createStudioStore({ composition: compose(), random: () => 5 });
    const id = store.getState().history.present.arrangement.sections[0].id;
    const before = store.getState().history.present.arrangement;
    store.getState().toggleSectionPart(id, 'melody');
    expect(store.getState().history.present.arrangement).not.toBe(before);
    store.getState().undo();
    expect(store.getState().history.present.arrangement).toBe(before);
  });

  it('gives saves from before arrangements a suggested one', () => {
    const { arrangement: _a, ...old } = compose({ style: 'ukg' });
    const read = readComposition(JSON.parse(JSON.stringify(old)))!;
    expect(read.arrangement.style).toBe('ukg');
    expect(read.arrangement.sections.length).toBeGreaterThan(3);
  });
});

describe('song materials', () => {
  const SEEDS = Array.from({ length: 10 }, (_, i) => 5 + i * 6151);
  const loopOf = (notes: NoteEvent[], span: { start: number }, loop: number, track: TrackId) =>
    notes.filter((n) => n.track === track && n.start >= span.start && n.start < span.start + loop).map((n) => ({ ...n, start: n.start - span.start }));
  const shape = (notes: readonly NoteEvent[]) => notes.map((n) => `${n.start}:${n.pitch}`).join();
  /** A song with one section of each material, every part in, and nothing landing after it. */
  const withMaterials = (comp: Composition, materials: SectionMaterial[]): Composition => ({
    ...comp,
    arrangement: {
      ...comp.arrangement,
      sections: materials.map((material, i) => ({
        id: `m${i}`,
        kind: 'verse' as const,
        bars: comp.settings.bars,
        parts: { melody: true, counter: true, brass: true, chords: true, bass: true },
        drums: 'full' as const,
        filter: 'open' as const,
        material,
      })),
    },
  });

  it('chooses each section’s material from its kind and place in the song', () => {
    const { sections } = suggestArrangement('ukg', 4, 0);
    expect(sections.map((_, i) => resolveMaterial(sections, i))).toEqual(['reduced', 'A1', 'A', 'A1', 'A2', 'B', 'A2', 'reduced']);
    const chosen = sections.map((s, i) => (i === 2 ? { ...s, material: 'B' as const } : s));
    expect(resolveMaterial(chosen, 2)).toBe('B');
    expect(resolveMaterial(chosen, 4)).toBe('A2');
  });

  it('plays the loop as written in an A section', () => {
    for (const seed of SEEDS) {
      const comp = withMaterials(compose({ style: 'ukg', seed, bars: 4 }), ['A']);
      const notes = songNotes(comp);
      for (const t of TRACK_IDS) expect(shape(loopOf(notes, { start: 0 }, totalTicks(4), t))).toBe(shape(comp.notes.filter((n) => n.track === t)));
    }
  });

  it('moves the parts on in A′, A″ and B, keeping where they start from', () => {
    for (const style of STYLE_IDS) {
      const changed: Record<string, number> = { A1: 0, A2: 0, B: 0 };
      for (const seed of SEEDS) {
        const comp = withMaterials(compose({ style, seed, bars: 4 }), ['A1', 'A2', 'B']);
        const notes = songNotes(comp);
        const loop = totalTicks(4);
        (['A1', 'A2', 'B'] as const).forEach((material, i) => {
          const differs = TRACK_IDS.some((t) => shape(loopOf(notes, { start: i * loop }, loop, t)) !== shape(comp.notes.filter((n) => n.track === t)));
          if (differs) changed[material]++;
        });
        // A′ only changes the endings: every part's first bar is the loop's.
        const firstBar = (ns: NoteEvent[]) => shape(ns.filter((n) => n.start < TICKS_PER_BAR && n.track !== 'bass'));
        expect(firstBar(loopOf(notes, { start: 0 }, loop, 'melody'))).toBe(firstBar(comp.notes.filter((n) => n.track === 'melody')));
      }
      for (const material of ['A1', 'A2', 'B']) expect(changed[material], `${style} ${material}`).toBeGreaterThanOrEqual(SEEDS.length - 1);
    }
  });

  it('thins the parts out in a reduced section', () => {
    for (const style of STYLE_IDS) {
      let reduced = 0;
      let full = 0;
      for (const seed of SEEDS) {
        const comp = withMaterials(compose({ style, seed, bars: 4 }), ['A', 'reduced']);
        const notes = songNotes(comp);
        full += notes.filter((n) => n.start < totalTicks(4)).length;
        reduced += notes.filter((n) => n.start >= totalTicks(4)).length;
      }
      expect(reduced, style).toBeLessThan(full * 0.85);
    }
  });

  it('rests the top lines and walks the bass up in the pass before a drop', () => {
    for (const seed of SEEDS) {
      const base = withMaterials(compose({ style: 'house', seed, bars: 4 }), ['A', 'A']);
      const comp = { ...base, arrangement: { ...base.arrangement, sections: [{ ...base.arrangement.sections[0], bars: 8 }, { ...base.arrangement.sections[1], kind: 'drop' as const }] } };
      const notes = songNotes(comp);
      const loop = totalTicks(4);
      const tail = (from: number) => notes.filter((n) => n.start >= from - TICKS_PER_BAR / 2 && n.start < from);
      // The first pass is the loop; the second, the last before the drop, leaves the last two beats to the bass.
      expect(tail(2 * loop).filter((n) => ['melody', 'counter', 'brass'].includes(n.track))).toHaveLength(0);
      expect(shape(loopOf(notes, { start: 0 }, loop, 'bass'))).toBe(shape(comp.notes.filter((n) => n.track === 'bass')));
    }
  });

  it('plays uploaded parts as uploaded in every section', () => {
    const comp = compose({ style: 'ukg', bars: 4 });
    const held = withMaterials({ ...comp, source: { parts: [{ track: 'melody', name: 'Lead', notes: [] }] } as unknown as ImportSource }, ['B', 'reduced']);
    const notes = songNotes(held);
    const melody = comp.notes.filter((n) => n.track === 'melody');
    expect(shape(loopOf(notes, { start: 0 }, totalTicks(4), 'melody'))).toBe(shape(melody));
    expect(shape(loopOf(notes, { start: totalTicks(4) }, totalTicks(4), 'melody'))).toBe(shape(melody));
  });

  it('is the same every time, and loads saves with or without materials', () => {
    const comp = compose({ style: 'deepHouse', bars: 8 });
    expect(songNotes(comp)).toEqual(songNotes(comp));
    const marked = { ...comp, arrangement: updateSection(comp.arrangement, comp.arrangement.sections[1].id, { material: 'B' }) };
    expect(readComposition(JSON.parse(JSON.stringify(marked)))!.arrangement.sections[1].material).toBe('B');
    const broken = JSON.parse(JSON.stringify(marked));
    broken.arrangement.sections[1].material = 'Z';
    expect(readComposition(broken)!.arrangement.sections[1].material).toBeUndefined();
  });
});

describe('song export', () => {
  it('writes the whole song with markers, a drum track and no notes where a part is out', () => {
    const comp = compose({ style: 'house', bars: 4 });
    const midi = new Midi(songToMidi(comp, { title: 'Test' }));
    const spans = songSpans(comp.arrangement);
    const ppq = midi.header.ppq;
    expect(midi.header.meta.filter((m) => m.type === 'marker').map((m) => m.text)).toHaveLength(spans.length);
    const drums = midi.tracks.find((t) => t.channel === 9)!;
    expect(drums.notes.some((n) => n.midi === 36)).toBe(true);
    expect(drums.notes.some((n) => n.midi === 42)).toBe(true);
    const melody = midi.tracks.find((t) => t.name === 'Melody')!;
    const silent = spans.find((s) => !s.section.parts.melody)!;
    const inside = melody.notes.filter((n) => n.ticks >= silent.start && n.ticks < silent.end);
    expect(inside).toHaveLength(0);
    const lastTick = Math.max(...midi.tracks.flatMap((t) => t.notes.map((n) => n.ticks + n.durationTicks)));
    expect(lastTick).toBeLessThanOrEqual(songLength(spans) + ppq);
    expect(lastTick).toBeGreaterThan(songLength(spans) - 4 * TICKS_PER_BAR);
  });
});
