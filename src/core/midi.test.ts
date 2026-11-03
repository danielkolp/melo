import { Midi } from '@tonejs/midi';
import { describe, expect, it } from 'vitest';
import { createSettings, generateComposition } from './generator';
import { swingTick } from './groove';
import { AUTOMATION_PARAMS, valueAt } from './automation';
import { TRACK_MIDI, compositionToMidi, encodeVlq } from './midi';
import { PPQ, TRACK_IDS, totalTicks, type Composition } from './types';

const straight = (overrides = {}) => generateComposition(createSettings({ seed: 11, swing: 50, ...overrides }));

describe('encodeVlq', () => {
  it.each([
    [0, [0x00]],
    [0x40, [0x40]],
    [0x7f, [0x7f]],
    [0x80, [0x81, 0x00]],
    [0x2000, [0xc0, 0x00]],
    [0x3fff, [0xff, 0x7f]],
    [0x4000, [0x81, 0x80, 0x00]],
    [0x1fffff, [0xff, 0xff, 0x7f]],
    [0x200000, [0x81, 0x80, 0x80, 0x00]],
    [0x0fffffff, [0xff, 0xff, 0xff, 0x7f]],
  ])('encodes %i', (value, bytes) => {
    expect(encodeVlq(value)).toEqual(bytes);
  });

  it('rejects values outside the format', () => {
    expect(() => encodeVlq(-1)).toThrow(RangeError);
    expect(() => encodeVlq(0x10000000)).toThrow(RangeError);
    expect(() => encodeVlq(1.5)).toThrow(RangeError);
  });
});

describe('compositionToMidi', () => {
  it('writes a format-1 header with one track per part plus a conductor track', () => {
    const bytes = compositionToMidi(straight());
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('MThd');
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(4)).toBe(6);
    expect(view.getUint16(8)).toBe(1); // format
    expect(view.getUint16(10)).toBe(TRACK_IDS.length + 1);
    expect(view.getUint16(12)).toBe(PPQ);
  });

  it('has chunk lengths that add up to the file size', () => {
    const bytes = compositionToMidi(straight());
    const view = new DataView(bytes.buffer);
    let offset = 14;
    let chunks = 0;
    while (offset < bytes.length) {
      expect(String.fromCharCode(...bytes.slice(offset, offset + 4))).toBe('MTrk');
      const len = view.getUint32(offset + 4);
      // Every track ends with an end-of-track meta event.
      expect([...bytes.slice(offset + 8 + len - 3, offset + 8 + len)]).toEqual([0xff, 0x2f, 0x00]);
      offset += 8 + len;
      chunks++;
    }
    expect(offset).toBe(bytes.length);
    expect(chunks).toBe(TRACK_IDS.length + 1);
  });

  it('round-trips every note through an independent parser', () => {
    const composition = straight({ style: 'house', bpm: 124 });
    const midi = new Midi(compositionToMidi(composition, { title: 'Round trip' }));

    expect(midi.header.ppq).toBe(PPQ);
    expect(midi.header.tempos[0].bpm).toBeCloseTo(124, 1);
    expect(midi.header.timeSignatures[0].timeSignature).toEqual([4, 4]);

    const noteTracks = midi.tracks.filter((t) => t.notes.length > 0);
    expect(noteTracks.map((t) => t.name)).toEqual(TRACK_IDS.map((id) => TRACK_MIDI[id].name));

    TRACK_IDS.forEach((id, i) => {
      const track = noteTracks[i];
      expect(track.channel).toBe(TRACK_MIDI[id].channel);
      expect(track.instrument.number).toBe(TRACK_MIDI[id].program);
      const expected = composition.notes
        .filter((n) => n.track === id)
        .map((n) => ({ midi: n.pitch, ticks: n.start, durationTicks: n.duration, velocity: n.velocity }))
        .sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);
      const actual = track.notes
        .map((n) => ({ midi: n.midi, ticks: n.ticks, durationTicks: n.durationTicks, velocity: Math.round(n.velocity * 127) }))
        .sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);
      expect(actual).toEqual(expected);
    });
  });

  it('writes the key signature meta event', () => {
    const find = (bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length - 4; i++) {
        if (bytes[i] === 0xff && bytes[i + 1] === 0x59 && bytes[i + 2] === 0x02) return [bytes[i + 3], bytes[i + 4]];
      }
      return null;
    };
    // F minor: four flats (sf = -4 as a signed byte), minor flag set.
    expect(find(compositionToMidi(straight({ key: 5, scale: 'minor' })))).toEqual([0xfc, 1]);
    // G major: one sharp, major.
    expect(find(compositionToMidi(straight({ key: 7, scale: 'major' })))).toEqual([1, 0]);
    // The reference parser agrees on the scale flag.
    expect(new Midi(compositionToMidi(straight({ key: 5, scale: 'minor' }))).header.keySignatures[0].scale).toBe('minor');
  });

  it('closes a note before reopening the same pitch on the same tick', () => {
    const base = straight();
    const composition: Composition = {
      ...base,
      notes: [
        { id: 'a', track: 'bass', pitch: 40, start: 0, duration: 240, velocity: 100 },
        { id: 'b', track: 'bass', pitch: 40, start: 240, duration: 240, velocity: 90 },
      ],
    };
    const midi = new Midi(compositionToMidi(composition));
    const notes = midi.tracks.find((t) => t.name === 'Bass')!.notes;
    expect(notes.map((n) => [n.ticks, n.durationTicks])).toEqual([
      [0, 240],
      [240, 240],
    ]);
  });

  it('bakes swing into note timing by default and can export straight', () => {
    const composition = generateComposition(createSettings({ seed: 3, style: 'ukg', swing: 62 }));
    const offbeat = composition.notes.find((n) => (n.start / (PPQ / 4)) % 2 === 1)!;
    expect(offbeat).toBeDefined();

    const swung = new Midi(compositionToMidi(composition)).tracks.flatMap((t) => t.notes);
    expect(swung.some((n) => n.ticks === Math.round(swingTick(offbeat.start, 62)) && n.midi === offbeat.pitch)).toBe(true);

    const flat = new Midi(compositionToMidi(composition, { bakeSwing: false })).tracks.flatMap((t) => t.notes);
    expect(flat.some((n) => n.ticks === offbeat.start && n.midi === offbeat.pitch)).toBe(true);
  });

  it('only writes the requested tracks', () => {
    const midi = new Midi(compositionToMidi(straight(), { tracks: ['melody', 'bass'] }));
    expect(midi.tracks.filter((t) => t.notes.length).map((t) => t.name)).toEqual(['Melody', 'Bass']);
  });

  it('pads each track to the full loop length so DAWs import whole bars', () => {
    const composition = straight({ bars: 8 });
    const midi = new Midi(compositionToMidi(composition));
    expect(midi.durationTicks).toBeGreaterThanOrEqual(totalTicks(8) - 1);
  });

  it('writes enabled automation lanes as CC events on the right channel', () => {
    const composition = straight({ style: 'deepHouse' });
    const [on, off] = composition.automation;
    const toggled: Composition = {
      ...composition,
      automation: composition.automation.map((l) => (l === off ? { ...l, enabled: false } : l)),
    };
    const midi = new Midi(compositionToMidi(toggled));
    const track = midi.tracks.find((t) => t.name === TRACK_MIDI[on.track].name)!;
    const events = track.controlChanges[AUTOMATION_PARAMS[on.param].cc];
    expect(events?.length).toBeGreaterThan(0);
    expect(events[0].ticks).toBe(0);
    expect(track.channel).toBe(TRACK_MIDI[on.track].channel);
    for (const e of events) {
      expect(Math.abs(Math.round(e.value * 127) - Math.round(valueAt(on.points, e.ticks) * 127))).toBeLessThanOrEqual(1);
    }
    const offTrack = midi.tracks.find((t) => t.name === TRACK_MIDI[off.track].name)!;
    expect(offTrack.controlChanges[AUTOMATION_PARAMS[off.param].cc]).toBeUndefined();
  });

  it('can leave automation out', () => {
    const midi = new Midi(compositionToMidi(straight(), { automation: false }));
    expect(midi.tracks.every((t) => Object.keys(t.controlChanges).length === 0)).toBe(true);
  });
});
