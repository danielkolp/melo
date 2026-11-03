import { describe, expect, it } from 'vitest';
import { swingTick, unswingTick } from './groove';
import { createRng, deriveSeed, formatSeed, parseSeed } from './random';
import {
  buildChord,
  chordSymbol,
  chromaticNumeral,
  colorChord,
  keyLabel,
  keySignature,
  noteName,
  pitchesInRange,
  romanNumeral,
  scalePitchClasses,
} from './theory';
import { formatPosition, lengthLabel, midiFileName } from './format';
import { createSettings } from './generator';
import { STEP } from './types';

describe('theory', () => {
  it('names pitches with C4 = 60', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(66)).toBe('F#4');
    expect(noteName(70, true)).toBe('Bb4');
    expect(noteName(21)).toBe('A0');
  });

  it('builds scales from the tonic', () => {
    expect(scalePitchClasses(6, 'minor')).toEqual([6, 8, 9, 11, 1, 2, 4]);
    expect(scalePitchClasses(2, 'dorian')).toEqual([2, 4, 5, 7, 9, 11, 0]);
    expect(pitchesInRange([0, 4, 7], 60, 72)).toEqual([60, 64, 67, 72]);
  });

  it('stacks diatonic chords in thirds with idiomatic extensions', () => {
    expect(buildChord(0, 'major', 0, 3)).toMatchObject({ root: 0, tones: [0, 4, 7], quality: 'maj' });
    expect(buildChord(6, 'minor', 0, 3)).toMatchObject({ root: 6, tones: [6, 9, 1], quality: 'min' });
    expect(chordSymbol(buildChord(0, 'major', 0, 4))).toBe('Cmaj7');
    expect(chordSymbol(buildChord(0, 'major', 4, 4))).toBe('G7');
    expect(chordSymbol(buildChord(9, 'minor', 0, 5))).toBe('Am9');
    expect(chordSymbol(buildChord(0, 'major', 6, 4))).toBe('Bm7b5');
    // No m(maj7) on the harmonic-minor tonic: stays a triad.
    expect(buildChord(9, 'harmonicMinor', 0, 4).tones).toHaveLength(3);
    // Harmonic minor gets a true dominant seventh.
    expect(chordSymbol(buildChord(9, 'harmonicMinor', 4, 4))).toBe('E7');
    // No flat nine on a phrygian tonic.
    expect(buildChord(4, 'phrygian', 0, 5).tones).toHaveLength(4);
  });

  it('labels numerals by quality', () => {
    expect(romanNumeral({ degree: 0, quality: 'min' })).toBe('i');
    expect(romanNumeral({ degree: 5, quality: 'maj' })).toBe('VI');
    expect(romanNumeral({ degree: 1, quality: 'dim' })).toBe('ii°');
    expect(romanNumeral({ degree: 3, quality: 'sus4' })).toBe('IVsus');
    expect(romanNumeral({ degree: 5, quality: 'maj', numeral: 'bVI' })).toBe('bVI');
    expect(chromaticNumeral(0, 8, 'maj')).toBe('bVI');
    expect(chromaticNumeral(9, 10, 'maj')).toBe('bII');
  });

  it('colours chords from their scale, and names the result', () => {
    const major = scalePitchClasses(0, 'major');
    const c = buildChord(0, 'major', 0, 3);
    const am = buildChord(9, 'minor', 0, 3);
    const minor = scalePitchClasses(9, 'minor');
    expect(chordSymbol(colorChord(c, 'add9', major)!)).toBe('Cadd9');
    expect(chordSymbol(colorChord(c, 'sus4', major)!)).toBe('Csus4');
    expect(chordSymbol(colorChord(c, 'sus2', major)!)).toBe('Csus2');
    expect(chordSymbol(colorChord(c, 'six', major)!)).toBe('C6');
    expect(chordSymbol(colorChord(am, 'eleventh', minor)!)).toBe('Am11');
    expect(chordSymbol(colorChord(am, 'add9', minor)!)).toBe('Am(add9)');
    expect(chordSymbol(colorChord(buildChord(0, 'major', 4, 4), 'sus4', major)!)).toBe('G7sus4');
    // No flat nine: E minor in C major has an F above its root.
    expect(colorChord(buildChord(0, 'major', 2, 3), 'add9', major)).toBeNull();
  });

  it('computes key signatures', () => {
    expect(keySignature(5, 'minor')).toEqual({ sharps: -4, minor: true });
    expect(keySignature(6, 'minor')).toEqual({ sharps: 3, minor: true });
    expect(keySignature(2, 'dorian')).toEqual({ sharps: 0, minor: false });
    expect(keySignature(7, 'major')).toEqual({ sharps: 1, minor: false });
    expect(keyLabel(3, 'minor')).toBe('Eb minor');
    expect(keyLabel(6, 'minor')).toBe('F# minor');
  });
});

describe('random', () => {
  it('is reproducible and uniform-ish', () => {
    const a = createRng(5);
    const b = createRng(5);
    const xs = Array.from({ length: 1000 }, () => a.next());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b.next()));
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('derives distinct stable seeds', () => {
    expect(deriveSeed(1, 'melody')).toBe(deriveSeed(1, 'melody'));
    expect(deriveSeed(1, 'melody')).not.toBe(deriveSeed(1, 'bass'));
    expect(deriveSeed(1, 'melody')).not.toBe(deriveSeed(2, 'melody'));
  });

  it('formats and parses seeds', () => {
    expect(formatSeed(0x7f3a21c9)).toBe('7F3A21C9');
    expect(parseSeed('7f3a21c9')).toBe(0x7f3a21c9);
    expect(parseSeed('0x00ff')).toBe(255);
    expect(parseSeed('nope')).toBeNull();
    expect(parseSeed('123456789')).toBeNull();
  });
});

describe('groove', () => {
  it('leaves straight time and on-beat sixteenths alone', () => {
    expect(swingTick(STEP, 50)).toBe(STEP);
    expect(swingTick(0, 62)).toBe(0);
    expect(swingTick(STEP * 2, 62)).toBe(STEP * 2);
    expect(swingTick(STEP * 6, 62)).toBe(STEP * 6);
  });

  it('pushes off-sixteenths late by the swing amount', () => {
    // At 66.67% the off-sixteenth lands on the triplet: 2/3 of an eighth.
    expect(swingTick(STEP, 200 / 3)).toBeCloseTo((STEP * 2 * 2) / 3, 6);
    expect(swingTick(STEP * 3, 60)).toBeCloseTo(STEP * 2 + STEP * 2 * 0.6, 6);
  });

  it('inverts cleanly and is monotonic', () => {
    let prev = -1;
    for (let t = 0; t <= STEP * 8; t += 7) {
      const s = swingTick(t, 61);
      expect(s).toBeGreaterThan(prev);
      expect(unswingTick(s, 61)).toBeCloseTo(t, 6);
      prev = s;
    }
  });
});

describe('format', () => {
  it('formats positions and lengths', () => {
    expect(formatPosition(0)).toBe('1.1.1');
    expect(formatPosition(STEP * 21)).toBe('2.2.2');
    expect(lengthLabel(STEP * 2)).toBe('1/8');
    expect(lengthLabel(STEP * 5)).toBe('5/16');
    expect(lengthLabel(STEP * 32)).toBe('2 bars');
  });

  it('builds a descriptive file name', () => {
    const name = midiFileName('Late Night Idea!', createSettings({ key: 6, scale: 'harmonicMinor', bpm: 132, seed: 0xc4c2b4c9 }));
    expect(name).toBe('late-night-idea_ukg_Fs-harmonic-minor_132bpm_seed-C4C2B4C9.mid');
    expect(parseSeed(name.match(/seed-(\w+)\.mid$/)![1])).toBe(0xc4c2b4c9);
  });
});
