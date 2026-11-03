import { describe, expect, it } from 'vitest';
import {
  REGISTERS,
  chordAt,
  counterStyle,
  createSettings,
  generateComposition,
  generateProgression,
  regenerateTrack,
} from './generator';
import { bassMetrics } from './score';
import { isTurnaround } from './shared';
import { STYLE_IDS } from './styles';
import { SCALE_IDS, harmonyPitchClasses, scalePitchClasses } from './theory';
import { chordSymbol } from './theory';
import { STEP, TICKS_PER_BAR, TRACK_IDS, totalTicks, type BarCount, type Chord, type NoteEvent, type StyleId, type TrackId } from './types';

const pc = (p: number) => ((p % 12) + 12) % 12;
const byTrack = (notes: NoteEvent[], track: TrackId) => notes.filter((n) => n.track === track);
/** What suits a moment: the key's pitch classes, plus the scale a borrowed or secondary chord brings. */
const suits = (keyPcs: number[], chord: Chord) => new Set([...keyPcs, ...(chord.scale ?? [])]);
/** A chromatic approach: short, off the beat, and sliding a semitone into the next note right after it. */
const approaches = (n: NoteEvent, next: NoteEvent | undefined) =>
  !!next && n.duration <= STEP * 2 && n.start % (STEP * 4) !== 0 && next.start - (n.start + n.duration) <= STEP && Math.abs(next.pitch - n.pitch) === 1;
const SEEDS = Array.from({ length: 24 }, (_, i) => 1000 + i * 7919);

/** Every style × scale × bar-count combination over a spread of seeds. */
function* corpus() {
  for (const style of STYLE_IDS)
    for (const scale of SCALE_IDS)
      for (const bars of [2, 4, 8] as BarCount[])
        for (const seed of SEEDS.slice(0, 4))
          yield createSettings({ style, scale, bars, seed, key: seed % 12, density: (seed % 10) / 10, creativity: (seed % 3) / 2 });
}

describe('determinism', () => {
  it('produces identical output for identical settings', () => {
    const settings = createSettings({ seed: 42, style: 'deepHouse' });
    expect(generateComposition(settings)).toEqual(generateComposition(settings));
  });

  it('produces different material for different seeds', () => {
    const a = generateComposition(createSettings({ seed: 1 }));
    const b = generateComposition(createSettings({ seed: 2 }));
    expect(a.notes).not.toEqual(b.notes);
  });

  it('derives per-track seeds from the master seed', () => {
    const s = createSettings({ seed: 99 });
    expect(new Set(Object.values(s.trackSeeds)).size).toBe(TRACK_IDS.length);
    expect(createSettings({ seed: 99 }).trackSeeds).toEqual(s.trackSeeds);
  });
});

describe('structural invariants', () => {
  it('keeps every note inside the loop, on the grid and in valid MIDI ranges', () => {
    for (const settings of corpus()) {
      const { notes } = generateComposition(settings);
      const end = totalTicks(settings.bars);
      for (const n of notes) {
        expect(n.start).toBeGreaterThanOrEqual(0);
        expect(n.duration).toBeGreaterThanOrEqual(STEP);
        expect(n.start + n.duration).toBeLessThanOrEqual(end);
        expect(n.start % STEP).toBe(0);
        expect(n.duration % STEP).toBe(0);
        expect(n.velocity).toBeGreaterThanOrEqual(1);
        expect(n.velocity).toBeLessThanOrEqual(127);
      }
    }
  });

  it('gives every note a unique id', () => {
    for (const settings of corpus()) {
      const { notes } = generateComposition(settings);
      expect(new Set(notes.map((n) => n.id)).size).toBe(notes.length);
    }
  });

  it('writes every part in its register', () => {
    for (const settings of corpus()) {
      const { notes } = generateComposition(settings);
      for (const n of notes) {
        const { low, high } = REGISTERS[n.track];
        expect(n.pitch, `${n.track} ${n.pitch}`).toBeGreaterThanOrEqual(low);
        expect(n.pitch, `${n.track} ${n.pitch}`).toBeLessThanOrEqual(high);
      }
    }
  });

  it('keeps the melody, counter-melody and bass monophonic', () => {
    for (const settings of corpus()) {
      const { notes } = generateComposition(settings);
      for (const track of ['melody', 'counter', 'bass'] as const) {
        const line = byTrack(notes, track).sort((a, b) => a.start - b.start);
        for (let i = 1; i < line.length; i++) {
          expect(line[i].start, `${track} overlap`).toBeGreaterThanOrEqual(line[i - 1].start + line[i - 1].duration);
        }
      }
    }
  });

  it('generates something for every part', () => {
    for (const settings of corpus()) {
      const { notes } = generateComposition(settings);
      for (const track of TRACK_IDS) expect(byTrack(notes, track).length, track).toBeGreaterThan(0);
    }
  });
});

describe('harmony', () => {
  it('builds one chord per bar (two in a 2-bar loop) at creativity 0', () => {
    expect(generateProgression(createSettings({ bars: 4, creativity: 0 }))).toHaveLength(4);
    expect(generateProgression(createSettings({ bars: 8, creativity: 0 }))).toHaveLength(8);
    const short = generateProgression(createSettings({ bars: 2, creativity: 0 }));
    expect(short).toHaveLength(4);
    expect(short[1].start).toBe(TICKS_PER_BAR / 2);
  });

  it('fills the loop end to end, splitting bars no finer than in half', () => {
    for (const settings of corpus()) {
      const progression = generateProgression(settings);
      progression.forEach((chord, i) => {
        expect(chord.start).toBe(i === 0 ? 0 : progression[i - 1].start + progression[i - 1].duration);
        expect([TICKS_PER_BAR, TICKS_PER_BAR / 2]).toContain(chord.duration);
      });
      const last = progression[progression.length - 1];
      expect(last.start + last.duration).toBe(totalTicks(settings.bars));
    }
  });

  it('takes chord tones from the key, or from the scale a borrowed or secondary chord brings', () => {
    for (const settings of corpus()) {
      const key = harmonyPitchClasses(settings.key, settings.scale);
      for (const chord of generateProgression(settings)) {
        const allowed = new Set(chord.scale ?? key);
        for (const t of chord.tones) expect(allowed.has(t), chordSymbol(chord)).toBe(true);
        // A chord from outside the key says where it comes from.
        if (chord.tones.some((t) => !key.includes(t))) expect(chord.numeral).toBeDefined();
      }
    }
  });

  it('avoids diminished and augmented chords in every style and mode', () => {
    for (const settings of corpus()) {
      for (const chord of generateProgression(settings)) expect(['maj', 'min', 'sus2', 'sus4'], `${settings.style} ${settings.scale}`).toContain(chord.quality);
    }
  });

  it('uses extended chords for deep house and triads for melodic house', () => {
    const deep = generateProgression(createSettings({ style: 'deepHouse', scale: 'dorian' }));
    expect(deep.some((c) => c.tones.length >= 4)).toBe(true);
    const melodic = generateProgression(createSettings({ style: 'melodicHouse', creativity: 0 }));
    expect(melodic.every((c) => c.tones.length === 3)).toBe(true);
  });
});

describe('creativity', () => {
  const sample = (creativity: number) =>
    SEEDS.flatMap((seed) => STYLE_IDS.map((style) => generateComposition(createSettings({ seed, style, creativity, bars: 8 }))));

  it('stays inside the key at 0: no borrowed chords, every melody note in the scale', () => {
    for (const comp of sample(0)) {
      expect(comp.progression.every((c) => !c.scale && !c.numeral)).toBe(true);
      const allowed = new Set(scalePitchClasses(comp.settings.key, comp.settings.scale));
      expect(byTrack(comp.notes, 'melody').every((n) => allowed.has(pc(n.pitch)))).toBe(true);
    }
  });

  it('widens the harmony as it rises: more chord colours, borrowed and passing chords', () => {
    const harmony = (creativity: number) => {
      const comps = sample(creativity);
      return {
        symbols: new Set(comps.flatMap((c) => c.progression.map((ch) => chordSymbol(ch).replace(/^[A-G][#b]?/, '')))).size,
        outside: comps.flatMap((c) => c.progression).filter((ch) => ch.numeral).length,
        passing: comps.flatMap((c) => c.progression).filter((ch) => ch.duration < TICKS_PER_BAR).length,
      };
    };
    const safe = harmony(0);
    const wild = harmony(1);
    expect(wild.symbols).toBeGreaterThan(safe.symbols + 3);
    expect(wild.outside).toBeGreaterThan(10);
    expect(wild.passing).toBeGreaterThan(10);
    expect(safe.passing).toBe(0);
  });

  it('decorates the melody and moves the bass more as it rises', () => {
    const count = (creativity: number) => {
      let chromatic = 0;
      let bassNotes = 0;
      for (const comp of sample(creativity)) {
        const key = scalePitchClasses(comp.settings.key, comp.settings.scale);
        chromatic += byTrack(comp.notes, 'melody').filter((n) => !suits(key, chordAt(comp.progression, n.start)).has(pc(n.pitch))).length;
        bassNotes += new Set(byTrack(comp.notes, 'bass').map((n) => `${n.start % TICKS_PER_BAR}:${pc(n.pitch)}`)).size;
      }
      return { chromatic, bassNotes };
    };
    const safe = count(0);
    const wild = count(1);
    expect(safe.chromatic).toBe(0);
    expect(wild.chromatic).toBeGreaterThan(20);
    expect(wild.bassNotes).toBeGreaterThan(safe.bassNotes);
  });
});

describe('melody', () => {
  it('stays in the scale, apart from chromatic approaches and the notes a borrowed chord brings', () => {
    for (const settings of corpus()) {
      const key = scalePitchClasses(settings.key, settings.scale);
      const { notes, progression } = generateComposition(settings);
      const melody = byTrack(notes, 'melody');
      melody.forEach((n, i) => {
        if (suits(key, chordAt(progression, n.start)).has(pc(n.pitch))) return;
        expect(approaches(n, melody[i + 1]), `${settings.style} ${n.start} ${n.pitch}`).toBe(true);
      });
    }
  });

  it('lands on chord tones on beats 1 and 3, or holds a suspension the next note resolves by step', () => {
    let strong = 0;
    let suspended = 0;
    let unresolved = 0;
    for (const settings of corpus()) {
      const { notes, progression } = generateComposition(settings);
      const melody = byTrack(notes, 'melody');
      const tone = (n: NoteEvent) => chordAt(progression, n.start).tones.includes(pc(n.pitch));
      melody.forEach((n, i) => {
        if (n.start % (STEP * 8) !== 0) return;
        strong++;
        if (tone(n)) return;
        const next = melody[i + 1];
        if (next && Math.abs(next.pitch - n.pitch) <= 2 && tone(next)) suspended++;
        else unresolved++;
      });
    }
    // Tension is allowed, a little of it, and it resolves.
    expect(suspended / strong).toBeLessThan(0.2);
    expect(unresolved / strong).toBeLessThan(0.02);
  });

  it('resolves the phrase on a chord tone of the final chord', () => {
    for (const settings of corpus()) {
      const { notes, progression, phrasing } = generateComposition(settings);
      // In a trade the counter-melody has the last word.
      const voice = phrasing.sections[phrasing.sections.length - 1].voice;
      const line = byTrack(notes, voice);
      const last = line[line.length - 1];
      expect(chordAt(progression, last.start).tones.slice(0, 3)).toContain(pc(last.pitch));
    }
  });

  it('moves mostly by step', () => {
    let steps = 0;
    let leaps = 0;
    for (const settings of corpus()) {
      const melody = byTrack(generateComposition(settings).notes, 'melody');
      for (let i = 1; i < melody.length; i++) {
        if (Math.abs(melody[i].pitch - melody[i - 1].pitch) <= 4) steps++;
        else leaps++;
      }
    }
    // Riffs and pedal figures jump between repeated notes on purpose, so a third of moves may leap.
    expect(steps / (steps + leaps)).toBeGreaterThan(0.62);
  });

  it('gets busier as density rises', () => {
    const count = (density: number) =>
      SEEDS.reduce(
        (sum, seed) => sum + byTrack(generateComposition(createSettings({ seed, density })).notes, 'melody').length,
        0,
      );
    expect(count(0.9)).toBeGreaterThan(count(0.1) * 1.5);
  });
});

describe('counter-melody', () => {
  it('stays in the scale (or a borrowed chord\'s) and sits below the melody where they overlap', () => {
    for (const settings of corpus()) {
      const { notes, progression } = generateComposition(settings);
      const key = scalePitchClasses(settings.key, settings.scale);
      const melody = byTrack(notes, 'melody');
      for (const c of byTrack(notes, 'counter')) {
        expect(suits(key, chordAt(progression, c.start)).has(pc(c.pitch))).toBe(true);
        const above = melody.find((m) => m.start <= c.start && c.start < m.start + m.duration);
        if (above) expect(c.pitch).toBeLessThan(above.pitch - 1);
      }
    }
  });
});

describe('bass', () => {
  it('plays the chord root first in every chord', () => {
    for (const settings of corpus()) {
      const { notes, progression } = generateComposition(settings);
      const bass = byTrack(notes, 'bass');
      for (const chord of progression) {
        const first = bass.find((n) => n.start >= chord.start && n.start < chord.start + chord.duration);
        expect(first, 'bass note in chord').toBeDefined();
        expect(pc(first!.pitch)).toBe(chord.root);
      }
    }
  });

  it('plays from the harmonic scale, or slides a semitone into the next chord', () => {
    for (const settings of corpus()) {
      const key = harmonyPitchClasses(settings.key, settings.scale);
      const { notes, progression } = generateComposition(settings);
      const bass = byTrack(notes, 'bass');
      bass.forEach((n, i) => {
        if (suits(key, chordAt(progression, n.start)).has(pc(n.pitch))) return;
        // It leads into the first note of the next chord, a semitone away.
        const next = bass[i + 1] ?? bass[0];
        expect([1, 11], `${settings.style} ${n.start}`).toContain(Math.abs(pc(next.pitch) - pc(n.pitch)));
        expect(chordAt(progression, next.start)).not.toBe(chordAt(progression, n.start));
      });
    }
  });
});

describe('chords', () => {
  it('voices each chord from its own tones, even when it is pushed ahead of the bar', () => {
    for (const settings of corpus()) {
      const { notes, progression } = generateComposition(settings);
      for (const n of byTrack(notes, 'chords')) {
        const own = [chordAt(progression, n.start), chordAt(progression, n.start + STEP * 2)].flatMap((c) => c.tones);
        expect(own).toContain(pc(n.pitch));
      }
    }
  });
});

describe('planning', () => {
  /** Whole-bar chords away from the ends of phrases, where every bar should be played alike. */
  const steadyBars = (progression: readonly Chord[], bars: number) =>
    progression
      .filter((c) => c.duration === TICKS_PER_BAR && !isTurnaround(c.start / TICKS_PER_BAR, bars))
      .map((c) => c.start / TICKS_PER_BAR);
  const rhythm = (notes: NoteEvent[], from: number, to: number) =>
    [...new Set(notes.filter((n) => n.start >= from && n.start < to).map((n) => `${n.start - from}:${n.duration}`))].join();

  it('plays the bass as a two-bar figure away from the ends of phrases', () => {
    for (const settings of corpus()) {
      const { notes, progression } = generateComposition(settings);
      const bass = byTrack(notes, 'bass');
      // Every first bar of a pair alike, and every second bar alike.
      for (const parity of [0, 1]) {
        const bars = steadyBars(progression, settings.bars).filter((b) => b % 2 === parity);
        const shapes = new Set(bars.map((b) => rhythm(bass, b * TICKS_PER_BAR, (b + 1) * TICKS_PER_BAR)));
        expect(shapes.size, `${settings.style} ${settings.seed}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('plays the chords the same way in every bar away from the ends of phrases', () => {
    for (const settings of corpus()) {
      const { notes, progression } = generateComposition(settings);
      // A hit pushed ahead of the bar belongs to the chord it plays.
      const owner = (n: NoteEvent) => chordAt(progression, n.start + STEP * 2);
      const steady = steadyBars(progression, settings.bars).filter((b) => b > 0 && steadyBars(progression, settings.bars).includes(b - 1));
      const shapes = new Set(
        steady.map((b) => {
          const chord = chordAt(progression, b * TICKS_PER_BAR);
          const hits = byTrack(notes, 'chords').filter((n) => owner(n) === chord);
          return [...new Set(hits.map((n) => `${n.start - chord.start}:${n.duration}`))].join();
        }),
      );
      expect(shapes.size, `${settings.style} ${settings.seed}`).toBeLessThanOrEqual(1);
    }
  });

  it('gives the counter-melody one figure, started in the same places every bar', () => {
    for (const settings of corpus()) {
      const { notes, phrasing } = generateComposition(settings);
      const kind = counterStyle(settings);
      if (phrasing.form === 'trade' || kind === 'arp') continue;
      const onsets = new Set(byTrack(notes, 'counter').map((n) => n.start % TICKS_PER_BAR));
      expect(onsets.size).toBeLessThanOrEqual(kind === 'line' ? 3 : 6);
    }
  });

  it('lands some of the bass with the chord stabs, but not all of it', () => {
    let together = 0;
    let apart = 0;
    for (const settings of corpus()) {
      const { notes } = generateComposition(settings);
      const stabs = new Set(byTrack(notes, 'chords').map((n) => n.start));
      for (const n of byTrack(notes, 'bass')) (stabs.has(n.start) ? together++ : apart++);
    }
    const share = together / (together + apart);
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.75);
  });
});

describe('groove', () => {
  const metrics = (style: StyleId) =>
    SEEDS.map((seed) => {
      const settings = createSettings({ style, seed, bars: 8, key: seed % 12 });
      return bassMetrics(byTrack(generateComposition(settings).notes, 'bass'), settings, 8);
    });
  const avg = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;

  it('sits the UKG bass on some kicks, answers others and stays off the backbeat', () => {
    const m = metrics('ukg');
    expect(avg(m.map((x) => x.reinforce))).toBeGreaterThan(0.25);
    expect(avg(m.map((x) => x.reinforce))).toBeLessThan(0.65);
    expect(avg(m.map((x) => x.answer))).toBeGreaterThan(0.15);
    expect(avg(m.map((x) => x.onClap))).toBeLessThan(0.1);
    // A two-bar figure: the second bar answers the first in most loops.
    expect(avg(m.map((x) => x.period1))).toBeLessThan(0.8);
    expect(avg(m.map((x) => x.period2))).toBeGreaterThan(0.85);
  });

  it('gives each style its own bass against the kick', () => {
    const reinforce = (style: StyleId) => avg(metrics(style).map((x) => x.reinforce));
    const answer = (style: StyleId) => avg(metrics(style).map((x) => x.answer));
    // House rides the offbeats; melodic house rolls between the kicks; the 808 follows the kick.
    expect(answer('house')).toBeGreaterThan(0.5);
    expect(reinforce('melodicHouse')).toBeLessThan(0.3);
    expect(reinforce('rap')).toBeGreaterThan(reinforce('house'));
  });

  it('plays ghost notes quietly and short, at most one a bar, only where the style has them', () => {
    let ghosts = 0;
    for (const settings of corpus()) {
      const bass = byTrack(generateComposition(settings).notes, 'bass');
      const quiet = bass.filter((n) => n.velocity < 72);
      for (const n of quiet) {
        expect(n.duration).toBe(STEP);
        expect(n.velocity).toBeLessThan(Math.min(...bass.filter((b) => b.velocity >= 72).map((b) => b.velocity)));
      }
      const perBar = new Map<number, number>();
      for (const n of quiet) perBar.set(Math.floor(n.start / TICKS_PER_BAR), (perBar.get(Math.floor(n.start / TICKS_PER_BAR)) ?? 0) + 1);
      expect(Math.max(0, ...perBar.values())).toBeLessThanOrEqual(1);
      if (settings.style === 'rap' || settings.style === 'melodicHouse') expect(quiet).toHaveLength(0);
      ghosts += quiet.length;
    }
    expect(ghosts).toBeGreaterThan(0);
  });

  it('keeps the chords under the melody wherever they sound together', () => {
    for (const settings of corpus()) {
      const { notes } = generateComposition(settings);
      const melody = byTrack(notes, 'melody');
      let over = 0;
      const chords = byTrack(notes, 'chords');
      for (const c of chords) if (melody.some((m) => m.start < c.start + c.duration && m.start + m.duration > c.start && c.pitch >= m.pitch)) over++;
      expect(over / Math.max(1, chords.length), `${settings.style} ${settings.seed}`).toBeLessThan(0.05);
    }
  });
});

describe('variety', () => {
  const firstBar = (notes: NoteEvent[], track: TrackId) =>
    [...new Set(byTrack(notes, track).filter((n) => n.start < TICKS_PER_BAR).map((n) => `${n.start}:${n.duration}`))].join();

  it('gives different seeds different bass and chord rhythms', () => {
    for (const style of STYLE_IDS) {
      const comps = SEEDS.map((seed) => generateComposition(createSettings({ style, seed, bars: 8 })));
      for (const track of ['bass', 'chords'] as const) {
        const counts = new Map<string, number>();
        for (const { notes } of comps) counts.set(firstBar(notes, track), (counts.get(firstBar(notes, track)) ?? 0) + 1);
        expect(counts.size, `${style} ${track}`).toBeGreaterThanOrEqual(10);
        expect(Math.max(...counts.values()), `${style} ${track}`).toBeLessThanOrEqual(SEEDS.length / 3);
      }
    }
  });

  it('plays every kind of counter-melody in every style, each loop sticking to one', () => {
    for (const style of STYLE_IDS) {
      const kinds = new Set(Array.from({ length: 60 }, (_, seed) => counterStyle(createSettings({ style, seed }))));
      expect([...kinds].sort(), style).toEqual(['answer', 'arp', 'line']);
      const settings = createSettings({ style, seed: 3 });
      expect(counterStyle(settings)).toBe(counterStyle(settings));
    }
  });
});

describe('regenerateTrack', () => {
  it('replaces one part and leaves the others untouched', () => {
    const original = generateComposition(createSettings({ seed: 7, phrase: 'callResponse' }));
    const next = regenerateTrack(original, 'melody', 123456);
    expect(byTrack(next.notes, 'melody')).not.toEqual(byTrack(original.notes, 'melody'));
    for (const track of ['counter', 'chords', 'bass'] as const) {
      expect(byTrack(next.notes, track)).toEqual(byTrack(original.notes, track));
    }
    expect(next.progression).toEqual(original.progression);
    expect(next.settings.trackSeeds.melody).toBe(123456);
  });

  it('is deterministic for a given seed', () => {
    const original = generateComposition(createSettings({ seed: 7 }));
    expect(regenerateTrack(original, 'bass', 5)).toEqual(regenerateTrack(original, 'bass', 5));
  });
});
