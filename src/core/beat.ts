import { createRng, deriveSeed } from './random';
import { STYLES, type DrumPattern, type HatRoll } from './styles';
import type { Transition } from './transition';
import { STEP, STEPS_PER_BAR, type CompositionSettings, type StyleId } from './types';

/**
 * The guide beat as data: one loop's drum hits in straight ticks. The audio
 * engine plays these and the song export writes them, so both agree.
 */

export type DrumVoice = 'kick' | 'clap' | 'hat' | 'openHat';
export const DRUM_VOICES: readonly DrumVoice[] = ['kick', 'clap', 'hat', 'openHat'];

export interface DrumHit {
  /** Straight ticks from the top of the loop (swing is applied when played or written). */
  tick: number;
  voice: DrumVoice;
  /** 0–1. */
  velocity: number;
  /** Part of a hi-hat roll rather than the steady pattern. */
  roll?: true;
  /** Part of the transition at the end of the loop. */
  fill?: true;
}

/**
 * Other figures each style's beat plays, voice by voice, beside the one in its style definition.
 * A loop's beat takes its kick, hats and open hats from these, chosen by the seed, so loops don't
 * all sit on the same groove. The backbeat stays put: it is what makes the style.
 */
const GROOVES: Record<StyleId, { kick: number[][]; hat: number[][]; openHat: number[][]; rolls?: HatRoll[][] }> = {
  ukg: {
    kick: [[0, 7, 10], [0, 10, 13], [0, 3, 10], [0, 6, 10]],
    hat: [[2, 6, 10, 14], [2, 6, 7, 10, 14, 15], [1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15]],
    openHat: [[14], [6, 14]],
  },
  house: {
    kick: [[0, 4, 8, 12, 15], [0, 4, 8, 11, 12]],
    hat: [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [3, 7, 11, 15], []],
    openHat: [[6, 14], [2, 6, 10, 13, 14]],
  },
  deepHouse: {
    kick: [[0, 4, 8, 11, 12], [0, 4, 8, 12, 15]],
    hat: [[2, 6, 10, 13, 14], [2, 3, 6, 7, 10, 11, 14, 15], [1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15]],
    openHat: [[14], [6, 14], [2, 6, 10, 14]],
  },
  melodicHouse: {
    kick: [[0, 4, 8, 12, 14]],
    hat: [[2, 6, 10, 14], [1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15]],
    openHat: [[2, 6, 10, 14], [14]],
  },
  rap: {
    kick: [[0, 3, 10], [0, 6, 10], [0, 7, 11], [0, 10, 13], [0, 3, 11, 14]],
    hat: [[0, 2, 4, 6, 8, 10, 12, 14], [0, 4, 8, 12], [0, 2, 4, 6, 8, 10, 12, 14, 15]],
    openHat: [],
    rolls: [[{ step: 14, len: 2, hits: 3 }], [{ step: 2, len: 2, hits: 3 }, { step: 10, len: 2, hits: 4 }], [{ step: 12, len: 4, hits: 6 }], []],
  },
};

type BeatSettings = Pick<CompositionSettings, 'style' | 'seed' | 'bars'>;

/**
 * The loop's beat: the style's own, with its kick, hats and open hats each swapped, more often than
 * not, for another of the style's figures. The seed decides, so the same loop keeps its beat.
 */
export function drumPattern(settings: Pick<CompositionSettings, 'style' | 'seed'>): DrumPattern {
  const rng = createRng(deriveSeed(settings.seed, 'beat'));
  const own = STYLES[settings.style].drums;
  const other = GROOVES[settings.style];
  const choose = <T,>(staple: T, options: readonly T[]) => (options.length && rng.chance(0.65) ? rng.pick(options) : staple);
  const kick = choose(own.kick, other.kick);
  const openHat = choose(own.openHat, other.openHat);
  const rolls = choose(own.rolls ?? [], other.rolls ?? []);
  // A closed hat makes way for an open one on the same step, and for a roll.
  const rolled = (s: number) => rolls.some((r) => s >= r.step && s < r.step + r.len);
  const hat = choose(own.hat, other.hat).filter((s) => !openHat.includes(s) && !rolled(s));
  return { kick, clap: own.clap, hat, openHat, ...(rolls.length ? { rolls } : {}) };
}

/** Hat velocity by position: offbeat eighths lead, sixteenths fall back, with a little drift so loops breathe. */
export function hatVelocity(bar: number, step: number): number {
  const base = step % 4 === 2 ? 1 : step % 2 === 0 ? 0.72 : 0.58;
  const drift = (((bar * 16 + step) * 2654435761) >>> 0) / 2 ** 32;
  return base * (0.92 + drift * 0.1);
}

/**
 * The beat's share of the loop's transition, in its last bar: which steady hits make way, and what
 * plays instead.
 */
function transitionBeat(t: Transition, bars: number): { replaced: (hit: DrumHit) => boolean; fill: DrumHit[] } {
  const at = (step: number) => ((bars - 1) * STEPS_PER_BAR + step) * STEP;
  const from = at(t.from);
  const hit = (step: number, voice: DrumVoice, velocity: number): DrumHit => ({ tick: at(step), voice, velocity, fill: true });
  switch (t.kind) {
    case 'roll':
      // The claps make way for a roll that speeds from eighths to sixteenths and gets louder.
      return {
        replaced: (h) => h.tick >= from && (h.voice === 'clap' || !!h.roll),
        fill: [8, 10, 12, 13, 14, 15].map((s, i, all) => hit(s, 'clap', 0.45 + (0.55 * i) / (all.length - 1))),
      };
    case 'stop':
      // One hit together, then nothing until bar 1.
      return { replaced: (h) => h.tick >= from, fill: [hit(t.from, 'kick', 1), hit(t.from, 'clap', 1), hit(t.from, 'openHat', 0.8)] };
    case 'lift':
      // No kick for the bar, and sixteenth hats rising into the 1.
      return {
        replaced: (h) => h.tick >= from && (h.voice === 'kick' || (h.tick >= at(8) && (h.voice === 'hat' || h.voice === 'openHat'))),
        fill: Array.from({ length: 8 }, (_, i) => hit(8 + i, 'hat', 0.45 + (0.55 * i) / 7)),
      };
  }
}

export function beatHits(settings: BeatSettings, transition: Transition | null = null): DrumHit[] {
  const { bars } = settings;
  const pattern = drumPattern(settings);
  const hits: DrumHit[] = [];
  for (let bar = 0; bar < bars; bar++) {
    for (const voice of DRUM_VOICES) {
      for (const step of pattern[voice]) {
        const velocity = voice === 'hat' ? hatVelocity(bar, step) : voice === 'openHat' ? 0.8 : 1;
        hits.push({ tick: (bar * STEPS_PER_BAR + step) * STEP, voice, velocity });
      }
    }
    // Rolls build in level across their strikes.
    for (const roll of pattern.rolls ?? []) {
      for (let i = 0; i < roll.hits; i++) {
        const tick = (bar * STEPS_PER_BAR + roll.step + (i * roll.len) / roll.hits) * STEP;
        hits.push({ tick, voice: 'hat', velocity: 0.5 + (0.4 * i) / Math.max(1, roll.hits - 1), roll: true });
      }
    }
  }
  if (!transition) return hits.sort((a, b) => a.tick - b.tick);
  const { replaced, fill } = transitionBeat(transition, bars);
  return [...hits.filter((h) => !replaced(h)), ...fill].sort((a, b) => a.tick - b.tick);
}
