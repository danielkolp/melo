import { describe, expect, it } from 'vitest';
import { inferProgression } from './importing';
import { PPQ, STEP, VARIATION_COUNT, totalTicks, type ImportSource, type NoteEvent, type TrackId } from './types';
import { makeVariations } from './variations';

const notesOf = (track: TrackId, specs: [number, number, number][]): NoteEvent[] =>
  specs.map(([pitch, beat, beats], i) => ({ id: `${track}${i}`, track, pitch, start: beat * PPQ, duration: beats * PPQ, velocity: 96 }));

const PARTS: Record<TrackId, NoteEvent[]> = {
  melody: notesOf('melody', [
    [72, 0, 1], [74, 1, 0.5], [76, 1.5, 1.5], [79, 3, 1], [77, 4, 2], [76, 6, 1], [74, 7, 1],
    [72, 8, 1], [76, 9, 1], [79, 10, 2], [81, 12, 1], [79, 13, 1], [77, 14, 1], [76, 15, 1],
  ]),
  counter: notesOf('counter', [[60, 0, 2], [62, 2, 2], [64, 4, 1], [65, 5, 1], [67, 6, 2], [65, 8, 4], [64, 12, 2], [62, 14, 2]]),
  brass: notesOf('brass', [[67, 2.5, 0.5], [67, 3, 0.5], [65, 3.5, 0.5], [67, 6.5, 0.5], [67, 7, 1], [64, 10.5, 0.5], [65, 11, 0.5], [64, 14.5, 0.5], [62, 15, 1]]),
  chords: notesOf(
    'chords',
    [[60, 64, 67], [59, 62, 67], [57, 60, 64], [57, 60, 65]].flatMap((tones, bar) => tones.flatMap((p): [number, number, number][] => [[p, bar * 4, 1.5], [p, bar * 4 + 2, 1.5]])),
  ),
  bass: notesOf('bass', [36, 43, 45, 41].flatMap((r, bar): [number, number, number][] => [[r, bar * 4, 1.5], [r, bar * 4 + 2, 1], [r, bar * 4 + 3, 0.5]])),
};

function source(track: TrackId, amount = 0.5, variationSeed = 42): ImportSource {
  const parts = [{ track, name: track, notes: PARTS[track] }];
  return { fileName: 'x.mid', key: 0, scale: 'major', bars: 4, progression: inferProgression(parts, 0, 'major', 4), parts, variationSeed, amount, picked: { [track]: 0 } };
}

const sig = (notes: readonly NoteEvent[]) => notes.map((n) => `${n.start}:${n.pitch}:${n.duration}`).join(',');

describe('makeVariations', () => {
  it.each(['melody', 'counter', 'chords', 'bass'] as TrackId[])('deals six different, playable %s takes', (track) => {
    const cards = makeVariations(source(track), track, 'house');
    expect(cards).toHaveLength(VARIATION_COUNT);
    const signatures = new Set([sig(PARTS[track]), ...cards.map((c) => sig(c.notes))]);
    expect(signatures.size).toBe(VARIATION_COUNT + 1);
    const pitches = PARTS[track].map((n) => n.pitch);
    for (const card of cards) {
      expect(card.label.length).toBeGreaterThan(3);
      expect(new Set(card.notes.map((n) => n.id)).size).toBe(card.notes.length);
      for (const n of card.notes) {
        expect(n.track).toBe(track);
        expect(n.start % STEP).toBe(0);
        expect(n.start).toBeGreaterThanOrEqual(0);
        expect(n.start + n.duration).toBeLessThanOrEqual(totalTicks(4));
        expect(n.pitch).toBeGreaterThanOrEqual(Math.min(...pitches) - 7);
        expect(n.pitch).toBeLessThanOrEqual(Math.max(...pitches) + 7);
      }
      if (track !== 'chords') {
        card.notes.forEach((n, i) => {
          const next = card.notes[i + 1];
          if (next) expect(n.start + n.duration).toBeLessThanOrEqual(next.start);
        });
      }
    }
  });

  it('deals the same cards for the same seed, and new ones for a new seed', () => {
    const a = makeVariations(source('melody'), 'melody', 'ukg');
    expect(makeVariations(source('melody'), 'melody', 'ukg')).toEqual(a);
    const b = makeVariations(source('melody', 0.5, 43), 'melody', 'ukg');
    expect(b.map((c) => sig(c.notes))).not.toEqual(a.map((c) => sig(c.notes)));
  });

  it('strays further as the amount rises', () => {
    const changed = (amount: number) => {
      let total = 0;
      for (let seed = 0; seed < 12; seed++) {
        for (const track of ['melody', 'bass'] as TrackId[]) {
          const original = new Set(PARTS[track].map((n) => `${n.start}:${n.pitch}`));
          for (const card of makeVariations(source(track, amount, seed), track, 'house')) {
            total += card.notes.filter((n) => !original.has(`${n.start}:${n.pitch}`)).length / card.notes.length;
          }
        }
      }
      return total;
    };
    expect(changed(1)).toBeGreaterThan(changed(0) * 1.3);
  });
});
