import { describe, expect, it } from 'vitest';
import { bassTakes, createSettings, generateBass, generateChords, generateComposition, generateProgression, regenerateTrack } from './generator';
import { toggleLock } from './locks';
import { generateMelody, melodyTakes } from './melody';
import { pickTake, scoreBass, scoreBrass, scoreChords, scoreCounter, scoreMelody } from './score';
import { STYLE_IDS } from './styles';
import { topTakes } from './takes';
import { STEP, TICKS_PER_BAR, type NoteEvent } from './types';

const SEEDS = Array.from({ length: 10 }, (_, i) => 13 + i * 7919);
const shape = (notes: readonly NoteEvent[]) => notes.map((n) => `${n.start}:${n.pitch}:${n.duration}`).join();

describe('scoring', () => {
  it('gives the same score to the same notes', () => {
    const settings = createSettings({ seed: 5, style: 'ukg' });
    const { notes, progression } = generateComposition(settings);
    const melody = notes.filter((n) => n.track === 'melody');
    expect(scoreMelody(melody, progression, settings)).toBe(scoreMelody([...melody], progression, settings));
    const bass = notes.filter((n) => n.track === 'bass');
    expect(scoreBass(bass, settings)).toBe(scoreBass([...bass], settings));
  });

  it('does not reward the plainest line', () => {
    for (const style of STYLE_IDS) {
      const settings = createSettings({ seed: 9, style });
      const progression = generateProgression(settings);
      const root = progression[0].root + 72;
      // One note, every beat, every bar: as repetitive and as consonant-by-default as a line gets.
      const plain = Array.from({ length: settings.bars * 4 }, (_, i): NoteEvent => ({
        id: `p${i}`,
        track: 'melody',
        pitch: root,
        start: i * STEP * 4,
        duration: STEP * 2,
        velocity: 96,
      }));
      const written = generateMelody(settings, progression).notes;
      expect(scoreMelody(written, progression, settings), style).toBeGreaterThan(scoreMelody(plain, progression, settings));
    }
  });
});

describe('choosing takes', () => {
  it('keeps the best-scoring melody of those as busy as the seed’s own', () => {
    let improved = 0;
    for (const style of STYLE_IDS) {
      for (const seed of SEEDS) {
        const settings = createSettings({ seed, style, bars: 8 });
        const progression = generateProgression(settings);
        const takes = melodyTakes(settings, progression);
        const chosen = generateMelody(settings, progression);
        const best = pickTake(takes);
        expect(shape(chosen.notes)).toBe(shape(best.notes));
        const base = takes[0].notes.length;
        for (const t of takes) {
          if (Math.abs(t.notes.length - base) <= Math.max(2, base * 0.15)) expect(best.score).toBeGreaterThanOrEqual(t.score);
        }
        if (best.score > takes[0].score) improved++;
        // Every take keeps the seed's phrase form.
        expect(new Set(takes.map((t) => t.phrasing.form)).size).toBe(1);
      }
    }
    expect(improved).toBeGreaterThan(STYLE_IDS.length * 2);
  });

  it('keeps the best-scoring bassline', () => {
    for (const style of STYLE_IDS) {
      for (const seed of SEEDS.slice(0, 4)) {
        const settings = createSettings({ seed, style });
        const progression = generateProgression(settings);
        const chords = generateChords(settings, progression);
        expect(shape(generateBass(settings, progression, chords))).toBe(shape(pickTake(bassTakes(settings, progression, chords)).notes));
      }
    }
  });

  it('writes an 8-bar loop well inside the time budget', () => {
    const runs = STYLE_IDS.flatMap((style) => SEEDS.slice(0, 4).map((seed) => createSettings({ seed, style, bars: 8 })));
    generateComposition(runs[0]);
    const t0 = performance.now();
    for (const settings of runs) generateComposition(settings);
    expect((performance.now() - t0) / runs.length).toBeLessThan(50);
  });
});

describe('topTakes', () => {
  it('offers distinct takes, best first, each one what the dice would load', () => {
    for (const track of ['melody', 'bass'] as const) {
      for (const seed of SEEDS.slice(0, 3)) {
        const c = generateComposition(createSettings({ seed, style: 'ukg', bars: 4 }));
        const takes = topTakes(c, track);
        expect(takes.length).toBeGreaterThan(1);
        const current = shape(c.notes.filter((n) => n.track === track));
        expect(new Set([current, ...takes.map((t) => shape(t.notes))]).size).toBe(takes.length + 1);
        for (let i = 1; i < takes.length; i++) expect(takes[i - 1].score).toBeGreaterThanOrEqual(takes[i].score);
        const loaded = regenerateTrack(c, track, takes[0].seed).notes.filter((n) => n.track === track);
        expect(shape(loaded)).toBe(shape(takes[0].notes));
        expect(takes.every((t) => t.label.length > 0 && t.notes.every((n) => n.start < 4 * TICKS_PER_BAR))).toBe(true);
      }
    }
  });

  it('offers takes on every part, and none on a locked one', () => {
    const c = generateComposition(createSettings({ seed: 3 }));
    for (const track of ['counter', 'brass', 'chords'] as const) {
      const takes = topTakes(c, track);
      expect(takes.length, track).toBeGreaterThan(1);
      expect(takes.every((t) => Number.isFinite(t.score)), track).toBe(true);
      for (let i = 1; i < takes.length; i++) expect(takes[i - 1].score).toBeGreaterThanOrEqual(takes[i].score);
    }
    expect(topTakes(toggleLock(c, 'melody'), 'melody')).toEqual([]);
    expect(topTakes(c, 'melody')).toEqual(topTakes(c, 'melody'));
  });

  it('scores the accompaniment for how it sits with the melody', () => {
    const c = generateComposition(createSettings({ seed: 8, style: 'house' }));
    const part = (t: string) => c.notes.filter((n) => n.track === t);
    const melody = part('melody');
    // A line that just shadows the melody an octave above it, or chords pushed over it, score worse.
    const shadow = melody.map((n) => ({ ...n, pitch: n.pitch + 12 }));
    const up = (ns: NoteEvent[]) => ns.map((n) => ({ ...n, pitch: n.pitch + 24 }));
    expect(scoreCounter(part('counter'), melody, 4)).toBeGreaterThan(scoreCounter(shadow, melody, 4));
    expect(scoreBrass(part('brass'), melody, part('chords'), 4)).toBeGreaterThan(scoreBrass(shadow, melody, part('chords'), 4));
    expect(scoreChords(part('chords'), melody, c.settings)).toBeGreaterThan(scoreChords(up(part('chords')), melody, c.settings));
  });
});
