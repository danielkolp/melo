import { createRng, deriveSeed, type Rng } from './random';
import { STYLES } from './styles';
import {
  SCALES,
  buildChord,
  chromaticNumeral,
  colorChord,
  harmonyPitchClasses,
  romanNumeral,
  type ChordColor,
  type ScaleFamily,
} from './theory';
import { TICKS_PER_BAR, type Chord, type CompositionSettings, type ScaleId, type StyleId } from './types';

/**
 * Harmonic colour, scaled by creativity: progressions beyond each style's staples, richer chord
 * colours, chords borrowed from the parallel mode, and passing chords (secondary dominants,
 * approach chords, suspensions that resolve) on the back half of a bar. At creativity 0 the
 * progression is left exactly as the style's templates make it.
 */

interface Flavour {
  /** Progressions beyond the style's staples, as 0-based scale degrees. */
  bold: Record<ScaleFamily, number[][]>;
  /** Chord colours that suit the style, weighted. */
  colours: [ChordColor, number][];
  /** At full creativity: the share of chords coloured, and the chance one is borrowed from the parallel mode. */
  colour: number;
  borrow: number;
  /** At full creativity: the chance a bar ends on a passing chord, and how often that is a secondary dominant. */
  passing: number;
  secondary: number;
  /** Extra weight for borrowing from these modes (rap leans on the phrygian bII). */
  borrowFrom?: Partial<Record<ScaleId, number>>;
}

const FLAVOUR: Record<StyleId, Flavour> = {
  ukg: {
    bold: {
      minor: [[0, 5, 6, 4], [0, 2, 5, 6], [5, 3, 0, 6], [3, 4, 2, 5]],
      major: [[3, 2, 1, 4], [5, 1, 4, 0], [0, 2, 3, 4]],
    },
    colours: [['ninth', 2], ['eleventh', 1.5], ['sus4', 1.2], ['six', 0.6]],
    colour: 0.7,
    borrow: 0.25,
    passing: 0.45,
    secondary: 1.4,
  },
  house: {
    bold: {
      minor: [[3, 6, 0, 0], [0, 4, 5, 6], [5, 6, 0, 3]],
      major: [[0, 2, 5, 3], [1, 4, 0, 5], [3, 4, 2, 5]],
    },
    colours: [['seventh', 2], ['sus4', 1.5], ['add9', 1.5], ['six', 1]],
    colour: 0.6,
    borrow: 0.25,
    passing: 0.4,
    secondary: 0.8,
  },
  deepHouse: {
    bold: {
      minor: [[0, 1, 3, 0], [3, 0, 6, 0], [0, 4, 3, 2], [1, 4, 0, 3]],
      major: [[1, 2, 3, 4], [3, 0, 1, 4], [5, 1, 4, 0]],
    },
    colours: [['eleventh', 2], ['ninth', 1.5], ['sus4', 1.2], ['six', 1]],
    colour: 0.75,
    borrow: 0.2,
    passing: 0.45,
    secondary: 1.6,
  },
  melodicHouse: {
    bold: {
      minor: [[0, 6, 5, 3], [3, 5, 0, 6], [5, 2, 6, 0]],
      major: [[0, 5, 3, 4], [3, 5, 0, 4], [5, 4, 3, 0]],
    },
    colours: [['add9', 2.5], ['sus2', 2], ['sus4', 1.5]],
    colour: 0.65,
    borrow: 0.3,
    passing: 0.35,
    secondary: 0.4,
  },
  rap: {
    bold: {
      minor: [[0, 4, 5, 4], [0, 6, 5, 6], [5, 4, 0, 0], [0, 3, 5, 1]],
      major: [[0, 5, 3, 3], [5, 3, 4, 4]],
    },
    colours: [['add9', 1.5], ['sus2', 1], ['seventh', 1]],
    colour: 0.4,
    borrow: 0.35,
    passing: 0.3,
    secondary: 0.3,
    borrowFrom: { phrygian: 2.5, harmonicMinor: 1.5 },
  },
};

/** Parallel modes a chord can be borrowed from, by the key's family. */
const BORROW_FROM: Record<ScaleFamily, [ScaleId, number][]> = {
  major: [['minor', 2], ['mixolydian', 1]],
  minor: [['dorian', 1.5], ['harmonicMinor', 1.2], ['phrygian', 0.8]],
};

const mod12 = (n: number) => ((n % 12) + 12) % 12;
const playable = (chord: Pick<Chord, 'quality'>) => chord.quality === 'maj' || chord.quality === 'min';
const sameTones = (a: Pick<Chord, 'tones'>, b: Pick<Chord, 'tones'>) => a.tones.length === b.tones.length && a.tones.every((t, i) => t === b.tones[i]);

export function boldProgressions(style: StyleId, family: ScaleFamily): number[][] {
  return FLAVOUR[style].bold[family];
}

interface Harmony {
  rng: Rng;
  settings: CompositionSettings;
  flavour: Flavour;
  /** The key's seven harmony pitch classes. */
  keyScale: number[];
  extension: 3 | 4 | 5;
}

/** The scale a chord's colours come from: its own if it is borrowed, else the key's. */
const scaleOf = (h: Harmony, chord: Chord) => chord.scale ?? h.keyScale;

function colour(h: Harmony, chord: Chord): Chord {
  const options = h.flavour.colours.filter(([c]) => !(c === 'seventh' && chord.tones.length >= 4));
  for (let tries = 0; tries < 2 && options.length; tries++) {
    const pick = h.rng.weighted(options, options.map(([, w]) => w))[0];
    const coloured = colorChord(chord, pick, scaleOf(h, chord));
    if (coloured) return coloured;
  }
  return chord;
}

/** The same degree taken from a parallel mode (iv or bVI in a major key, IV or V in a minor one). */
function borrow(h: Harmony, chord: Chord): Chord | null {
  const { settings, flavour, rng } = h;
  if (chord.degree === 0) return null;
  const family = SCALES[settings.scale].family;
  const sources = BORROW_FROM[family]
    .map(([scale, w]): [ScaleId, number] => [scale, w * (flavour.borrowFrom?.[scale] ?? 1)])
    .filter(([scale]) => scale !== settings.scale)
    .map(([scale, w]) => ({ scale, w, chord: buildChord(settings.key, scale, chord.degree, h.extension) }))
    .filter((o) => playable(o.chord) && !sameTones(o.chord, chord));
  if (!sources.length) return null;
  const pick = rng.weighted(sources, sources.map((o) => o.w));
  return {
    ...chord,
    ...pick.chord,
    scale: harmonyPitchClasses(settings.key, pick.scale),
    numeral: chromaticNumeral(settings.key, pick.chord.root, pick.chord.quality),
  };
}

/**
 * The dominant of `target` (V/ii, V/vi, or a major V into a minor tonic), if it brings just one
 * note from outside the key: its leading tone.
 */
function secondaryDominant(h: Harmony, target: Chord): Omit<Chord, 'start' | 'duration'> | null {
  if (!playable(target)) return null;
  const root = mod12(target.root + 7);
  const leading = mod12(root + 4);
  const fifth = mod12(root + 7);
  const flat7 = mod12(root + 10);
  const scale = h.keyScale;
  if (!scale.includes(root) || !scale.includes(fifth) || scale.includes(leading)) return null;
  // Over it, the leading tone takes the place of the scale note a semitone below.
  const altered = scale.map((p) => (p === mod12(leading - 1) ? leading : p));
  const tones = [root, leading, fifth];
  if (h.extension >= 4 && altered.includes(flat7)) tones.push(flat7);
  return {
    degree: (target.degree + 4) % 7,
    root,
    tones,
    quality: 'maj',
    scale: altered,
    numeral: (tones.length > 3 ? 'V7' : 'V') + (target.degree === 0 ? '' : `/${romanNumeral(target)}`),
  };
}

/** A diatonic chord a step above or below `target`, leading into it. */
function approachChord(h: Harmony, from: Chord, target: Chord): Omit<Chord, 'start' | 'duration'> | null {
  const { settings, rng } = h;
  const options = [1, 6]
    .map((step) => buildChord(settings.key, settings.scale, (target.degree + step) % 7, h.extension))
    .filter((c) => playable(c) && c.degree !== from.degree && c.degree !== target.degree);
  return options.length ? rng.pick(options) : null;
}

/** Splits a bar: its chord on the front half, something that moves into the next chord on the back half. */
function passing(h: Harmony, chord: Chord, next: Chord): [Chord, Chord] | null {
  const half = chord.duration / 2;
  const back = (c: Omit<Chord, 'start' | 'duration'>): Chord => ({ ...c, start: chord.start + half, duration: half });
  const front = { ...chord, duration: half };
  // A passing chord has to move somewhere: not the chord it follows, and not the one it leads to.
  const moves = (c: Omit<Chord, 'start' | 'duration'>) => c.root !== chord.root && c.root !== next.root;
  const sus = chord.quality === 'sus4' ? null : colorChord(chord, 'sus4', scaleOf(h, chord));
  const kinds: [() => [Chord, Chord] | null, number][] = [
    [
      () => {
        const dominant = secondaryDominant(h, next);
        return dominant && moves(dominant) ? [front, back(dominant)] : null;
      },
      h.flavour.secondary,
    ],
    [
      () => {
        const approach = approachChord(h, chord, next);
        return approach && moves(approach) ? [front, back(approach)] : null;
      },
      1,
    ],
    // A suspension on the downbeat that resolves halfway through the bar.
    [() => sus && [{ ...sus, duration: half }, back(chord)], 0.8],
  ];
  for (let tries = 0; tries < 3; tries++) {
    const made = h.rng.weighted(kinds, kinds.map(([, w]) => w))[0]();
    if (made) return made;
  }
  return null;
}

/**
 * For the second pass of an 8-bar loop: a different chord to end on, sharing at least two notes
 * with the original and not repeating the chord before it.
 */
function twist(h: Harmony, chord: Chord, before: Chord): Chord {
  const borrowed = h.rng.chance(0.5) ? borrow(h, chord) : null;
  if (borrowed && borrowed.root !== before.root) return borrowed;
  const { settings } = h;
  const options = [0, 1, 2, 3, 4, 5, 6]
    .filter((d) => d !== chord.degree && d !== before.degree)
    .map((d) => buildChord(settings.key, settings.scale, d, h.extension))
    .filter((c) => playable(c) && c.tones.slice(0, 3).filter((t) => chord.tones.includes(t)).length >= 2);
  return options.length ? { ...h.rng.pick(options), start: chord.start, duration: chord.duration } : chord;
}

export function colourProgression(settings: CompositionSettings, chords: Chord[], slots: number): Chord[] {
  const c = settings.creativity;
  if (c <= 0) return chords;
  const h: Harmony = {
    rng: createRng(deriveSeed(settings.harmonySeed ?? settings.seed, 'colour')),
    settings,
    flavour: FLAVOUR[settings.style],
    keyScale: harmonyPitchClasses(settings.key, settings.scale),
    extension: STYLES[settings.style].extension,
  };
  const { rng, flavour } = h;

  // One plan per slot of the template, so every pass through the progression sounds the same.
  const plans = Array.from({ length: slots }, () => ({ borrow: rng.chance(flavour.borrow * c), colour: rng.chance(flavour.colour * c) }));
  const coloured = new Map<number, Chord>();
  let out = chords.map((chord, i) => {
    const slot = i % slots;
    const memo = coloured.get(slot);
    if (memo) return { ...memo, start: chord.start, duration: chord.duration };
    let next = chord;
    if (plans[slot].borrow) next = borrow(h, next) ?? next;
    if (plans[slot].colour) next = colour(h, next);
    coloured.set(slot, next);
    return next;
  });

  // An 8-bar loop's second pass can end somewhere new.
  if (out.length === slots * 2 && rng.chance(c * 0.6)) {
    const last = out.length - 1;
    out[last] = twist(h, out[last], out[last - 1]);
  }

  // Passing chords on the back half of a bar, most often at the turnaround.
  if (chords[0].duration === TICKS_PER_BAR) {
    let room = Math.ceil(out.length / 4);
    const split: Chord[] = [];
    out.forEach((chord, i) => {
      const next = out[(i + 1) % out.length];
      const turnaround = i === out.length - 1 || i % 4 === 3;
      const pair = room > 0 && rng.chance(flavour.passing * c * (turnaround ? 1.6 : 0.5)) ? passing(h, chord, next) : null;
      if (pair) room--;
      split.push(...(pair ?? [chord]));
    });
    out = split;
  }
  return out;
}
