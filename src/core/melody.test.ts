import { describe, expect, it } from 'vitest';
import { createSettings, generateComposition, generateProgression, regenerateTrack } from './generator';
import { PHRASE_FORM_IDS, melodyPool, realise, resolveForm } from './melody';
import { makePlan } from './plan';
import { melodyMetrics } from './score';
import { makeMotif, vary } from './motif';
import { createRng } from './random';
import { STYLES, STYLE_IDS } from './styles';
import { STEP, TICKS_PER_BAR, totalTicks, type BarCount, type NoteEvent, type ResolvedForm } from './types';

const FORMS = PHRASE_FORM_IDS.filter((f): f is ResolvedForm => f !== 'auto');
const SEEDS = Array.from({ length: 16 }, (_, i) => 31 + i * 104729);

function* cases() {
  for (const style of STYLE_IDS)
    for (const phrase of FORMS)
      for (const bars of [2, 4, 8] as BarCount[])
        for (const seed of SEEDS.slice(0, 4)) yield createSettings({ seed, style, phrase, bars });
}

const inBar = (notes: NoteEvent[], bar: number) =>
  notes.filter((n) => n.start >= bar * TICKS_PER_BAR && n.start < (bar + 1) * TICKS_PER_BAR);

describe('phrasing', () => {
  it('labels one section per bar and covers the loop', () => {
    for (const settings of cases()) {
      const { phrasing } = generateComposition(settings);
      expect(phrasing.form).toBe(settings.phrase);
      expect(phrasing.sections).toHaveLength(settings.bars);
      phrasing.sections.forEach((s, i) => {
        expect(s.start).toBe(i * TICKS_PER_BAR);
        expect(s.duration).toBe(TICKS_PER_BAR);
      });
      expect(phrasing.sections.at(-1)!.start + TICKS_PER_BAR).toBe(totalTicks(settings.bars));
    }
  });

  it('resolves auto to a concrete form that depends on the melody seed', () => {
    const forms = new Set(SEEDS.map((seed) => resolveForm(createSettings({ seed }))));
    expect(forms.has('auto' as never)).toBe(false);
    expect(forms.size).toBeGreaterThan(2);
    for (const seed of SEEDS) {
      const settings = createSettings({ seed });
      expect(generateComposition(settings).phrasing.form).toBe(resolveForm(settings));
    }
  });

  it('answers a call with something different', () => {
    const shape = (ns: NoteEvent[], bar: number) => ns.map((n) => `${n.start - bar * TICKS_PER_BAR}:${n.pitch}`).join();
    for (const style of STYLE_IDS) {
      for (const seed of SEEDS) {
        const { notes, phrasing } = generateComposition(createSettings({ seed, style, phrase: 'callResponse' }));
        const melody = notes.filter((n) => n.track === 'melody');
        phrasing.sections.forEach((s, bar) => {
          if (s.role === 'response') expect(shape(inBar(melody, bar), bar)).not.toBe(shape(inBar(melody, bar - 1), bar - 1));
        });
      }
    }
  });

  it('pushes some downbeats early in UKG but keeps the line monophonic', () => {
    let pushed = 0;
    for (const seed of SEEDS) {
      const melody = generateComposition(createSettings({ seed, style: 'ukg', phrase: 'hook' })).notes.filter((n) => n.track === 'melody');
      pushed += melody.filter((n) => n.start % TICKS_PER_BAR === TICKS_PER_BAR - STEP * 2 && n.duration > STEP * 2).length;
      for (let i = 1; i < melody.length; i++) expect(melody[i].start).toBeGreaterThanOrEqual(melody[i - 1].start + melody[i - 1].duration);
    }
    expect(pushed).toBeGreaterThan(0);
  });
});

describe('vary', () => {
  it('keeps the first half of the bar, so a varied repeat starts like the original', () => {
    const motif = [
      { step: 0, len: 2, deg: 0 },
      { step: 3, len: 2, deg: 2 },
      { step: 6, len: 2, deg: 1 },
      { step: 8, len: 2, deg: 3 },
      { step: 11, len: 2, deg: 2 },
      { step: 14, len: 2, deg: 0 },
    ];
    for (let seed = 1; seed < 40; seed++) {
      const varied = vary(motif, createRng(seed), 1);
      expect(varied.filter((n) => n.step < 6)).toEqual(motif.filter((n) => n.step < 6));
    }
  });
});

describe('riffs', () => {
  it('repeat their notes in two groups, changing pitch once', () => {
    for (const style of STYLE_IDS) {
      for (let seed = 1; seed < 40; seed++) {
        const motif = makeMotif(createRng(seed), STYLES[style], 0.55, 7, { contour: 'riff' });
        expect(motif.filter((n, i) => i > 0 && n.deg !== motif[i - 1].deg).length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('hold a repeated note through the bar, even across the beats', () => {
    const settings = createSettings({ style: 'house' });
    const progression = generateProgression(settings);
    const pool = melodyPool(settings);
    // Three straight eighths, then a group pushed off the beat, a fourth higher.
    const riff = [0, 2, 4, 7, 9, 12].map((step, i) => ({ step, len: 2, deg: i < 3 ? 0 : 3 }));
    for (let start = 3; start < pool.length - 4; start++) {
      for (let bar = 0; bar < settings.bars; bar++) {
        const { notes } = realise({ pool, octave: 7, progression, settings }, riff, bar * TICKS_PER_BAR, start, null);
        expect(new Set(notes.slice(0, 3).map((n) => n.pitch)).size).toBe(1);
        expect(new Set(notes.slice(3).map((n) => n.pitch)).size).toBe(1);
      }
    }
  });
});

describe('motifs', () => {
  const melodyOf = (settings: ReturnType<typeof createSettings>) => generateComposition(settings).notes.filter((n) => n.track === 'melody');
  const headOf = (notes: NoteEvent[], bar: number) =>
    inBar(notes, bar)
      .filter((n) => n.start - bar * TICKS_PER_BAR < TICKS_PER_BAR / 2)
      .map((n) => n.start - bar * TICKS_PER_BAR)
      .join();

  it('keeps coming back to its idea: most bars share their rhythm with another bar', () => {
    for (const style of STYLE_IDS) {
      const recurrence = SEEDS.map((seed) => {
        const settings = createSettings({ style, seed, bars: 8 });
        return melodyMetrics(melodyOf(settings), generateComposition(settings).progression, 8).rhythmRecurrence;
      });
      expect(recurrence.reduce((a, x) => a + x, 0) / recurrence.length, style).toBeGreaterThan(0.5);
    }
  });

  it('builds the second and third bars from the first rather than starting over', () => {
    let related = 0;
    let total = 0;
    for (const style of STYLE_IDS) {
      for (const phrase of ['callResponse', 'hook', 'questionAnswer'] as const) {
        for (const seed of SEEDS) {
          const melody = melodyOf(createSettings({ style, seed, phrase, bars: 4 }));
          const first = headOf(melody, 0);
          total++;
          if ([1, 2].some((bar) => headOf(melody, bar) === first)) related++;
        }
      }
    }
    expect(related / total).toBeGreaterThan(0.7);
  });

  it('leaves the back half of a sparse bar to the counter-melody', () => {
    let sparseBusy = 0;
    let sparseBars = 0;
    let fullBusy = 0;
    let fullBars = 0;
    for (const seed of SEEDS) {
      for (const phrase of ['callResponse', 'questionAnswer'] as const) {
        const settings = createSettings({ style: 'ukg', seed, phrase, bars: 8 });
        const melody = melodyOf(settings);
        makePlan(settings).bars.forEach((bar, i) => {
          // Steps 8–13: the back half, before any push into the next bar.
          const back = inBar(melody, i).filter((n) => n.start % TICKS_PER_BAR >= STEP * 8 && n.start % TICKS_PER_BAR < STEP * 14).length;
          if (bar.melody === 'sparse') [sparseBusy, sparseBars] = [sparseBusy + back, sparseBars + 1];
          else [fullBusy, fullBars] = [fullBusy + back, fullBars + 1];
        });
      }
    }
    expect(sparseBusy / sparseBars).toBeLessThan(0.35);
    expect(fullBusy / fullBars).toBeGreaterThan(1);
  });

  it('keeps the melody when only the chords or the bass are rewritten', () => {
    for (const seed of SEEDS) {
      const settings = createSettings({ seed, bars: 4 });
      const melody = melodyOf(settings);
      const reseeded = { ...settings, trackSeeds: { ...settings.trackSeeds, chords: seed + 1, bass: seed + 2 } };
      expect(melodyOf(reseeded)).toEqual(melody);
    }
  });

  it('keeps a motif’s intervals when it moves to fit a new chord', () => {
    const settings = createSettings({ style: 'ukg' });
    const progression = generateProgression(settings);
    const pool = melodyPool(settings);
    const motif = [0, 3, 6, 10].map((step, i) => ({ step, len: 2, deg: [0, 2, 1, 0][i] }));
    const steps = (bar: number) => {
      const { notes } = realise({ pool, octave: 7, progression, settings }, motif, bar * TICKS_PER_BAR, 8, null);
      return notes.map((n) => pool.indexOf(n.pitch)).map((p, _, all) => p - all[0]);
    };
    // Over each chord the figure keeps its shape in scale steps, unless a strong note had to move.
    let kept = 0;
    for (let bar = 0; bar < settings.bars; bar++) if (JSON.stringify(steps(bar)) === JSON.stringify([0, 2, 1, 0])) kept++;
    expect(kept).toBeGreaterThanOrEqual(settings.bars - 1);
  });
});

describe('trade', () => {
  it('hands the answers to the counter-melody and keeps the two apart', () => {
    for (const style of STYLE_IDS) {
      for (const seed of SEEDS) {
        const { notes, phrasing } = generateComposition(createSettings({ seed, style, phrase: 'trade' }));
        const melody = notes.filter((n) => n.track === 'melody');
        const counter = notes.filter((n) => n.track === 'counter');
        expect(counter.length).toBeGreaterThan(0);
        phrasing.sections.forEach((s, bar) => {
          if (s.voice === 'counter') {
            // The melody only reaches into an answer bar to anticipate the next call.
            for (const m of inBar(melody, bar)) expect(m.start).toBeGreaterThanOrEqual((bar + 1) * TICKS_PER_BAR - STEP * 2);
          } else {
            expect(inBar(counter, bar)).toHaveLength(0);
          }
        });
        for (const c of counter) {
          for (const m of melody) expect(c.start + c.duration <= m.start || m.start + m.duration <= c.start).toBe(true);
        }
      }
    }
  });

  it('re-answers when the melody is regenerated', () => {
    const original = generateComposition(createSettings({ seed: 9, phrase: 'trade' }));
    const next = regenerateTrack(original, 'melody', 77);
    const part = (c: typeof original, track: string) => c.notes.filter((n) => n.track === track);
    expect(part(next, 'counter')).not.toEqual(part(original, 'counter'));
    expect(part(next, 'bass')).toEqual(part(original, 'bass'));
  });
});
