import { describe, expect, it } from 'vitest';
import { drumPattern } from './beat';
import { createSettings, generateComposition } from './generator';
import { STEPS_PER_BAR } from './types';
import { STYLES, STYLE_IDS } from './styles';

describe('styles', () => {
  it('keeps every drum hit and hat roll inside the bar', () => {
    for (const id of STYLE_IDS) {
      const { rolls = [], ...voices } = STYLES[id].drums;
      for (const steps of Object.values(voices)) for (const s of steps) expect(s).toBeLessThan(STEPS_PER_BAR);
      for (const r of rolls) {
        expect(r.step + r.len).toBeLessThanOrEqual(STEPS_PER_BAR);
        expect(r.hits).toBeGreaterThan(r.len - 1);
      }
    }
  });

  it('varies the beat by seed, keeping the backbeat and every hit inside the bar', () => {
    for (const style of STYLE_IDS) {
      const beats = new Set<string>();
      for (let seed = 1; seed <= 24; seed++) {
        const beat = drumPattern({ style, seed });
        expect(drumPattern({ style, seed })).toEqual(beat);
        expect(beat.clap).toEqual(STYLES[style].drums.clap);
        expect(beat.kick).toContain(0);
        for (const s of [...beat.kick, ...beat.hat, ...beat.openHat]) expect(s).toBeLessThan(STEPS_PER_BAR);
        // A closed hat never doubles an open one or a roll.
        for (const s of beat.hat) {
          expect(beat.openHat).not.toContain(s);
          expect((beat.rolls ?? []).some((r) => s >= r.step && s < r.step + r.len)).toBe(false);
        }
        beats.add(JSON.stringify(beat));
      }
      expect(beats.size, style).toBeGreaterThan(4);
    }
  });

  it('writes rap 808 lines whose notes run into each other, so they slide', () => {
    for (const density of [0.2, 0.5, 0.85]) {
      let legato = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const bass = generateComposition(createSettings({ seed, style: 'rap', density })).notes.filter((n) => n.track === 'bass');
        legato += bass.filter((n, i) => i > 0 && bass[i - 1].start + bass[i - 1].duration === n.start).length;
      }
      expect(legato).toBeGreaterThan(6);
    }
  });

  it('gives rap a half-time backbeat, straight time and its own tempo', () => {
    const rap = STYLES.rap;
    expect(rap.drums.clap).toEqual([8]);
    expect(rap.swing).toBe(50);
    expect(rap.bpm).toBeGreaterThanOrEqual(130);
  });
});
