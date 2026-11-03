import { STEP } from './types';

const PAIR = STEP * 2;
const MIN_SWING = 50;
const MAX_SWING = 75;

function swingOffset(swing: number): number {
  const amount = Math.min(MAX_SWING, Math.max(MIN_SWING, swing));
  return (amount / 100) * PAIR - STEP;
}

/**
 * Maps a straight tick to its swung position. Each pair of sixteenths is
 * stretched piecewise-linearly so the off-sixteenth lands `swing`% of the way
 * through the pair. Continuous and monotonic, so note ends map cleanly too.
 */
export function swingTick(tick: number, swing: number): number {
  const offset = swingOffset(swing);
  if (offset === 0) return tick;
  const base = Math.floor(tick / PAIR) * PAIR;
  const p = tick - base;
  if (p <= STEP) return base + (p * (STEP + offset)) / STEP;
  return base + STEP + offset + ((p - STEP) * (STEP - offset)) / STEP;
}

/** Inverse of `swingTick`. */
export function unswingTick(tick: number, swing: number): number {
  const offset = swingOffset(swing);
  if (offset === 0) return tick;
  const base = Math.floor(tick / PAIR) * PAIR;
  const p = tick - base;
  const mid = STEP + offset;
  if (p <= mid) return base + (p * STEP) / mid;
  return base + STEP + ((p - mid) * STEP) / (STEP - offset);
}

/** Swung start and end of a note, in ticks. */
export function swungSpan(start: number, duration: number, swing: number): { start: number; end: number } {
  return { start: swingTick(start, swing), end: swingTick(start + duration, swing) };
}
