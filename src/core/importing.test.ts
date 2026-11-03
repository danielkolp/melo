import { Midi } from '@tonejs/midi';
import { describe, expect, it } from 'vitest';
import { createStudioStore } from '../state/store';
import { createSettings, generateComposition, regenerateTrack } from './generator';
import { swingTick } from './groove';
import { analyseMidi, buildImport, chosenNotes, composeAround, detectKey, inferProgression, loadHeld, movePitch, rankKeys, type ImportRole } from './importing';
import { compositionToMidi } from './midi';
import { MidiReadError, readMidi } from './readMidi';
import { pc } from './shared';
import { harmonyPitchClasses, romanNumeral } from './theory';
import { PPQ, STEP, TICKS_PER_BAR, type ImportedPart, type NoteEvent, type ScaleId, type TrackId } from './types';
import { STYLE_IDS } from './styles';
import { readComposition } from './validate';

type Spec = { name?: string; channel?: number; notes: [pitch: number, beat: number, beats: number][] };

/** A file written by another library, the way a DAW would: its own conductor track and resolution. */
function makeFile(tracks: Spec[], { bpm = 124, swing = 50, ppq = 480 } = {}): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(bpm);
  for (const spec of tracks) {
    const track = midi.addTrack();
    track.name = spec.name ?? '';
    track.channel = spec.channel ?? 0;
    for (const [pitch, beat, beats] of spec.notes) {
      const on = swingTick(beat * PPQ, swing) * (ppq / PPQ);
      const off = swingTick((beat + beats) * PPQ, swing) * (ppq / PPQ);
      track.addNote({ midi: pitch, ticks: Math.round(on), durationTicks: Math.round(off - on), velocity: 0.8 });
    }
  }
  // The library always writes 480 ticks a beat; the ticks above are in `ppq`, so say so in the header.
  const bytes = midi.toArray();
  bytes[12] = ppq >> 8;
  bytes[13] = ppq & 0xff;
  return bytes;
}

const analyse = (tracks: Spec[], options?: Parameters<typeof makeFile>[1]) => analyseMidi(readMidi(makeFile(tracks, options)), 'test.mid');

/** One chord per bar, as whole-bar triads in close position. */
const chordTrack = (roots: number[][], name = 'Pad'): Spec => ({ name, notes: roots.flatMap((tones, bar) => tones.map((p): [number, number, number] => [p, bar * 4, 4])) });
const bassTrack = (roots: number[], name = 'Bass'): Spec => ({
  name,
  notes: roots.flatMap((r, bar): [number, number, number][] => [
    [r, bar * 4, 1.5],
    [r, bar * 4 + 2, 0.5],
    [r + 7, bar * 4 + 3, 0.5],
  ]),
});

const grid = (notes: [number, number, number][]) => notes.map(([pitch, beat, beats]) => ({ pitch, start: beat * PPQ, duration: beats * PPQ, velocity: 90 }));

const C = [60, 64, 67];
const G = [59, 62, 67];
const Am = [57, 60, 64];
const F = [57, 60, 65];

function part(track: TrackId, notes: [number, number, number][]): ImportedPart {
  return {
    track,
    name: track,
    notes: notes.map(([pitch, beat, beats], i) => ({ id: `${track}${i}`, track, pitch, start: beat * PPQ, duration: beats * PPQ, velocity: 100 })),
  };
}

describe('readMidi', () => {
  it('reads back what the app writes', () => {
    const comp = generateComposition(createSettings({ seed: 9, swing: 50 }));
    const file = readMidi(compositionToMidi(comp, { bakeSwing: false, automation: false }));
    expect(file.ppq).toBe(PPQ);
    expect(file.bpm).toBeCloseTo(comp.settings.bpm, 1);
    expect(file.tracks.map((t) => t.name)).toEqual(['Melody', 'Counter-melody', 'Brass', 'Chords', 'Bass']);
    for (const [i, track] of (['melody', 'counter', 'brass', 'chords', 'bass'] as TrackId[]).entries()) {
      const want = comp.notes
        .filter((n) => n.track === track)
        // A note's nudge moves it off the grid in the file, both ends alike.
        .map(({ pitch, start, duration, velocity, nudge = 0 }) => {
          const on = Math.max(0, start + nudge);
          return { pitch, start: on, duration: start + duration + nudge - on, velocity };
        })
        .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
      expect(file.tracks[i].notes).toEqual(want);
    }
  });

  it('reads a format-0 file with running status, zero-velocity note-offs and a drum channel', () => {
    const vlq = (n: number) => (n < 128 ? [n] : [0x80 | (n >> 7), n & 0x7f]);
    const events = [
      ...[0, 0xff, 0x03, 4, ...'Loop'.split('').map((c) => c.charCodeAt(0))],
      ...[0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20], // 120 bpm
      ...[0, 0x90, 48, 100], // C3 on, channel 1
      ...[0, 52, 90], // running status: E3 on
      ...[0, 0x99, 36, 110], // kick on the drum channel
      ...vlq(240), 0x89, 36, 0,
      ...vlq(240), 0x90, 48, 0, // note-on at zero velocity ends C3
      ...[0, 52, 0],
      ...[0, 0xff, 0x2f, 0],
    ];
    const bytes = Uint8Array.from([
      ...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0],
      ...[0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, events.length],
      ...events,
    ]);
    const file = readMidi(bytes);
    expect(file.bpm).toBe(120);
    expect(file.tracks).toHaveLength(2);
    const [keys, drums] = file.tracks;
    expect(keys).toMatchObject({ name: 'Loop (ch 1)', channel: 0, drums: false });
    expect(keys.notes).toEqual([
      { pitch: 48, start: 0, duration: 480, velocity: 100 },
      { pitch: 52, start: 0, duration: 480, velocity: 90 },
    ]);
    expect(drums).toMatchObject({ channel: 9, drums: true });
    expect(drums.notes).toEqual([{ pitch: 36, start: 0, duration: 240, velocity: 110 }]);
  });

  it('reads files that leave out the wait between notes struck together', () => {
    // Some generators write a chord's events back to back, with no zero delta between them.
    const chord = (pitches: number[]) => [
      0, 0x90, pitches[0], 100, ...pitches.slice(1).flatMap((p) => [0x90, p, 100]),
      0x8f, 0x00, 0x80, pitches[0], 0, ...pitches.slice(1).flatMap((p) => [0x80, p, 0]),
    ];
    const events = [0, 0xff, 0x51, 3, 0x07, 0x62, 0x1e, ...chord([48, 55, 59, 62, 64]), ...chord([45, 55, 60, 64, 67]), 0, 0xff, 0x2f, 0];
    const bytes = Uint8Array.from([
      ...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0x01, 0xe0],
      ...[0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, events.length],
      ...events,
    ]);
    const [track] = readMidi(bytes).tracks;
    expect(track.notes.map((n) => [n.pitch, n.start, n.duration])).toEqual([
      ...[48, 55, 59, 62, 64].map((p) => [p, 0, 1920]),
      ...[45, 55, 60, 64, 67].map((p) => [p, 1920, 1920]),
    ]);
  });

  it('turns away files it cannot use', () => {
    expect(() => readMidi(new TextEncoder().encode('not a midi file at all'))).toThrow(MidiReadError);
    const empty = new Midi();
    empty.addTrack();
    expect(() => readMidi(empty.toArray())).toThrow(/no notes/i);
  });
});

describe('analyseMidi', () => {
  it('guesses each track’s part, by name or by what it plays, and leaves drums out', () => {
    const a = analyse([
      chordTrack([C, G, Am, F], 'Track 1'),
      bassTrack([36, 43, 45, 41], 'Track 2'),
      { name: 'Track 3', notes: [[72, 0, 1], [74, 1, 1], [76, 2, 2], [79, 4, 2], [77, 6, 2]] },
      { name: 'Kit', channel: 9, notes: [[36, 0, 0.25], [38, 1, 0.25]] },
    ]);
    expect(a.tracks.map((t) => t.guess)).toEqual(['chords', 'bass', 'melody', 'skip']);
    expect(a.tracks[0].polyphony).toBe(3);
  });

  it('makes a second melody the counter-melody', () => {
    const a = analyse([
      { name: 'A', notes: [[60, 0, 1], [62, 1, 1], [64, 2, 2]] },
      { name: 'B', notes: [[76, 0, 1], [74, 1, 1], [72, 2, 2]] },
    ]);
    expect(a.tracks.map((t) => t.guess)).toEqual(['counter', 'melody']);
  });

  it.each([
    ['C major', 0, 'major', [60, 62, 64, 65, 67, 69, 71, 72], [60, 67, 64, 60]],
    ['A minor', 9, 'minor', [57, 59, 60, 62, 64, 65, 67, 69], [57, 64, 60, 57]],
    ['D dorian', 2, 'dorian', [62, 64, 65, 67, 69, 71, 72, 74], [62, 69, 71, 62]],
    ['G mixolydian', 7, 'mixolydian', [55, 57, 59, 60, 62, 64, 65, 67], [55, 62, 65, 55]],
  ] as [string, number, ScaleId, number[], number[]][])('reads %s', (_, key, scale, run, anchors) => {
    // A run through the scale, with the tonic, fifth and colour note held on the downbeats.
    const notes = [
      ...anchors.map((p, bar): [number, number, number] => [p, bar * 4, 2]),
      ...run.map((p, i): [number, number, number] => [p, (i % 4) * 4 + 2 + (i >= 4 ? 1 : 0), 1]),
    ];
    expect(detectKey(notes.map(([pitch, beat, beats]) => ({ pitch, start: beat * PPQ, duration: beats * PPQ, velocity: 90 })))).toEqual({ key, scale });
  });

  it('takes the tonic from the bass when the notes fit more than one key', () => {
    // E and A roots with no third: the line opens on E and keeps coming back to it.
    const bar: [number, number, number][] = [[40, 0.5, 2], [47, 2.5, 0.75], [52, 3.5, 0.5], [45, 4, 1.5], [45, 5.5, 0.5], [52, 6.5, 0.75], [45, 7.5, 0.5]];
    const line = [0, 8, 16, 24].flatMap((at) => bar.map(([p, beat, beats]): [number, number, number] => [p, at + beat, beats]));
    expect(detectKey(grid(line))).toEqual({ key: 4, scale: 'minor' });
    // A, the other root, is the next tonic in line.
    expect(rankKeys(grid(line)).find((k) => k.key !== 4)?.key).toBe(9);
  });

  it('hears a minor key under chords voiced without their roots', () => {
    // C#m9, Amaj7, F#m9, G#m7 with the roots only in the bass: the same notes as E major.
    const voicings = [[64, 68, 71, 75], [61, 64, 68, 69], [61, 64, 68, 69], [63, 66, 71, 75]];
    const roots = [37, 33, 30, 32];
    const notes = voicings.flatMap((v, bar): [number, number, number][] => [[roots[bar], bar * 4, 3], ...v.map((p): [number, number, number] => [p, bar * 4 + 0.5, 1])]);
    expect(detectKey(grid(notes))).toEqual({ key: 1, scale: 'minor' });
  });

  it('reads the key from the parts and bars chosen', () => {
    const a = analyse([chordTrack([C, G, Am, F, Am, F, C, G]), bassTrack([45, 41, 36, 43, 45, 41, 36, 43])]);
    expect(chosenNotes(a, ['chords', 'skip'], 0, 4)).toHaveLength(12);
    expect(chosenNotes(a, ['chords', 'bass'], 4, 4).every((n) => n.start >= 4 * TICKS_PER_BAR)).toBe(true);
    expect(detectKey(chosenNotes(a, ['chords', 'skip'], 0, 4))).toEqual({ key: 0, scale: 'major' });
    expect(detectKey(chosenNotes(a, ['chords', 'bass'], 4, 4))).toEqual({ key: 9, scale: 'minor' });
  });

  it('finds the tonic of the app’s own loops, from every part or the bass alone', () => {
    const tally = { all: 0, bass: 0, loops: 0 };
    for (const style of STYLE_IDS)
      for (const scale of ['minor', 'major', 'dorian'] as ScaleId[])
        for (let key = 0; key < 12; key++) {
          const comp = generateComposition(createSettings({ style, key, scale, seed: 1000 + key * 7, bars: 4, creativity: 0.4 }));
          // Loops that open on their tonic chord; the rest are fairly heard in the chord they start on.
          if (comp.progression[0].degree !== 0 || comp.progression[0].numeral) continue;
          const a = analyseMidi(readMidi(compositionToMidi(comp, { automation: false })), 'loop.mid');
          tally.loops++;
          if (a.key === key) tally.all++;
          if (detectKey(a.tracks.find((t) => t.name === 'Bass')!.notes).key === key) tally.bass++;
        }
    expect(tally.loops).toBeGreaterThan(80);
    expect(tally.all / tally.loops).toBeGreaterThan(0.85);
    expect(tally.bass / tally.loops).toBeGreaterThan(0.75);
  });

  it('hears swing and puts the notes back on the grid', () => {
    const notes: [number, number, number][] = Array.from({ length: 32 }, (_, i) => [60 + (i % 5), i / 4, 0.25]);
    const a = analyse([{ name: 'Lead', notes }], { swing: 62, ppq: 96 });
    expect(a.swing).toBeGreaterThanOrEqual(60);
    expect(a.swing).toBeLessThanOrEqual(64);
    expect(a.tracks[0].notes.map((n) => n.start)).toEqual(notes.map(([, beat]) => beat * PPQ));
    expect(analyse([{ name: 'Lead', notes }]).swing).toBe(50);
  });

  it('finds a pickup and wraps it round to the end of the loop', () => {
    const a = analyse([{ name: 'Lead', notes: [[67, 3.5, 0.5], [72, 4, 2], [71, 6, 2], [69, 8, 4], [67, 12, 4], [64, 16, 4]] }]);
    expect(a).toMatchObject({ pickup: true, firstBar: 1, length: 4, bars: 4 });
    const source = buildImport(a, { roles: ['melody'], bars: 4, startBar: 1, key: 0, scale: 'major' }, 1);
    const notes = source.parts[0].notes;
    expect(notes[0]).toMatchObject({ pitch: 72, start: 0 });
    expect(notes[notes.length - 1]).toMatchObject({ pitch: 67, start: 4 * TICKS_PER_BAR - STEP * 2, duration: STEP * 2 });
  });

  it('repeats a one-bar riff to fill the loop, and keeps one note at a time in a bass line', () => {
    const a = analyse([{ name: 'Bass', notes: [[36, 0, 1], [48, 0, 1], [43, 1, 1], [36, 2, 2]] }]);
    expect(a).toMatchObject({ length: 1, bars: 2 });
    const notes = buildImport(a, { roles: ['bass'], bars: 2, startBar: 0, key: 0, scale: 'minor' }, 1).parts[0].notes;
    expect(notes.map((n) => [n.pitch, n.start])).toEqual([
      [36, 0],
      [43, PPQ],
      [36, 2 * PPQ],
      [36, TICKS_PER_BAR],
      [43, TICKS_PER_BAR + PPQ],
      [36, TICKS_PER_BAR + 2 * PPQ],
    ]);
  });
});

describe('inferProgression', () => {
  const degrees = (parts: ImportedPart[], key = 0, scale: ScaleId = 'major', bars = 4) => inferProgression(parts, key, scale, bars).map((c) => c.degree);

  it('reads I–V–vi–IV from chords', () => {
    const chords = part('chords', [C, G, Am, F].flatMap((tones, bar) => tones.map((p): [number, number, number] => [p, bar * 4, 4])));
    expect(degrees([chords])).toEqual([0, 4, 5, 3]);
  });

  it('reads I–V–vi–IV from a bass line alone', () => {
    const bass = part('bass', [36, 43, 45, 41].flatMap((r, bar): [number, number, number][] => [[r, bar * 4, 2], [r + 12, bar * 4 + 2.5, 0.5], [r + 7, bar * 4 + 3, 1]]));
    expect(degrees([bass])).toEqual([0, 4, 5, 3]);
  });

  it('harmonises a melody so its downbeats are chord tones', () => {
    const melody = part('melody', [[72, 0, 2], [74, 2, 1], [76, 3, 1], [74, 4, 2], [71, 6, 2], [72, 8, 3], [69, 11, 1], [65, 12, 2], [69, 14, 2]]);
    const chords = inferProgression([melody], 0, 'major', 4);
    for (const n of melody.notes.filter((n) => n.start % TICKS_PER_BAR === 0)) {
      const chord = chords.find((c) => n.start >= c.start && n.start < c.start + c.duration)!;
      expect(chord.tones).toContain(pc(n.pitch));
    }
  });

  it('names a borrowed chord and gives it its own scale', () => {
    const Bb = [58, 62, 65];
    const chords = inferProgression([part('chords', [C, Bb, F, C].flatMap((tones, bar) => tones.map((p): [number, number, number] => [p, bar * 4, 4])))], 0, 'major', 4);
    expect(chords[1]).toMatchObject({ root: 10, numeral: 'bVII' });
    expect(romanNumeral(chords[1])).toBe('bVII');
    expect(chords[1].scale).toContain(10);
    expect(chords[1].scale).not.toContain(11);
  });

  it('splits a bar that changes chord halfway', () => {
    const notes = [...C.map((p): [number, number, number] => [p, 0, 2]), ...G.map((p): [number, number, number] => [p, 2, 2]), ...Am.map((p): [number, number, number] => [p, 4, 4])];
    const chords = inferProgression([part('chords', notes)], 0, 'major', 2);
    expect(chords.map((c) => [c.degree, c.duration])).toEqual([
      [0, TICKS_PER_BAR / 2],
      [4, TICKS_PER_BAR / 2],
      [5, TICKS_PER_BAR],
    ]);
  });
});

describe('writing around an upload', () => {
  const upload = (roles: ImportRole[], tracks: Spec[], overrides: Partial<{ bars: 2 | 4 | 8; key: number; scale: ScaleId }> = {}) => {
    const a = analyse(tracks);
    return buildImport(a, { roles, bars: a.bars, startBar: a.firstBar, key: a.key, scale: a.scale, ...overrides }, 7);
  };
  const bassUpload = () => upload(['bass'], [bassTrack([45, 41, 36, 43])]);
  const held = (notes: readonly NoteEvent[], track: TrackId) => notes.filter((n) => n.track === track).map(({ pitch, start, duration }) => [pitch, start, duration]);

  it('keeps the upload exactly and writes the other parts from its harmony', () => {
    const source = bassUpload();
    expect(source.progression.map((c) => c.root)).toEqual([9, 5, 0, 7]);
    const settings = createSettings({ seed: 3, key: source.key, scale: source.scale });
    const comp = composeAround(settings, source, loadHeld(source, settings));
    expect(held(comp.notes, 'bass')).toEqual(held(source.parts[0].notes, 'bass'));
    expect(comp.progression).toEqual(source.progression);
    for (const track of ['melody', 'counter', 'chords'] as TrackId[]) expect(comp.notes.some((n) => n.track === track)).toBe(true);
    const inKey = new Set(harmonyPitchClasses(source.key, source.scale));
    for (const n of comp.notes.filter((n) => n.track === 'chords')) expect(inKey.has(pc(n.pitch))).toBe(true);
  });

  it('writes the counter-melody under an uploaded melody', () => {
    const source = upload(['melody'], [{ name: 'Lead', notes: [[76, 0, 2], [79, 2, 2], [77, 4, 3], [76, 7, 1], [74, 8, 4], [72, 12, 4]] }]);
    const settings = createSettings({ seed: 4, style: 'house', key: source.key, scale: source.scale, phrase: 'trade' });
    const comp = composeAround(settings, source, loadHeld(source, settings));
    expect(comp.phrasing.sections.every((s) => s.role === 'yours')).toBe(true);
    const melody = comp.notes.filter((n) => n.track === 'melody');
    const counter = comp.notes.filter((n) => n.track === 'counter');
    expect(counter.length).toBeGreaterThan(0);
    for (const c of counter) {
      const over = melody.find((m) => m.start <= c.start && c.start < m.start + m.duration);
      if (over) expect(c.pitch).toBeLessThan(over.pitch);
    }
  });

  it('moves notes to the same degree of a new key and scale', () => {
    expect(movePitch(64, { key: 0, scale: 'major' }, { key: 2, scale: 'major' })).toBe(66);
    expect(movePitch(64, { key: 0, scale: 'major' }, { key: 0, scale: 'minor' })).toBe(63);
    expect(movePitch(61, { key: 0, scale: 'major' }, { key: 0, scale: 'minor' })).toBe(61);
    expect(movePitch(72, { key: 0, scale: 'major' }, { key: 10, scale: 'major' })).toBe(70);
  });

  it('keeps the upload and its edits through Generate, moves it with the key, and tiles it for a longer loop', () => {
    const source = bassUpload();
    const store = createStudioStore({ composition: generateComposition(createSettings({ seed: 1 })), random: (() => { let s = 50; return () => ++s; })() });
    store.getState().importParts(source, { key: source.key, scale: source.scale, bars: source.bars });
    const bass = () => store.getState().history.present.notes.filter((n) => n.track === 'bass');
    const first = bass()[0];
    store.getState().updateNote(first.id, { pitch: first.pitch + 2 });
    const edited = held(bass(), 'bass');
    const melodyBefore = held(store.getState().history.present.notes, 'melody');
    store.getState().generate();
    expect(held(bass(), 'bass')).toEqual(edited);
    expect(held(store.getState().history.present.notes, 'melody')).not.toEqual(melodyBefore);

    store.getState().changeMusic({ key: (source.key + 2) % 12 });
    expect(bass().map((n) => n.pitch)).toEqual(edited.map(([p]) => p + 2));
    store.getState().changeMusic({ key: source.key, bars: 8 });
    expect(bass()).toHaveLength(source.parts[0].notes.length * 2);
    expect(store.getState().history.present.progression).toHaveLength(8);
  });

  it('never regenerates an uploaded part, and the upload, takes and removal all undo', () => {
    const source = bassUpload();
    const store = createStudioStore({ composition: generateComposition(createSettings({ seed: 1 })), random: () => 99 });
    store.getState().importParts(source, { key: source.key, scale: source.scale, bars: source.bars });
    const comp = store.getState().history.present;
    expect(regenerateTrack(comp, 'bass', 5)).toBe(comp);

    store.getState().pickTake('bass', 2);
    expect(store.getState().history.present.source?.picked.bass).toBe(2);
    expect(held(store.getState().history.present.notes, 'bass')).not.toEqual(held(comp.notes, 'bass'));
    store.getState().undo();
    expect(store.getState().history.present).toBe(comp);

    store.getState().removeImport();
    expect(store.getState().history.present.source).toBeUndefined();
    store.getState().undo();
    store.getState().undo();
    expect(store.getState().history.present.source).toBeUndefined();
    expect(store.getState().history.present.notes.some((n) => n.track === 'bass')).toBe(true);
  });

  it('saves and reloads an upload, and drops a corrupt one', () => {
    const source = bassUpload();
    const settings = createSettings({ seed: 3, key: source.key, scale: source.scale });
    const comp = composeAround(settings, source, loadHeld(source, settings));
    const saved = JSON.parse(JSON.stringify(comp));
    expect(readComposition(saved)?.source).toEqual(source);
    const broken = readComposition({ ...saved, source: { ...saved.source, parts: [{ track: 'drums' }] } });
    expect(broken).not.toBeNull();
    expect(broken?.source).toBeUndefined();
  });
});
