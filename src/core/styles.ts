import type { Extension } from './theory';
import type { ScaleId, StyleId } from './types';

/**
 * Which chord tone a bass hit plays. `approach` steps into the next chord's root from the scale;
 * `chromatic` slides into it from a semitone away.
 */
export type BassTone = 'root' | 'octave' | 'fifth' | 'approach' | 'chromatic';

/** One hit in a one-bar (16-step) pattern. */
export interface Hit {
  step: number;
  len: number;
}

export interface BassHit extends Hit {
  tone: BassTone;
}

export type CounterStyle = 'answer' | 'line' | 'arp';

/** A hi-hat roll: `hits` even strikes across `len` sixteenths from `step` (3 over 2 is a triplet, 4 over 2 is 32nds). */
export interface HatRoll {
  step: number;
  len: number;
  hits: number;
}

export interface DrumPattern {
  kick: number[];
  /** The backbeat: a clap, or a clap over a snare where the kit has one. */
  clap: number[];
  hat: number[];
  openHat: number[];
  rolls?: HatRoll[];
}

export interface StyleDef {
  id: StyleId;
  label: string;
  short: string;
  bpm: number;
  /** Swing percentage, 50 = straight. */
  swing: number;
  defaultScale: ScaleId;
  extension: Extension;
  /** Progressions as 0-based scale degrees, one chord per bar. */
  progressions: { major: number[][]; minor: number[][] };
  /** Bass patterns per density band: [sparse, medium, busy]. */
  bass: [BassHit[][], BassHit[][], BassHit[][]];
  /** Chord rhythms per density band. */
  chords: [Hit[][], Hit[][], Hit[][]];
  /** Relative pull of each sixteenth position on melody onsets. */
  melodyAccent: number[];
  /** Chance that a melody note leaves a gap before the next one. */
  melodyRest: number;
  /** Longest melody note, in steps (cadences excepted). */
  melodyMaxLen: number;
  /** Extra pull toward repeating the previous pitch (vocal-chop feel). */
  repeatPull: number;
  counter: CounterStyle;
  drums: DrumPattern;
}

const b = (step: number, len: number, tone: BassTone = 'root'): BassHit => ({ step, len, tone });
const h = (step: number, len: number): Hit => ({ step, len });
const offbeats = [2, 6, 10, 14];
const fourFloor: DrumPattern = { kick: [0, 4, 8, 12], clap: [4, 12], hat: [], openHat: offbeats };

export const STYLES: Record<StyleId, StyleDef> = {
  ukg: {
    id: 'ukg',
    label: 'UK garage',
    short: 'UKG',
    bpm: 132,
    swing: 60,
    defaultScale: 'minor',
    extension: 5,
    progressions: {
      minor: [
        [0, 3, 0, 3],
        [0, 5, 3, 4],
        [5, 6, 0, 0],
        [0, 6, 5, 3],
        [3, 4, 0, 0],
        [0, 2, 6, 3],
      ],
      major: [
        [1, 4, 0, 5],
        [3, 4, 2, 5],
        [0, 5, 1, 4],
        [5, 1, 3, 4],
      ],
    },
    bass: [
      [[b(0, 6), b(10, 6)], [b(0, 4), b(7, 3), b(10, 6)]],
      [
        [b(0, 4), b(7, 3), b(10, 4, 'octave'), b(14, 2, 'approach')],
        [b(0, 3), b(3, 3), b(6, 2, 'octave'), b(10, 4), b(14, 2, 'approach')],
      ],
      [
        [b(0, 2), b(3, 1), b(6, 2, 'octave'), b(8, 2), b(11, 1), b(14, 2, 'approach')],
        [b(0, 3), b(3, 2, 'octave'), b(7, 1), b(10, 2), b(12, 1, 'fifth'), b(14, 2, 'approach')],
      ],
    ],
    chords: [
      [[h(0, 3), h(10, 4)], [h(3, 3), h(10, 3)]],
      [[h(0, 2), h(3, 2), h(10, 3)], [h(3, 2), h(6, 2), h(10, 3)]],
      [[h(0, 2), h(3, 1), h(6, 2), h(10, 2), h(13, 2)], [h(2, 1), h(3, 2), h(7, 2), h(10, 2), h(14, 1)]],
    ],
    melodyAccent: [1, 0.15, 0.45, 0.75, 0.6, 0.2, 0.75, 0.5, 0.55, 0.2, 0.8, 0.55, 0.6, 0.15, 0.7, 0.45],
    melodyRest: 0.5,
    melodyMaxLen: 4,
    repeatPull: 0.22,
    counter: 'answer',
    drums: { kick: [0, 10], clap: [4, 12], hat: [2, 3, 6, 7, 10, 11, 14, 15], openHat: [] },
  },
  house: {
    id: 'house',
    label: 'House',
    short: 'House',
    bpm: 124,
    swing: 54,
    defaultScale: 'minor',
    extension: 4,
    progressions: {
      minor: [
        [0, 6, 5, 6],
        [0, 5, 2, 6],
        [0, 3, 6, 2],
        [5, 3, 0, 4],
        [0, 2, 6, 5],
      ],
      major: [
        [0, 4, 5, 3],
        [5, 3, 0, 4],
        [0, 3, 5, 4],
        [3, 0, 4, 5],
      ],
    },
    bass: [
      [[b(0, 8), b(8, 8)], [b(0, 6), b(6, 2), b(8, 8)]],
      [[b(2, 2), b(6, 2), b(10, 2), b(14, 2)], [b(0, 3), b(3, 3), b(6, 2, 'octave'), b(8, 3), b(11, 3, 'fifth'), b(14, 2, 'octave')]],
      [
        [b(0, 2), b(2, 2, 'octave'), b(4, 2), b(6, 2, 'octave'), b(8, 2), b(10, 2, 'octave'), b(12, 2), b(14, 2, 'octave')],
        [b(2, 2), b(4, 1), b(6, 2, 'octave'), b(10, 2), b(12, 1), b(14, 2, 'approach')],
      ],
    ],
    chords: [
      [[h(0, 4), h(8, 4)], [h(0, 3), h(6, 4)]],
      [[h(2, 2), h(6, 2), h(10, 2), h(14, 2)], [h(0, 2), h(3, 2), h(6, 3), h(10, 2)]],
      [[h(0, 2), h(2, 2), h(6, 2), h(8, 2), h(10, 2), h(14, 2)], [h(0, 1), h(3, 2), h(6, 2), h(10, 2), h(12, 1), h(14, 2)]],
    ],
    melodyAccent: [1, 0.1, 0.7, 0.2, 0.8, 0.1, 0.8, 0.25, 1, 0.1, 0.7, 0.2, 0.8, 0.1, 0.8, 0.25],
    melodyRest: 0.35,
    melodyMaxLen: 6,
    repeatPull: 0.12,
    counter: 'answer',
    drums: { ...fourFloor, hat: [1, 3, 5, 7, 9, 11, 13, 15] },
  },
  deepHouse: {
    id: 'deepHouse',
    label: 'Deep house',
    short: 'Deep',
    bpm: 122,
    swing: 56,
    defaultScale: 'dorian',
    extension: 5,
    progressions: {
      minor: [
        [0, 3, 0, 3],
        [0, 5, 3, 4],
        [0, 2, 3, 6],
        [3, 4, 0, 0],
        [0, 6, 3, 4],
        [2, 3, 0, 0],
      ],
      major: [
        [1, 4, 0, 0],
        [0, 3, 1, 4],
        [3, 2, 1, 0],
        [0, 5, 3, 1],
      ],
    },
    bass: [
      [[b(0, 6), b(8, 4), b(14, 2, 'approach')], [b(0, 8), b(10, 6)]],
      [[b(0, 4), b(6, 2), b(10, 3, 'fifth'), b(14, 2, 'octave')], [b(0, 2), b(3, 3), b(8, 2), b(11, 3, 'fifth'), b(14, 2, 'octave')]],
      [
        [b(0, 2), b(3, 2), b(6, 1, 'octave'), b(8, 2), b(11, 2), b(14, 2, 'approach')],
        [b(0, 2), b(2, 1, 'octave'), b(6, 2), b(8, 2), b(10, 1, 'octave'), b(13, 3, 'fifth')],
      ],
    ],
    chords: [
      [[h(0, 16)], [h(0, 8), h(10, 6)]],
      [[h(0, 3), h(6, 3), h(10, 6)], [h(0, 6), h(10, 4)]],
      [[h(0, 2), h(3, 3), h(6, 2), h(10, 4)], [h(0, 3), h(6, 2), h(8, 2), h(11, 3), h(14, 2)]],
    ],
    melodyAccent: [1, 0.05, 0.5, 0.15, 0.6, 0.05, 0.6, 0.2, 0.8, 0.05, 0.5, 0.15, 0.6, 0.05, 0.55, 0.2],
    melodyRest: 0.3,
    melodyMaxLen: 8,
    repeatPull: 0.1,
    counter: 'line',
    drums: { ...fourFloor, hat: [2, 6, 10, 14], openHat: [] },
  },
  melodicHouse: {
    id: 'melodicHouse',
    label: 'Melodic house',
    short: 'Melodic',
    bpm: 122,
    swing: 50,
    defaultScale: 'minor',
    extension: 3,
    progressions: {
      minor: [
        [0, 5, 2, 6],
        [5, 6, 0, 0],
        [0, 3, 5, 4],
        [0, 5, 3, 6],
        [0, 6, 5, 4],
        [3, 0, 5, 6],
      ],
      major: [
        [5, 3, 0, 4],
        [0, 4, 5, 3],
        [3, 4, 5, 0],
        [0, 2, 3, 4],
      ],
    },
    bass: [
      [[b(2, 2), b(6, 2), b(10, 2), b(14, 2)], [b(0, 8), b(8, 8)]],
      [
        [b(2, 1), b(3, 1), b(6, 1), b(7, 1), b(10, 1), b(11, 1), b(14, 1), b(15, 1, 'octave')],
        [b(2, 2), b(6, 2), b(10, 2), b(14, 2, 'octave')],
      ],
      [
        [1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15].map((s) => b(s, 1, s === 7 || s === 15 ? 'octave' : 'root')),
        [b(2, 1), b(3, 1), b(6, 1), b(7, 1, 'octave'), b(10, 1), b(11, 1), b(14, 1), b(15, 1, 'octave')],
      ],
    ],
    chords: [
      [[h(0, 16)], [h(0, 8), h(8, 8)]],
      [[h(0, 8), h(8, 8)], [h(0, 6), h(6, 10)]],
      [[h(0, 4), h(4, 4), h(8, 4), h(12, 4)], [h(0, 6), h(6, 6), h(12, 4)]],
    ],
    melodyAccent: [1, 0.1, 0.6, 0.15, 0.75, 0.1, 0.6, 0.15, 0.9, 0.1, 0.6, 0.15, 0.75, 0.1, 0.6, 0.2],
    melodyRest: 0.2,
    melodyMaxLen: 8,
    repeatPull: 0.08,
    counter: 'arp',
    drums: { ...fourFloor, hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
  },
  rap: {
    id: 'rap',
    label: 'Rap & grime',
    short: 'Rap',
    bpm: 140,
    swing: 50,
    defaultScale: 'minor',
    extension: 3,
    progressions: {
      minor: [
        [0, 0, 5, 5],
        [0, 5, 3, 4],
        [0, 3, 0, 5],
        [0, 1, 0, 6],
        [0, 6, 5, 4],
        [5, 6, 0, 0],
      ],
      major: [
        [5, 3, 0, 4],
        [0, 4, 5, 3],
        [5, 5, 3, 4],
      ],
    },
    // 808 lines: long notes that run into each other, so they slide (up an octave, back to the root).
    bass: [
      [[b(0, 10), b(10, 6, 'octave')], [b(0, 16)]],
      [
        [b(0, 6), b(7, 3), b(10, 6, 'octave')],
        [b(0, 3), b(3, 6), b(10, 4, 'fifth'), b(14, 2, 'approach')],
      ],
      [
        [b(0, 3), b(3, 2), b(6, 4, 'octave'), b(10, 2), b(13, 3, 'approach')],
        [b(0, 2), b(3, 2), b(6, 1, 'octave'), b(7, 3), b(10, 2), b(12, 2, 'octave'), b(14, 2, 'approach')],
      ],
    ],
    chords: [
      [[h(0, 16)], [h(0, 8), h(8, 8)]],
      [[h(0, 6), h(8, 6)], [h(0, 3), h(3, 5), h(10, 6)]],
      [[h(0, 2), h(3, 2), h(6, 2), h(10, 2), h(13, 3)], [h(0, 3), h(3, 3), h(6, 4), h(12, 4)]],
    ],
    melodyAccent: [1, 0.1, 0.35, 0.7, 0.3, 0.15, 0.7, 0.3, 0.8, 0.1, 0.6, 0.35, 0.3, 0.15, 0.65, 0.4],
    melodyRest: 0.45,
    melodyMaxLen: 6,
    repeatPull: 0.25,
    counter: 'arp',
    // Half-time: snare on beat three, eighth hats broken up by a triplet and a 32nd roll.
    drums: {
      kick: [0, 10],
      clap: [8],
      hat: [0, 2, 4, 8, 10, 12],
      openHat: [],
      rolls: [
        { step: 6, len: 2, hits: 3 },
        { step: 14, len: 2, hits: 4 },
      ],
    },
  },
};

export const STYLE_IDS = Object.keys(STYLES) as StyleId[];

/** Density 0–1 to a pattern band index. */
export function densityBand(density: number): 0 | 1 | 2 {
  if (density < 0.34) return 0;
  if (density < 0.68) return 1;
  return 2;
}
