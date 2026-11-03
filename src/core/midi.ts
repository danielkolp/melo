import { SECTION_KINDS, songAutomation, songBeat, songLength, songNotes, songSpans } from './arrangement';
import { AUTOMATION_PARAMS, sampleLane } from './automation';
import type { DrumVoice } from './beat';
import { swingTick } from './groove';
import { keySignature } from './theory';
import {
  PPQ,
  TRACK_IDS,
  totalTicks,
  type AutomationParam,
  type AutomationPoint,
  type Composition,
  type NoteEvent,
  type TrackId,
} from './types';

/** Standard MIDI File (format 1) writer. No dependencies. */

export const TRACK_MIDI: Record<TrackId, { name: string; channel: number; program: number }> = {
  melody: { name: 'Melody', channel: 0, program: 81 }, // Lead 2 (sawtooth)
  counter: { name: 'Counter-melody', channel: 1, program: 5 }, // Electric Piano 2
  brass: { name: 'Brass', channel: 4, program: 61 }, // Brass Section
  chords: { name: 'Chords', channel: 2, program: 4 }, // Electric Piano 1
  bass: { name: 'Bass', channel: 3, program: 38 }, // Synth Bass 1
};

export interface MidiExportOptions {
  title?: string;
  /** Tracks to include, in order. Defaults to every track that has notes. */
  tracks?: readonly TrackId[];
  /** Write swing into note timings so the file plays back as heard. Default true. */
  bakeSwing?: boolean;
  /** Write enabled automation lanes as controller (CC) events. Default true. */
  automation?: boolean;
}

/** Variable-length quantity, as used for delta times and meta lengths. */
export function encodeVlq(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 0x0fffffff) {
    throw new RangeError(`VLQ out of range: ${value}`);
  }
  const bytes = [value & 0x7f];
  let v = value >>> 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return bytes;
}

const ascii = (text: string) => Array.from(text, (ch) => {
  const code = ch.charCodeAt(0);
  return code < 128 ? code : 63; // '?'
});
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

interface TimedEvent {
  tick: number;
  /** Lower sorts first at the same tick: meta, then note-offs, then note-ons. */
  order: number;
  bytes: number[];
}

function meta(tick: number, type: number, data: number[]): TimedEvent {
  return { tick, order: 0, bytes: [0xff, type, ...encodeVlq(data.length), ...data] };
}

function chunk(type: string, data: number[]): number[] {
  return [...ascii(type), ...u32(data.length), ...data];
}

function trackChunk(events: TimedEvent[], endTick: number): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const data: number[] = [];
  let last = 0;
  for (const e of events) {
    data.push(...encodeVlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  data.push(...encodeVlq(Math.max(0, endTick - last)), 0xff, 0x2f, 0x00);
  return chunk('MTrk', data);
}

function noteEvents(notes: readonly NoteEvent[], channel: number, swing: number | null): TimedEvent[] {
  const events: TimedEvent[] = [];
  for (const n of notes) {
    const on = Math.round(swing === null ? n.start : swingTick(n.start, swing));
    const off = Math.max(on + 1, Math.round(swing === null ? n.start + n.duration : swingTick(n.start + n.duration, swing)));
    events.push({ tick: on, order: 2, bytes: [0x90 | channel, n.pitch & 0x7f, Math.max(1, n.velocity) & 0x7f] });
    events.push({ tick: off, order: 1, bytes: [0x80 | channel, n.pitch & 0x7f, 0x40] });
  }
  return events;
}

/** One CC message per change in the 7-bit value, sampled every 32nd note. */
function controlEvents(
  lane: { param: AutomationParam; points: readonly AutomationPoint[] },
  channel: number,
  loopEnd: number,
  swing: number | null,
): TimedEvent[] {
  const { cc } = AUTOMATION_PARAMS[lane.param];
  const events: TimedEvent[] = [];
  let last = -1;
  for (const { tick, value } of sampleLane(lane.points, loopEnd)) {
    const v = Math.round(value * 127);
    if (v === last) continue;
    last = v;
    events.push({ tick: Math.round(swing === null ? tick : swingTick(tick, swing)), order: 0, bytes: [0xb0 | channel, cc, v] });
  }
  return events;
}

/** Title, tempo, time and key signature, plus any markers, on the conductor track. */
function conductorTrack(composition: Composition, title: string | undefined, end: number, markers: TimedEvent[] = []): number[] {
  const { settings } = composition;
  const tempo = Math.round(60_000_000 / settings.bpm);
  const sig = keySignature(settings.key, settings.scale);
  return trackChunk(
    [
      meta(0, 0x03, ascii(title ?? 'Melo Lab')),
      meta(0, 0x51, [(tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff]),
      meta(0, 0x58, [4, 2, 24, 8]),
      meta(0, 0x59, [sig.sharps & 0xff, sig.minor ? 1 : 0]),
      ...markers,
    ],
    end,
  );
}

export function compositionToMidi(composition: Composition, options: MidiExportOptions = {}): Uint8Array {
  const { settings, notes } = composition;
  const swing = options.bakeSwing === false ? null : settings.swing;
  const tracks = options.tracks ?? TRACK_IDS.filter((t) => notes.some((n) => n.track === t));
  const loopEnd = totalTicks(settings.bars);
  const conductor = conductorTrack(composition, options.title, loopEnd);

  const chunks = tracks.map((track) => {
    const { name, channel, program } = TRACK_MIDI[track];
    const trackNotes = notes.filter((n) => n.track === track);
    const lanes = options.automation === false ? [] : composition.automation.filter((l) => l.enabled && l.track === track);
    const events = [
      meta(0, 0x03, ascii(name)),
      { tick: 0, order: 0, bytes: [0xc0 | channel, program & 0x7f] },
      ...lanes.flatMap((lane) => controlEvents(lane, channel, loopEnd, swing)),
      ...noteEvents(trackNotes, channel, swing),
    ];
    const lastOff = events.reduce((m, e) => Math.max(m, e.tick), 0);
    return trackChunk(events, Math.max(loopEnd, lastOff));
  });

  const header = chunk('MThd', [...u16(1), ...u16(chunks.length + 1), ...u16(PPQ)]);
  return Uint8Array.from([...header, ...conductor, ...chunks.flat()]);
}

/** General MIDI drum notes for the guide beat. */
export const GM_DRUMS: Record<DrumVoice, number> = { kick: 36, clap: 39, hat: 42, openHat: 46 };
export const GM_SNARE = 38;
const DRUM_CHANNEL = 9;

export interface SongExportOptions {
  title?: string;
  /** Note for the backbeat voice: a clap (39) or, for kits with a snare, 38. */
  backbeat?: number;
}

/**
 * The whole arrangement as one file: section names as markers, each part
 * only where its section has it, the filter moves and lanes as CC, and the
 * guide beat on the General MIDI drum channel. Swing is written in.
 */
export function songToMidi(composition: Composition, options: SongExportOptions = {}): Uint8Array {
  const { settings } = composition;
  const swing = settings.swing;
  const spans = songSpans(composition.arrangement);
  const end = songLength(spans);
  const notes = songNotes(composition);
  const lanes = songAutomation(composition);

  const markers = spans.map((s) => meta(s.start, 0x06, ascii(SECTION_KINDS[s.section.kind].label)));
  const conductor = conductorTrack(composition, options.title, end, markers);

  const parts = TRACK_IDS.filter((t) => notes.some((n) => n.track === t)).map((track) => {
    const { name, channel, program } = TRACK_MIDI[track];
    const events = [
      meta(0, 0x03, ascii(name)),
      { tick: 0, order: 0, bytes: [0xc0 | channel, program & 0x7f] },
      ...lanes.filter((l) => l.track === track).flatMap((lane) => controlEvents(lane, channel, end, swing)),
      ...noteEvents(
        notes.filter((n) => n.track === track),
        channel,
        swing,
      ),
    ];
    return trackChunk(events, end);
  });

  const drumMap = { ...GM_DRUMS, clap: options.backbeat ?? GM_DRUMS.clap };
  const hits = songBeat(composition).map((h, i) => ({
    id: `d${i}`,
    track: 'bass' as const,
    pitch: drumMap[h.voice],
    start: Math.round(h.tick),
    duration: PPQ / 8,
    velocity: Math.max(1, Math.round(h.velocity * 127)),
  }));
  const drums = hits.length ? [trackChunk([meta(0, 0x03, ascii('Drums')), ...noteEvents(hits, DRUM_CHANNEL, swing)], end)] : [];

  const chunks = [...parts, ...drums];
  const header = chunk('MThd', [...u16(1), ...u16(chunks.length + 1), ...u16(PPQ)]);
  return Uint8Array.from([...header, ...conductor, ...chunks.flat()]);
}

export interface Take {
  label: string;
  notes: readonly NoteEvent[];
}

/**
 * Takes of one part, one track each on the part's channel, named after what changed.
 * Written in the loop's tempo and key, with swing.
 */
export function takesToMidi(composition: Composition, track: TrackId, takes: readonly Take[], options: { title?: string } = {}): Uint8Array {
  const { settings } = composition;
  const end = totalTicks(settings.bars);
  const conductor = conductorTrack(composition, options.title, end);
  const { channel, program } = TRACK_MIDI[track];
  const chunks = takes.map((take) =>
    trackChunk(
      [meta(0, 0x03, ascii(take.label)), { tick: 0, order: 0, bytes: [0xc0 | channel, program & 0x7f] }, ...noteEvents(take.notes, channel, settings.swing)],
      end,
    ),
  );
  const header = chunk('MThd', [...u16(1), ...u16(chunks.length + 1), ...u16(PPQ)]);
  return Uint8Array.from([...header, ...conductor, ...chunks.flat()]);
}
