import { describe, expect, it } from 'vitest';
import { AUTOMATION_PARAMS, BASELINE, CUTOFF_HZ, sampleLane, valueAt } from './automation';
import { createSettings, generateComposition, refreshAutomation, regenerateTrack, rerollAutomation, setLaneEnabled } from './generator';
import { STYLE_IDS } from './styles';
import { TRACK_IDS, totalTicks, type BarCount, type StyleId } from './types';

const SEEDS = Array.from({ length: 20 }, (_, i) => 5 + i * 15485863);

function* cases() {
  for (const style of STYLE_IDS) for (const bars of [2, 4, 8] as BarCount[]) for (const seed of SEEDS) yield createSettings({ seed, style, bars });
}

describe('valueAt', () => {
  const points = [
    { tick: 0, value: 0.2 },
    { tick: 100, value: 0.6 },
    { tick: 100, value: 0.1 },
    { tick: 200, value: 0.1 },
  ];

  it('interpolates between breakpoints and holds past the ends', () => {
    expect(valueAt(points, -10)).toBe(0.2);
    expect(valueAt(points, 50)).toBeCloseTo(0.4);
    expect(valueAt(points, 150)).toBeCloseTo(0.1);
    expect(valueAt(points, 999)).toBe(0.1);
  });

  it('samples evenly across the loop', () => {
    expect(sampleLane(points, 200, 50).map((s) => s.tick)).toEqual([0, 50, 100, 150]);
  });
});

describe('suggestAutomation', () => {
  it('is deterministic for a given automation seed', () => {
    expect(generateComposition(createSettings({ seed: 1 })).automation).toEqual(generateComposition(createSettings({ seed: 1 })).automation);
  });

  it('suggests a few distinct lanes with clean curves inside the loop', () => {
    for (const settings of cases()) {
      const { automation, notes } = generateComposition(settings);
      const end = totalTicks(settings.bars);
      expect(automation.length).toBeGreaterThanOrEqual(2);
      expect(automation.length).toBeLessThanOrEqual(4);
      expect(new Set(automation.map((l) => `${l.track}:${l.param}`)).size).toBe(automation.length);
      for (const lane of automation) {
        expect(lane.enabled).toBe(true);
        expect(notes.some((n) => n.track === lane.track)).toBe(true);
        expect(lane.param in AUTOMATION_PARAMS).toBe(true);
        expect(lane.reason.length).toBeGreaterThan(20);
        expect(lane.points[0].tick).toBe(0);
        expect(lane.points.at(-1)!.tick).toBe(end);
        lane.points.forEach((p, i) => {
          expect(p.value).toBeGreaterThanOrEqual(0);
          expect(p.value).toBeLessThanOrEqual(1);
          expect(Number.isInteger(p.tick)).toBe(true);
          if (i) expect(p.tick).toBeGreaterThanOrEqual(lane.points[i - 1].tick);
        });
        // A suggestion should actually move.
        const values = sampleLane(lane.points, end).map((s) => s.value);
        expect(Math.max(...values) - Math.min(...values), lane.id).toBeGreaterThan(0.05);
      }
    }
  });

  it('suits the style', () => {
    const count = (style: StyleId, id: string) =>
      SEEDS.filter((seed) => generateComposition(createSettings({ seed, style })).automation.some((l) => l.id.startsWith(id))).length;
    expect(count('melodicHouse', 'arp-sweep')).toBeGreaterThan(count('ukg', 'arp-sweep'));
    expect(count('deepHouse', 'breathing-filter')).toBeGreaterThan(count('house', 'breathing-filter'));
  });

  it('keeps on/off choices when the music is regenerated', () => {
    const original = generateComposition(createSettings({ seed: 4 }));
    const lane = original.automation[0];
    const off = setLaneEnabled(original, lane.id, false);
    expect(off.automation[0].enabled).toBe(false);
    expect(setLaneEnabled(off, lane.id, false)).toBe(off);
    expect(refreshAutomation(off).automation.find((l) => l.id === lane.id)?.enabled).toBe(false);
    const same = regenerateTrack(off, 'chords', 99).automation.find((l) => l.id === lane.id);
    if (same) expect(same.enabled).toBe(false);
  });

  it('re-rolls to different ideas without touching the notes', () => {
    const original = generateComposition(createSettings({ seed: 4 }));
    const ideas = new Set(SEEDS.map((s) => rerollAutomation(original, s).automation.map((l) => l.id).join()));
    expect(ideas.size).toBeGreaterThan(3);
    expect(rerollAutomation(original, 1).notes).toBe(original.notes);
  });

  it('throws the delay at the end of each call', () => {
    let found = 0;
    for (const seed of SEEDS) {
      const comp = generateComposition(createSettings({ seed, style: 'ukg', phrase: 'callResponse' }));
      const throws = comp.automation.find((l) => l.id.startsWith('delay-throws'));
      if (!throws) continue;
      found++;
      for (const call of comp.phrasing.sections.filter((s) => s.role === 'call')) {
        const last = comp.notes.filter((n) => n.track === 'melody' && n.start >= call.start && n.start < call.start + call.duration).at(-1);
        if (last) expect(valueAt(throws.points, last.start)).toBeGreaterThan(0.5);
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it('has a baseline inside the range for every part and parameter', () => {
    for (const track of TRACK_IDS) {
      for (const v of Object.values(BASELINE[track])) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    expect(CUTOFF_HZ.to(CUTOFF_HZ.from(3400))).toBeCloseTo(3400);
  });
});
