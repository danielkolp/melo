import { describe, expect, it } from 'vitest';
import { createSettings } from './generator';
import { BASS_FEEL, CHORD_FEEL, bassFit, chordFit, makePlan } from './plan';
import { STYLE_IDS } from './styles';
import type { BarCount } from './types';

const SEEDS = Array.from({ length: 30 }, (_, i) => 77 + i * 131);

describe('musical plan', () => {
  it('is the same for the same settings', () => {
    const settings = createSettings({ seed: 42, bars: 8 });
    expect(makePlan(settings)).toEqual(makePlan(settings));
  });

  it('runs whole phrases: state, repeat, contrast, cadence, with the energy peaking in the third bar', () => {
    for (const style of STYLE_IDS) {
      for (const bars of [4, 8] as BarCount[]) {
        const plan = makePlan(createSettings({ style, bars, seed: 9 }));
        expect(plan.bars).toHaveLength(bars);
        for (let p = 0; p < bars; p += 4) {
          const phrase = plan.bars.slice(p, p + 4);
          expect(phrase.map((b) => b.role)).toEqual(['statement', 'repeat', 'contrast', 'cadence']);
          expect(Math.max(...phrase.map((b) => b.energy))).toBe(phrase[2].energy);
          expect(phrase[3].turnaround).toBe(true);
        }
      }
      // A 2-bar loop states its idea and lands it.
      expect(makePlan(createSettings({ style, bars: 2, seed: 9 })).bars.map((b) => b.role)).toEqual(['statement', 'cadence']);
    }
  });

  it('lets the counter-melody fill only where the melody leaves space, and lifts the second phrase', () => {
    for (const style of STYLE_IDS) {
      for (const seed of SEEDS) {
        const plan = makePlan(createSettings({ style, seed, bars: 8 }));
        for (const bar of plan.bars) expect(bar.fill).toBe(bar.melody === 'sparse');
        expect(plan.bars[6].energy).toBeGreaterThan(plan.bars[2].energy);
      }
    }
    // Melodic house carries its line through more of the bars than UKG does.
    const sparse = (style: (typeof STYLE_IDS)[number]) =>
      SEEDS.reduce((a, seed) => a + makePlan(createSettings({ style, seed, bars: 8 })).bars.filter((b) => b.melody === 'sparse').length, 0);
    expect(sparse('melodicHouse')).toBeLessThan(sparse('ukg'));
  });

  it('scores a UKG bass that answers the kick above one that only doubles it', () => {
    const drums = { kick: [0, 10], clap: [4, 12], hat: [], openHat: [] };
    const doubling = [{ step: 0, len: 4 }, { step: 10, len: 4 }];
    const answering = [{ step: 0, len: 2 }, { step: 3, len: 2 }, { step: 10, len: 2 }, { step: 13, len: 2 }];
    expect(bassFit(answering, drums, BASS_FEEL.ukg)).toBeGreaterThan(bassFit(doubling, drums, BASS_FEEL.ukg));
    // On the backbeat is worse still.
    const onClap = [{ step: 4, len: 2 }, { step: 12, len: 2 }];
    expect(bassFit(onClap, drums, BASS_FEEL.ukg)).toBeLessThan(bassFit(doubling, drums, BASS_FEEL.ukg));
  });

  it('scores offbeat stabs above downbeat chords for UKG, and the other way round for melodic house', () => {
    const drums = { kick: [0, 4, 8, 12], clap: [4, 12], hat: [], openHat: [] };
    const stabs = [{ step: 3, len: 2 }, { step: 6, len: 2 }, { step: 10, len: 3 }];
    const downbeats = [{ step: 0, len: 8 }, { step: 8, len: 8 }];
    expect(chordFit(stabs, drums, CHORD_FEEL.ukg)).toBeGreaterThan(chordFit(downbeats, drums, CHORD_FEEL.ukg));
    expect(chordFit(downbeats, drums, CHORD_FEEL.melodicHouse)).toBeGreaterThan(chordFit(stabs, drums, CHORD_FEEL.melodicHouse));
  });
});
