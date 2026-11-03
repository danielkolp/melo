import type { Chord, ChordQuality, ScaleId } from './types';

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];

export type ScaleFamily = 'major' | 'minor';

export interface ScaleDef {
  id: ScaleId;
  label: string;
  /** Pitch classes melodies are drawn from, relative to the tonic. */
  intervals: readonly number[];
  /** Seven-note scale chords are built from. Equals `intervals` for heptatonic scales. */
  harmony: readonly number[];
  family: ScaleFamily;
  /** Which mode of the major scale `harmony` is (0 = ionian … 5 = aeolian). Drives key signatures. */
  modeOfMajor: number;
}

function modeOf(n: number): number[] {
  return MAJOR.map((_, i) => (MAJOR[(i + n) % 7] - MAJOR[n] + 12) % 12);
}

export const SCALES: Record<ScaleId, ScaleDef> = {
  minor: { id: 'minor', label: 'Minor', intervals: modeOf(5), harmony: modeOf(5), family: 'minor', modeOfMajor: 5 },
  dorian: { id: 'dorian', label: 'Dorian', intervals: modeOf(1), harmony: modeOf(1), family: 'minor', modeOfMajor: 1 },
  phrygian: { id: 'phrygian', label: 'Phrygian', intervals: modeOf(2), harmony: modeOf(2), family: 'minor', modeOfMajor: 2 },
  harmonicMinor: {
    id: 'harmonicMinor',
    label: 'Harmonic minor',
    intervals: [0, 2, 3, 5, 7, 8, 11],
    harmony: [0, 2, 3, 5, 7, 8, 11],
    family: 'minor',
    modeOfMajor: 5,
  },
  minorPentatonic: {
    id: 'minorPentatonic',
    label: 'Minor pentatonic',
    intervals: [0, 3, 5, 7, 10],
    harmony: modeOf(5),
    family: 'minor',
    modeOfMajor: 5,
  },
  major: { id: 'major', label: 'Major', intervals: MAJOR, harmony: MAJOR, family: 'major', modeOfMajor: 0 },
  lydian: { id: 'lydian', label: 'Lydian', intervals: modeOf(3), harmony: modeOf(3), family: 'major', modeOfMajor: 3 },
  mixolydian: {
    id: 'mixolydian',
    label: 'Mixolydian',
    intervals: modeOf(4),
    harmony: modeOf(4),
    family: 'major',
    modeOfMajor: 4,
  },
  majorPentatonic: {
    id: 'majorPentatonic',
    label: 'Major pentatonic',
    intervals: [0, 2, 4, 7, 9],
    harmony: MAJOR,
    family: 'major',
    modeOfMajor: 0,
  },
};

export const SCALE_IDS = Object.keys(SCALES) as ScaleId[];

const mod12 = (n: number) => ((n % 12) + 12) % 12;

/** Pitch classes available to melodic parts. */
export function scalePitchClasses(key: number, scale: ScaleId): number[] {
  return SCALES[scale].intervals.map((i) => mod12(key + i));
}

/** Pitch classes of the seven-note harmonic parent scale. */
export function harmonyPitchClasses(key: number, scale: ScaleId): number[] {
  return SCALES[scale].harmony.map((i) => mod12(key + i));
}

/** Ascending MIDI pitches whose pitch class is in `pitchClasses`, within [low, high]. */
export function pitchesInRange(pitchClasses: readonly number[], low: number, high: number): number[] {
  const set = new Set(pitchClasses.map(mod12));
  const out: number[] = [];
  for (let p = low; p <= high; p++) if (set.has(mod12(p))) out.push(p);
  return out;
}

/** Number of chord tones to stack: 3 = triads, 4 = sevenths, 5 = ninths. */
export type Extension = 3 | 4 | 5;

/**
 * Diatonic chord on `degree`, stacked in thirds. Sevenths and ninths are only
 * added where they are idiomatic (no m(maj7), +maj7 or flat-nine colours).
 */
export function buildChord(
  key: number,
  scale: ScaleId,
  degree: number,
  extension: Extension,
): Omit<Chord, 'start' | 'duration'> {
  const parent = SCALES[scale].harmony;
  const tone = (step: number) => mod12(key + parent[(degree + step) % 7]);
  const root = tone(0);
  const third = tone(2);
  const fifth = tone(4);
  const i3 = mod12(third - root);
  const i5 = mod12(fifth - root);
  let quality: ChordQuality = 'maj';
  if (i3 === 3 && i5 === 7) quality = 'min';
  else if (i3 === 3 && i5 === 6) quality = 'dim';
  else if (i3 === 4 && i5 === 8) quality = 'aug';

  const tones = [root, third, fifth];
  if (extension >= 4) {
    const seventh = tone(6);
    const i7 = mod12(seventh - root);
    const idiomatic =
      (quality === 'maj' && (i7 === 10 || i7 === 11)) || ((quality === 'min' || quality === 'dim') && i7 === 10);
    if (idiomatic) {
      tones.push(seventh);
      const ninth = tone(1);
      if (extension >= 5 && quality !== 'dim' && mod12(ninth - root) === 2) tones.push(ninth);
    }
  }
  return { degree, root, tones, quality };
}

const SF_BY_MAJOR_TONIC = [0, -5, 2, -3, 4, -1, -6, 1, -4, 3, -2, 5];

/** MIDI key signature: sharps (positive) or flats (negative), and the minor flag. */
export function keySignature(key: number, scale: ScaleId): { sharps: number; minor: boolean } {
  const def = SCALES[scale];
  const relativeMajor = mod12(key - MAJOR[def.modeOfMajor]);
  return { sharps: SF_BY_MAJOR_TONIC[relativeMajor], minor: def.modeOfMajor === 5 };
}

export function prefersFlats(key: number, scale: ScaleId): boolean {
  return keySignature(key, scale).sharps < 0;
}

export function pitchClassName(pc: number, flats = false): string {
  return (flats ? FLAT_NAMES : SHARP_NAMES)[mod12(pc)];
}

/** Scientific pitch name; 60 = C4. */
export function noteName(pitch: number, flats = false): string {
  return `${pitchClassName(pitch, flats)}${Math.floor(pitch / 12) - 1}`;
}

export function keyLabel(key: number, scale: ScaleId): string {
  return `${pitchClassName(key, prefersFlats(key, scale))} ${SCALES[scale].label.toLowerCase()}`;
}

export function chordSymbol(chord: Pick<Chord, 'root' | 'tones' | 'quality'>, flats = false): string {
  const name = pitchClassName(chord.root, flats);
  const has = (interval: number) => chord.tones.some((t) => mod12(t - chord.root) === interval);
  const seventh = has(11) ? 11 : has(10) ? 10 : null;
  if (chord.quality === 'dim') return seventh ? `${name}m7b5` : `${name}°`;
  if (chord.quality === 'aug') return `${name}+`;
  if (chord.quality === 'sus2' || chord.quality === 'sus4') {
    return name + (seventh === 10 ? '7' : seventh === 11 ? 'maj7' : '') + chord.quality;
  }
  const m = chord.quality === 'min' ? 'm' : '';
  const ninth = has(2);
  const eleventh = has(5);
  if (seventh) {
    const top = eleventh ? '11' : ninth ? '9' : '7';
    return name + m + (seventh === 11 ? 'maj' : '') + top;
  }
  if (has(9)) return `${name}${m}6${ninth ? '/9' : ''}`;
  if (ninth) return `${name}${m ? 'm(add9)' : 'add9'}`;
  return name + m;
}

const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

export function romanNumeral(chord: Pick<Chord, 'degree' | 'quality' | 'numeral'>): string {
  if (chord.numeral) return chord.numeral;
  const n = NUMERALS[chord.degree % 7];
  if (chord.quality === 'min') return n.toLowerCase();
  if (chord.quality === 'dim') return `${n.toLowerCase()}°`;
  if (chord.quality === 'aug') return `${n}+`;
  if (chord.quality === 'sus2' || chord.quality === 'sus4') return `${n}sus`;
  return n;
}

const CHROMATIC_NUMERALS = ['I', 'bII', 'II', 'bIII', 'III', 'IV', '#IV', 'V', 'bVI', 'VI', 'bVII', 'VII'];

/** Roman numeral for any root relative to the tonic, flats marked (bVI, bII…); lower case when minor. */
export function chromaticNumeral(key: number, root: number, quality: ChordQuality): string {
  const n = CHROMATIC_NUMERALS[mod12(root - key)];
  return quality === 'min' || quality === 'dim' ? n.toLowerCase() : n;
}

/** Colours a chord can take beyond its plain triad or seventh. */
export type ChordColor = 'seventh' | 'ninth' | 'eleventh' | 'add9' | 'six' | 'sus2' | 'sus4';

/**
 * The chord with a colour applied, drawing the added tones from `scale` (the seven pitch classes
 * it lives in). Returns null where the colour doesn't suit (a flat nine, a sus over a flat
 * fifth, a seventh that would make m(maj7)…).
 */
export function colorChord<C extends Pick<Chord, 'root' | 'tones' | 'quality'>>(chord: C, color: ChordColor, scale: readonly number[]): C | null {
  if (chord.quality !== 'maj' && chord.quality !== 'min') return null;
  const at = scale.indexOf(chord.root);
  if (at < 0 || scale.length !== 7) return null;
  // The scale tone `steps` above the root, and its interval.
  const above = (steps: number) => {
    const tone = scale[(at + steps) % 7];
    return { tone, interval: mod12(tone - chord.root) };
  };
  const [root, third, fifth] = chord.tones;
  const second = above(1);
  const fourth = above(3);
  const sixth = above(5);
  const seventh = above(6);
  const seventhOk = chord.quality === 'maj' ? seventh.interval === 10 || seventh.interval === 11 : seventh.interval === 10;
  const ninthOk = second.interval === 2;
  switch (color) {
    case 'seventh':
      return seventhOk ? { ...chord, tones: [root, third, fifth, seventh.tone] } : null;
    case 'ninth':
      return seventhOk && ninthOk ? { ...chord, tones: [root, third, fifth, seventh.tone, second.tone] } : null;
    case 'eleventh':
      return chord.quality === 'min' && seventhOk && ninthOk && fourth.interval === 5
        ? { ...chord, tones: [root, third, fifth, seventh.tone, second.tone, fourth.tone] }
        : null;
    case 'add9':
      return ninthOk ? { ...chord, tones: [root, third, fifth, second.tone] } : null;
    case 'six':
      return sixth.interval === 9 ? { ...chord, tones: [root, third, fifth, sixth.tone] } : null;
    case 'sus2':
      return ninthOk && mod12(fifth - root) === 7 ? { ...chord, quality: 'sus2', tones: [root, second.tone, fifth] } : null;
    case 'sus4':
      // A seventh stays (7sus4 is a staple); a ninth would blur the suspension.
      if (fourth.interval !== 5 || mod12(fifth - root) !== 7) return null;
      return { ...chord, quality: 'sus4', tones: [root, fourth.tone, fifth, ...(chord.tones.length >= 4 && seventhOk ? [seventh.tone] : [])] };
  }
}

export function isBlackKey(pitch: number): boolean {
  return [1, 3, 6, 8, 10].includes(mod12(pitch));
}
