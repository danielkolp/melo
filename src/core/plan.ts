import { drumPattern } from './beat';
import { createRng, deriveSeed } from './random';
import { isTurnaround } from './shared';
import type { DrumPattern, Hit } from './styles';
import { STEPS_PER_BAR, type CompositionSettings, type StyleId } from './types';

/**
 * The plan every part follows, made before any notes: what each bar is for, how much the melody
 * plays and who fills the space it leaves, how the energy moves, and how each style's bass and
 * chords sit against its kick. The parts are still written one after another, but they read the
 * same plan, so they leave room for each other rather than all hitting together.
 */

/** A bar's job in its four-bar phrase: state the idea, repeat it, push against it, bring it home. */
export type BarRole = 'statement' | 'repeat' | 'contrast' | 'cadence';
/** How much of the bar the melody takes. A sparse bar plays its idea's head and leaves the rest. */
export type MelodySpace = 'full' | 'sparse';

export interface BarPlan {
  role: BarRole;
  /** 0–1: how hard the bar pushes. Phrases rise to their third bar and settle at the cadence. */
  energy: number;
  melody: MelodySpace;
  /** The counter-melody steps forward in the space a sparse melody leaves. */
  fill: boolean;
  /** The end of a four-bar phrase or the loop, where fills and changes go. */
  turnaround: boolean;
}

export interface MusicPlan {
  drums: DrumPattern;
  bars: BarPlan[];
}

/** Shares of bass onsets on the kick and just after it, and how the line is played. */
export interface BassFeel {
  reinforce: [number, number];
  answer: [number, number];
  /** Most onsets on the backbeat that still sound right. */
  clap: number;
  /** Note length as a share of the gap to the next one; 1 holds on. */
  gate: [number, number];
  /** Chance a loop's bass has a ghost note leading into one of its hits. */
  ghost: number;
  /** Chance the second bar of each pair answers the first, rather than repeating it. */
  answerBar: number;
}

/** Shares of chord onsets off the beat and on the kick, and the most on the backbeat. */
export interface ChordFeel {
  offbeat: [number, number];
  onKick: [number, number];
  clap: number;
}

/**
 * UKG: the bass sits on some kicks and answers the rest a sixteenth or two later, short and
 * bouncing, with a ghost note into the hits; stabs live between the kicks. House: the bass rides
 * the offbeats. Deep house: rounder, held longer. Melodic house: a rolling offbeat bass under
 * chords on the downbeat. Rap: the 808 follows the kick.
 */
export const BASS_FEEL: Record<StyleId, BassFeel> = {
  ukg: { reinforce: [0.3, 0.6], answer: [0.2, 0.5], clap: 0.12, gate: [0.45, 0.7], ghost: 0.75, answerBar: 0.75 },
  house: { reinforce: [0.1, 0.45], answer: [0.45, 0.9], clap: 0.15, gate: [0.5, 0.8], ghost: 0.45, answerBar: 0.6 },
  deepHouse: { reinforce: [0.3, 0.65], answer: [0.25, 0.6], clap: 0.12, gate: [0.75, 0.95], ghost: 0.4, answerBar: 0.6 },
  melodicHouse: { reinforce: [0, 0.3], answer: [0.6, 1], clap: 0.2, gate: [0.55, 0.85], ghost: 0, answerBar: 0.35 },
  rap: { reinforce: [0.45, 0.85], answer: [0.1, 0.45], clap: 0.15, gate: [1, 1], ghost: 0, answerBar: 0.5 },
};

export const CHORD_FEEL: Record<StyleId, ChordFeel> = {
  ukg: { offbeat: [0.6, 1], onKick: [0, 0.4], clap: 0.25 },
  house: { offbeat: [0.5, 1], onKick: [0, 0.5], clap: 0.4 },
  deepHouse: { offbeat: [0.25, 0.8], onKick: [0.2, 0.75], clap: 0.4 },
  melodicHouse: { offbeat: [0, 0.5], onKick: [0.4, 1], clap: 0.5 },
  rap: { offbeat: [0.1, 0.6], onKick: [0.3, 1], clap: 0.5 },
};

/**
 * Where the melody plays in each four-bar phrase, by style. A sparse bar leaves its back half to
 * the counter-melody, so the two take turns instead of talking over each other.
 */
const SPACE: Record<StyleId, MelodySpace[][]> = {
  ukg: [
    ['full', 'sparse', 'full', 'sparse'],
    ['full', 'full', 'full', 'sparse'],
    ['sparse', 'full', 'sparse', 'full'],
  ],
  house: [
    ['full', 'full', 'full', 'sparse'],
    ['full', 'sparse', 'full', 'sparse'],
  ],
  deepHouse: [
    ['full', 'sparse', 'full', 'sparse'],
    ['sparse', 'sparse', 'full', 'sparse'],
  ],
  melodicHouse: [
    ['full', 'full', 'full', 'full'],
    ['full', 'full', 'full', 'sparse'],
  ],
  rap: [
    ['full', 'sparse', 'full', 'sparse'],
    ['full', 'full', 'full', 'sparse'],
  ],
};

const ROLES: BarRole[] = ['statement', 'repeat', 'contrast', 'cadence'];
const ENERGY = [0.55, 0.6, 0.8, 0.65];

export function makePlan(settings: Pick<CompositionSettings, 'style' | 'seed' | 'bars'>): MusicPlan {
  const rng = createRng(deriveSeed(settings.seed, 'plan'));
  const space = rng.pick(SPACE[settings.style]);
  const { bars } = settings;
  return {
    drums: drumPattern(settings),
    bars: Array.from({ length: bars }, (_, bar): BarPlan => {
      // A 2-bar loop states its idea and lands it; longer loops run whole four-bar phrases.
      const slot = bars === 2 ? (bar === 0 ? 0 : 3) : bar % 4;
      const lift = bars === 8 && bar >= 4 ? 0.1 : 0;
      const melody = space[slot];
      return { role: ROLES[slot], energy: Math.min(1, ENERGY[slot] + lift), melody, fill: melody === 'sparse', turnaround: isTurnaround(bar, bars) };
    }),
  };
}

/** How far a share sits outside its window (0 inside it). */
export const outside = (v: number, [lo, hi]: readonly [number, number]) => (v < lo ? lo - v : v > hi ? v - hi : 0);

/** How a one-bar bass rhythm sits against the kick, the backbeat and the chord stabs: 0 is ideal, lower is worse. */
export function bassFit(hits: readonly Hit[], drums: DrumPattern, feel: BassFeel, stabs: ReadonlySet<number> = new Set()): number {
  if (!hits.length) return -2;
  const kicks = new Set(drums.kick);
  const steps = hits.map((h) => h.step);
  const on = steps.filter((s) => kicks.has(s)).length / steps.length;
  const answer = steps.filter((s) => !kicks.has(s) && [1, 2, 3].some((d) => kicks.has(s - d))).length / steps.length;
  const clap = steps.filter((s) => drums.clap.includes(s)).length / steps.length;
  // Some of the bass lands with the stabs, so they feel like one groove, but not all of it.
  const together = stabs.size ? outside(steps.filter((s) => stabs.has(s)).length / steps.length, [0.2, 0.7]) * 0.5 : 0;
  return -(outside(on, feel.reinforce) + outside(answer, feel.answer) + Math.max(0, clap - feel.clap) + together);
}

/** How a one-bar chord rhythm sits against the kick and backbeat: 0 is ideal, lower is worse. */
export function chordFit(hits: readonly Hit[], drums: DrumPattern, feel: ChordFeel, bass: ReadonlySet<number> = new Set()): number {
  if (!hits.length) return -2;
  const steps = hits.map((h) => h.step);
  const share = (test: (s: number) => boolean) => steps.filter(test).length / steps.length;
  const together = bass.size ? outside(share((s) => bass.has(s)), [0.2, 0.7]) * 0.5 : 0;
  return -(
    outside(share((s) => s % 4 !== 0), feel.offbeat) +
    outside(share((s) => drums.kick.includes(s)), feel.onKick) +
    Math.max(0, share((s) => drums.clap.includes(s)) - feel.clap) +
    together
  );
}

/** The sixteenths of a bar a set of notes starts on. */
export function barSteps(starts: readonly number[], stepTicks: number): Set<number> {
  return new Set(starts.map((t) => Math.floor(t / stepTicks) % STEPS_PER_BAR));
}
