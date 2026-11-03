import { Midi } from '@tonejs/midi';
import { describe, expect, it } from 'vitest';
import { MAX_NUDGE, perform } from './expression';
import { createSettings, generateComposition } from './generator';
import { swingTick, swungSpan } from './groove';
import { compositionToMidi } from './midi';
import { makePlan } from './plan';
import { STYLE_IDS } from './styles';
import { STEP, TICKS_PER_BAR, TRACK_IDS, type NoteEvent, type TrackId } from './types';

const SEEDS = Array.from({ length: 12 }, (_, i) => 17 + i * 7919);
const ALL = new Set(TRACK_IDS);

const note = (track: TrackId, step: number, len = 1, velocity = 96, pitch = 60): NoteEvent => ({
  id: `${track}-${step}`,
  track,
  pitch,
  start: step * STEP,
  duration: len * STEP,
  velocity,
});

describe('perform', () => {
  it('nudges by whole ticks, never further than the limit', () => {
    for (const style of STYLE_IDS) {
      for (const seed of SEEDS) {
        for (const n of generateComposition(createSettings({ style, seed, bars: 8 })).notes) {
          if (n.nudge === undefined) continue;
          expect(Number.isInteger(n.nudge)).toBe(true);
          expect(n.nudge).not.toBe(0);
          expect(Math.abs(n.nudge)).toBeLessThanOrEqual(MAX_NUDGE);
        }
      }
    }
  });

  it('pushes UKG chord stabs early, the ones off the beat further than the downbeats', () => {
    const settings = createSettings({ style: 'ukg' });
    const [down, off] = perform(settings, [note('chords', 0), note('chords', 3)], ALL);
    expect(off.nudge).toBeLessThan(0);
    expect(down.nudge).toBeLessThan(0);
    expect(Math.abs(off.nudge!)).toBeGreaterThan(Math.abs(down.nudge!));
  });

  it('lays a deep house melody back and keeps rap tight', () => {
    const [deep] = perform(createSettings({ style: 'deepHouse' }), [note('melody', 3)], ALL);
    expect(deep.nudge).toBeGreaterThan(0);
    const [bass] = perform(createSettings({ style: 'rap' }), [note('bass', 3, 4)], ALL);
    expect(bass.nudge).toBeUndefined();
  });

  it('follows the plan: louder bars play louder, and the part keeps its overall level', () => {
    const settings = createSettings({ style: 'ukg', bars: 4 });
    const { bars } = makePlan(settings);
    const notes = bars.map((_, bar) => note('melody', bar * 16 + 2, 2));
    const played = perform(settings, notes, ALL);
    for (let a = 0; a < bars.length; a++) {
      for (let b = 0; b < bars.length; b++) {
        if (bars[a].energy > bars[b].energy) expect(played[a].velocity).toBeGreaterThan(played[b].velocity);
      }
    }
    const mean = (ns: NoteEvent[]) => ns.reduce((s, n) => s + n.velocity, 0) / ns.length;
    expect(Math.abs(mean(played) - mean(notes))).toBeLessThanOrEqual(1);
  });

  it('clips short UKG chord stabs but leaves held chords and one-step hits alone', () => {
    const settings = createSettings({ style: 'ukg' });
    const [stab, held, hit] = perform(settings, [note('chords', 2, 4), note('chords', 0, 16), note('chords', 7, 1)], ALL);
    expect(stab.duration).toBe(3 * STEP);
    expect(held.duration).toBe(16 * STEP);
    expect(hit.duration).toBe(STEP);
  });

  it('drags ghost notes late without changing how soft they are', () => {
    const settings = createSettings({ style: 'ukg', bars: 4 });
    const ghost = note('bass', 6 + TICKS_PER_BAR / STEP * 2, 1, 63);
    const [played] = perform(settings, [ghost], ALL);
    expect(played.velocity).toBe(63);
    expect(played.nudge).toBeGreaterThan(0);
  });

  it('leaves parts it was not asked to touch exactly as they were', () => {
    const settings = createSettings({ style: 'ukg' });
    const notes = [note('chords', 3, 4), note('melody', 5, 2)];
    expect(perform(settings, notes, new Set<TrackId>(['bass']))).toEqual(notes);
  });

  it('is deterministic', () => {
    const settings = createSettings({ style: 'house', seed: 99, bars: 8 });
    expect(generateComposition(settings).notes).toEqual(generateComposition(settings).notes);
  });
});

describe('phrasing', () => {
  it('holds a sung note into the beat across a sixteenth, and lets a long note go before a rest', () => {
    const settings = createSettings({ style: 'house' });
    // A held note a sixteenth short of the beat, then a long note before a long rest, then one more.
    const [into, , long] = perform(settings, [note('melody', 0, 3), note('melody', 4, 2), note('melody', 8, 4), note('melody', 16, 2)], ALL);
    expect(into.duration).toBe(4 * STEP);
    expect(long.duration).toBe(3 * STEP);
  });

  it('keeps grace notes short, leaves the gap when another line plays in it, and keeps rap tight', () => {
    const house = createSettings({ style: 'house' });
    const [grace] = perform(house, [note('melody', 1, 2), note('melody', 4, 2)], ALL);
    expect(grace.duration).toBe(2 * STEP);
    const [gapped] = perform(house, [note('melody', 0, 3), note('melody', 4, 2), note('counter', 3, 1, 90, 55)], ALL);
    expect(gapped.duration).toBe(3 * STEP);
    const [rap] = perform(createSettings({ style: 'rap' }), [note('melody', 0, 3), note('melody', 4, 2)], ALL);
    expect(rap.duration).toBe(3 * STEP);
  });
});

describe('nudge in playback and export', () => {
  it('moves both ends of a swung note, so it keeps its length', () => {
    const plain = swungSpan(STEP * 3, STEP * 2, 62);
    const late = swungSpan(STEP * 3, STEP * 2, 62, 10);
    expect(late.start).toBe(plain.start + 10);
    expect(late.end).toBe(plain.end + 10);
    // Never before the start of the loop.
    expect(swungSpan(0, STEP, 50, -12).start).toBe(0);
  });

  it('writes the nudge into the MIDI file after swing', () => {
    const composition = generateComposition(createSettings({ style: 'ukg', seed: 5, swing: 62 }));
    const nudged = composition.notes.find((n) => n.nudge && n.start > 0 && (n.start / STEP) % 2 === 1)!;
    expect(nudged).toBeDefined();
    const notes = new Midi(compositionToMidi(composition)).tracks.flatMap((t) => t.notes);
    const at = Math.round(swingTick(nudged.start, 62) + nudged.nudge!);
    expect(notes.some((n) => n.ticks === at && n.midi === nudged.pitch)).toBe(true);
  });
});
