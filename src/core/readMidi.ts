/** Standard MIDI File reader, the counterpart of the writer in midi.ts. No dependencies. */

export interface MidiNote {
  pitch: number;
  /** In the file's own ticks. */
  start: number;
  duration: number;
  velocity: number;
}

export interface MidiTrack {
  name: string;
  /** 0-based; 9 is the General MIDI drum channel. */
  channel: number;
  drums: boolean;
  notes: MidiNote[];
}

export interface MidiFile {
  /** Ticks per quarter note. */
  ppq: number;
  /** The first tempo in the file, or 120. */
  bpm: number;
  timeSignature: [number, number];
  /** One entry per track and channel that has notes, in file order. */
  tracks: MidiTrack[];
}

/** A file that can't be read, with a message fit to show. */
export class MidiReadError extends Error {}

const DRUM_CHANNEL = 9;

class Cursor {
  pos = 0;
  constructor(
    readonly bytes: Uint8Array,
    readonly end = bytes.length,
  ) {}

  byte(): number {
    if (this.pos >= this.end) throw new MidiReadError('The file ends in the middle of a track.');
    return this.bytes[this.pos++];
  }

  u16(): number {
    return (this.byte() << 8) | this.byte();
  }

  u32(): number {
    return ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0;
  }

  vlq(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.byte();
      value = (value << 7) | (b & 0x7f);
      if (!(b & 0x80)) return value;
    }
    throw new MidiReadError('The file has a malformed length or time value.');
  }

  text(length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) out += String.fromCharCode(this.byte());
    return out;
  }

  skip(length: number): void {
    if (this.pos + length > this.end) throw new MidiReadError('The file ends in the middle of a track.');
    this.pos += length;
  }
}

interface TrackRead {
  name: string;
  byChannel: Map<number, MidiNote[]>;
  tempo?: number;
  timeSignature?: [number, number];
}

/**
 * Reads one track chunk. Some tools write simultaneous events with no delta time between them;
 * `lenient` reads a status byte this track has already used, where a delta should be, as no wait,
 * and keeps what was read if the track is cut short.
 */
function readTrack(cursor: Cursor, lenient = false): TrackRead {
  const out: TrackRead = { name: '', byChannel: new Map() };
  const seen = new Set<number>();
  /** Notes waiting for their note-off, oldest first, per channel and pitch. */
  const open = new Map<number, { start: number; velocity: number }[]>();
  let tick = 0;
  let running = 0;

  const close = (channel: number, pitch: number, at: number) => {
    const waiting = open.get((channel << 7) | pitch);
    const on = waiting?.shift();
    if (!on) return;
    const notes = out.byChannel.get(channel) ?? [];
    notes.push({ pitch, start: on.start, duration: Math.max(1, at - on.start), velocity: on.velocity });
    out.byChannel.set(channel, notes);
  };

  try {
    while (cursor.pos < cursor.end) {
      if (!(lenient && seen.has(cursor.bytes[cursor.pos]))) tick += cursor.vlq();
      let status = cursor.bytes[cursor.pos];
      if (status & 0x80) cursor.pos++;
      else if (running) status = running;
      else throw new MidiReadError('The file has a data byte where an event should start.');

      if (status === 0xff) {
        running = 0;
        const type = cursor.byte();
        const length = cursor.vlq();
        if (type === 0x2f) break;
        if (type === 0x03 && !out.name) out.name = cursor.text(length).trim();
        else if (type === 0x51 && length === 3 && out.tempo === undefined) out.tempo = (cursor.byte() << 16) | (cursor.byte() << 8) | cursor.byte();
        else if (type === 0x58 && length >= 2 && !out.timeSignature) {
          out.timeSignature = [cursor.byte(), 2 ** cursor.byte()];
          cursor.skip(length - 2);
        } else cursor.skip(length);
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        running = 0;
        cursor.skip(cursor.vlq());
        continue;
      }
      if (status >= 0xf0) throw new MidiReadError('The file has an event this reader does not know.');

      running = status;
      seen.add(status);
      const kind = status & 0xf0;
      const channel = status & 0x0f;
      const a = cursor.byte();
      const b = kind === 0xc0 || kind === 0xd0 ? 0 : cursor.byte();
      if (kind === 0x90 && b > 0) {
        const key = (channel << 7) | a;
        open.set(key, [...(open.get(key) ?? []), { start: tick, velocity: b }]);
      } else if (kind === 0x80 || kind === 0x90) {
        close(channel, a, tick);
      }
    }
  } catch (error) {
    if (!lenient || !(error instanceof MidiReadError)) throw error;
  }
  // Notes still held when the track ends stop there.
  for (const [key, waiting] of open) for (let i = waiting.length; i > 0; i--) close(key >> 7, key & 0x7f, tick);
  return out;
}

export function readMidi(bytes: Uint8Array): MidiFile {
  try {
    return readFile(bytes, false);
  } catch (error) {
    if (!(error instanceof MidiReadError)) throw error;
    try {
      return readFile(bytes, true);
    } catch {
      throw error;
    }
  }
}

function readFile(bytes: Uint8Array, lenient: boolean): MidiFile {
  const cursor = new Cursor(bytes);
  if (bytes.length < 14 || cursor.text(4) !== 'MThd') throw new MidiReadError('This is not a MIDI file.');
  const headerLength = cursor.u32();
  cursor.u16(); // format: 0, 1 and 2 all read the same way here
  cursor.u16(); // track count: chunks are read until the file ends
  const division = cursor.u16();
  if (division & 0x8000) throw new MidiReadError('This file uses SMPTE timecode, which is not supported. Save it with beats and bars.');
  if (!division) throw new MidiReadError('This file has no timing resolution.');
  cursor.skip(headerLength - 6);

  const tracks: MidiTrack[] = [];
  let tempo: number | undefined;
  let timeSignature: [number, number] | undefined;
  let index = 0;
  while (cursor.pos + 8 <= bytes.length) {
    const type = cursor.text(4);
    const length = cursor.u32();
    const end = Math.min(bytes.length, cursor.pos + length);
    if (type === 'MTrk') {
      const read = readTrack(Object.assign(new Cursor(bytes, end), { pos: cursor.pos }), lenient);
      index++;
      tempo ??= read.tempo;
      timeSignature ??= read.timeSignature;
      const channels = [...read.byChannel.keys()].sort((x, y) => x - y);
      for (const channel of channels) {
        const notes = read.byChannel.get(channel)!.sort((x, y) => x.start - y.start || x.pitch - y.pitch);
        const name = read.name || `Track ${index}`;
        tracks.push({
          name: channels.length > 1 ? `${name} (ch ${channel + 1})` : name,
          channel,
          drums: channel === DRUM_CHANNEL,
          notes,
        });
      }
    }
    cursor.pos = end;
  }
  if (!tracks.length) throw new MidiReadError('There are no notes in this file.');
  return {
    ppq: division,
    bpm: tempo ? Math.round((60_000_000 / tempo) * 100) / 100 : 120,
    timeSignature: timeSignature ?? [4, 4],
    tracks,
  };
}
