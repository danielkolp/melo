import { describe, expect, it } from 'vitest';
import { drumPlays, songBeat } from './arrangement';
import { beatHits } from './beat';
import { createSettings, generateComposition, regenerateTrack } from './generator';
import { STYLE_IDS } from './styles';
import { resolveTransition } from './transition';
import { STEP, TICKS_PER_BAR, totalTicks, type CompositionSettings, type NoteEvent, type TrackId, type TransitionKind } from './types';

const SEEDS = Array.from({ length: 12 }, (_, i) => 17 + i * 6151);
const KINDS: TransitionKind[] = ['roll', 'stop', 'lift'];
const byTrack = (notes: NoteEvent[], track: TrackId) => notes.filter((n) => n.track === track);

function* cases(kind: TransitionKind) {
  for (const style of STYLE_IDS) for (const seed of SEEDS) yield createSettings({ style, seed, bars: 8, transition: kind });
}

/** The last bar's window, and which part leads it. */
function frame(settings: CompositionSettings) {
  const t = resolveTransition(settings)!;
  const end = totalTicks(8);
  return { t, end, bar: end - TICKS_PER_BAR, from: end - TICKS_PER_BAR + t.from * STEP };
}

describe('choosing a transition', () => {
  it('only ends 8-bar loops, and not when switched off', () => {
    expect(resolveTransition(createSettings({ bars: 4 }))).toBeNull();
    expect(resolveTransition(createSettings({ bars: 2 }))).toBeNull();
    expect(resolveTransition(createSettings({ bars: 8, transition: 'none' }))).toBeNull();
    expect(resolveTransition(createSettings({ bars: 8, transition: 'lift' }))?.kind).toBe('lift');
  });

  it('picks from the style on auto, the same way every time', () => {
    for (const style of STYLE_IDS) {
      const kinds = new Set(SEEDS.map((seed) => resolveTransition(createSettings({ style, seed, bars: 8 }))!.kind));
      expect(kinds.size).toBeGreaterThan(1);
      const settings = createSettings({ style, seed: 5, bars: 8 });
      expect(resolveTransition(settings)).toEqual(resolveTransition(settings));
    }
  });
});

describe('the beat', () => {
  it('rolls the clap, stops dead, or drops the kick in the last bar only', () => {
    for (const style of STYLE_IDS) {
      for (const kind of KINDS) {
        const settings = createSettings({ style, bars: 8, transition: kind });
        const { t, bar, from } = frame(settings);
        const plain = beatHits(settings);
        const hits = beatHits(settings, t);
        expect(hits.filter((h) => h.tick < bar)).toEqual(plain.filter((h) => h.tick < bar));
        const fill = hits.filter((h) => h.fill);
        expect(fill.length).toBeGreaterThan(0);
        if (kind === 'roll') expect(fill.every((h) => h.voice === 'clap' && h.tick >= from)).toBe(true);
        if (kind === 'stop') expect(hits.filter((h) => h.tick > from)).toHaveLength(0);
        if (kind === 'lift') expect(hits.some((h) => h.tick >= bar && h.voice === 'kick')).toBe(false);
      }
    }
  });

  it('plays the fill only with the full beat', () => {
    const fill = { voice: 'hat' as const, fill: true as const };
    expect(drumPlays('full', fill)).toBe(true);
    expect(drumPlays('light', fill)).toBe(false);
    expect(drumPlays('build', fill)).toBe(false);
  });

  it('ends every 8 bars of the song', () => {
    const settings = createSettings({ bars: 8, transition: 'roll' });
    const comp = generateComposition(settings);
    const fills = songBeat(comp).filter((h) => h.fill);
    const full = comp.arrangement.sections.filter((s) => s.drums === 'full').reduce((a, s) => a + s.bars, 0);
    expect(fills.length).toBe((full / 8) * 6);
  });
});

describe('the parts', () => {
  it('stop: the band hits once together, and only the lead plays on', () => {
    for (const settings of cases('stop')) {
      const { notes, phrasing } = generateComposition(settings);
      const { from } = frame(settings);
      const lead = phrasing.sections.at(-1)!.voice;
      for (const track of ['chords', 'bass'] as const) {
        const late = byTrack(notes, track).filter((n) => n.start + n.duration > from);
        expect(late.length).toBeGreaterThan(0);
        expect(late.every((n) => n.start === from && n.duration === STEP * 2), track).toBe(true);
      }
      const other = lead === 'melody' ? 'counter' : 'melody';
      expect(byTrack(notes, other).every((n) => n.start + n.duration <= from)).toBe(true);
    }
  });

  it('roll: the chords stab along and the bass walks up into bar 1', () => {
    for (const settings of cases('roll')) {
      const { notes } = generateComposition(settings);
      const { from } = frame(settings);
      const onsets = (track: TrackId) => [...new Set(byTrack(notes, track).filter((n) => n.start >= from).map((n) => (n.start - from) / STEP))];
      expect(onsets('chords')).toEqual([0, 2, 4, 6]);
      expect(onsets('bass')).toEqual([0, 2, 4, 6]);
      // The walk moves one way, a scale step at a time, toward the loop's first bass note.
      const walk = byTrack(notes, 'bass').filter((n) => n.start > from).map((n) => n.pitch);
      const first = byTrack(notes, 'bass')[0].pitch;
      for (let i = 1; i < walk.length; i++) expect(Math.abs(walk[i] - walk[i - 1])).toBeLessThanOrEqual(3);
      expect(Math.abs(first - walk[walk.length - 1])).toBeLessThanOrEqual(3);
    }
  });

  it('lift: the bass and chords hold one long note for each chord of the bar', () => {
    for (const settings of cases('lift')) {
      const { notes, progression } = generateComposition(settings);
      const { bar } = frame(settings);
      const chords = progression.filter((c) => c.start >= bar);
      expect(byTrack(notes, 'bass').filter((n) => n.start >= bar)).toHaveLength(chords.length);
      const hits = new Set(byTrack(notes, 'chords').filter((n) => n.start + n.duration > bar).map((n) => n.start));
      expect(hits.size).toBeLessThanOrEqual(chords.length);
    }
  });

  it('leaves the first seven bars alone', () => {
    for (const kind of KINDS) {
      for (const style of STYLE_IDS) {
        const plain = generateComposition(createSettings({ style, seed: 99, bars: 8, transition: 'none' }));
        const ended = generateComposition(createSettings({ style, seed: 99, bars: 8, transition: kind }));
        const early = (c: typeof plain) => c.notes.filter((n) => n.start + n.duration <= 7 * TICKS_PER_BAR - STEP * 4);
        expect(early(ended)).toEqual(early(plain));
      }
    }
  });

  it('keeps its transition when one part is regenerated', () => {
    const comp = generateComposition(createSettings({ seed: 4, bars: 8, transition: 'stop' }));
    const { from } = frame(comp.settings);
    const next = regenerateTrack(comp, 'bass', 1234);
    const late = byTrack(next.notes, 'bass').filter((n) => n.start + n.duration > from);
    expect(late).toHaveLength(1);
    expect(late[0].start).toBe(from);
  });
});
