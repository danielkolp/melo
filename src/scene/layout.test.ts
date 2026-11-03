import { describe, expect, it } from 'vitest';
import { PPQ, STEP, TICKS_PER_BAR } from '../core/types';
import { LANE, createLayout, displayRange, noteRect, pitchToZ, tickToX, xToTick, zToPitch } from './layout';

describe('roll layout', () => {
  const layout = createLayout(4);

  it('spans the loop and the default range', () => {
    expect(tickToX(layout, 0)).toBeCloseTo(layout.x0);
    expect(tickToX(layout, 4 * TICKS_PER_BAR)).toBeCloseTo(layout.x1);
    expect(layout.lanes).toBe(48);
    expect(layout.depth).toBeCloseTo(48 * LANE);
  });

  it('round-trips ticks and pitches', () => {
    for (const tick of [0, STEP, PPQ * 3, TICKS_PER_BAR * 2 + STEP * 5]) {
      expect(xToTick(layout, tickToX(layout, tick))).toBeCloseTo(tick, 6);
    }
    for (const pitch of [36, 60, 83]) expect(zToPitch(layout, pitchToZ(layout, pitch))).toBeCloseTo(pitch, 6);
  });

  it('puts higher notes further back', () => {
    expect(pitchToZ(layout, 72)).toBeLessThan(pitchToZ(layout, 60));
    expect(pitchToZ(layout, layout.low)).toBeLessThan(layout.depth / 2);
    expect(pitchToZ(layout, layout.high)).toBeGreaterThan(-layout.depth / 2);
  });

  it('places a note by start, length and pitch', () => {
    const rect = noteRect(layout, { start: PPQ, duration: PPQ, pitch: 60 }, 50);
    expect(rect.x).toBeCloseTo(tickToX(layout, PPQ * 1.5));
    expect(rect.width).toBeCloseTo(layout.beatWidth - 0.012);
    expect(rect.z).toBeCloseTo(pitchToZ(layout, 60));
  });

  it('shifts swung off-sixteenths to the right', () => {
    const straight = noteRect(layout, { start: STEP, duration: STEP, pitch: 60 }, 50);
    const swung = noteRect(layout, { start: STEP, duration: STEP, pitch: 60 }, 62);
    expect(swung.x).toBeGreaterThan(straight.x);
  });

  it('grows the range in whole octaves when notes go outside it', () => {
    expect(displayRange([])).toEqual({ low: 36, high: 83 });
    const n = (pitch: number) => ({ id: '', track: 'bass' as const, pitch, start: 0, duration: STEP, velocity: 1 });
    expect(displayRange([n(30), n(90)])).toEqual({ low: 24, high: 95 });
  });
});
