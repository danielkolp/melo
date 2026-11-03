import { swungSpan } from '../core/groove';
import { BEATS_PER_BAR, PPQ, totalTicks, type NoteEvent } from '../core/types';

/**
 * Maps musical coordinates to world space. Time runs along +X, pitch along -Z
 * (higher notes further away), so the roll reads left to right like a DAW.
 */

export const LANE = 0.13;
export const NOTE_HEIGHT = 0.12;
export const NOTE_LIFT = 0.03;
export const SLAB_HEIGHT = 0.16;
export const KEY_LENGTH = 1.1;
export const BLACK_KEY_LENGTH = 0.66;
export const KEY_GAP = 0.16;

/** Space around the grid for bar numbers (back) and chord names (front). */
export const TABLE_MARGIN = { back: 0.5, front: 0.5, side: 0.22 };

/** The automation lane that sits in front of the table. */
export const DECK = { gap: 0.2, depth: 0.82, height: 0.07 };

/** Z of the front edge of the table slab, and of the deck's back and front edges. */
export function deckBounds(layout: RollLayout): { back: number; front: number } {
  const back = layout.depth / 2 + TABLE_MARGIN.front + DECK.gap;
  return { back, front: back + DECK.depth };
}

/** Default visible range: C2–B5, which covers every generated register. */
export const DEFAULT_LOW = 36;
export const DEFAULT_HIGH = 83;

export interface RollLayout {
  bars: number;
  totalTicks: number;
  low: number;
  high: number;
  lanes: number;
  beatWidth: number;
  /** Grid width (time axis) and depth (pitch axis). */
  width: number;
  depth: number;
  /** X of tick 0 and of the end of the loop. */
  x0: number;
  x1: number;
  /** X where the keyboard starts (its far-left edge). */
  keyboardX: number;
}

export function beatWidthFor(bars: number): number {
  return bars <= 2 ? 0.9 : bars <= 4 ? 0.62 : 0.42;
}

/** Whole octaves, C to B, wide enough for every note. */
export function displayRange(notes: readonly NoteEvent[]): { low: number; high: number } {
  let low = DEFAULT_LOW;
  let high = DEFAULT_HIGH;
  for (const n of notes) {
    if (n.pitch < low) low = Math.floor(n.pitch / 12) * 12;
    if (n.pitch > high) high = Math.ceil((n.pitch + 1) / 12) * 12 - 1;
  }
  return { low, high };
}

export function createLayout(bars: number, low = DEFAULT_LOW, high = DEFAULT_HIGH): RollLayout {
  const beatWidth = beatWidthFor(bars);
  const width = bars * BEATS_PER_BAR * beatWidth;
  const lanes = high - low + 1;
  const span = KEY_LENGTH + KEY_GAP + width;
  const keyboardX = -span / 2;
  const x0 = keyboardX + KEY_LENGTH + KEY_GAP;
  return { bars, totalTicks: totalTicks(bars), low, high, lanes, beatWidth, width, depth: lanes * LANE, x0, x1: x0 + width, keyboardX };
}

export function tickToX(layout: RollLayout, tick: number): number {
  return layout.x0 + (tick / PPQ) * layout.beatWidth;
}

export function xToTick(layout: RollLayout, x: number): number {
  return ((x - layout.x0) / layout.beatWidth) * PPQ;
}

/** Z of the centre of a pitch's lane. */
export function pitchToZ(layout: RollLayout, pitch: number): number {
  return layout.depth / 2 - (pitch - layout.low + 0.5) * LANE;
}

export function zToPitch(layout: RollLayout, z: number): number {
  return layout.low + (layout.depth / 2 - z) / LANE - 0.5;
}

export interface NoteRect {
  x: number;
  z: number;
  width: number;
  /** Swung start and end, in ticks. */
  start: number;
  end: number;
}

/** Where a note sits on the table, with swing applied so it lines up with what you hear. */
export function noteRect(layout: RollLayout, note: Pick<NoteEvent, 'start' | 'duration' | 'pitch'>, swing: number): NoteRect {
  const span = swungSpan(note.start, note.duration, swing);
  const left = tickToX(layout, span.start);
  const right = tickToX(layout, span.end);
  const width = Math.max(0.04, right - left - 0.012);
  return { x: (left + right) / 2, z: pitchToZ(layout, note.pitch), width, start: span.start, end: span.end };
}
