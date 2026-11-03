import { KITS } from '../audio/drums';
import { midiFileName } from '../core/format';
import { GM_SNARE, compositionToMidi, songToMidi, takesToMidi } from '../core/midi';
import { TRACK_LABELS } from '../theme';
import type { TrackId } from '../core/types';
import type { Variation } from '../core/variations';
import { studio } from '../state/useStudio';
import { downloadBytes } from './download';

/** A .mid file, ready to save or to drag out of the page. */
export interface MidiFile {
  name: string;
  bytes: Uint8Array;
}

const current = () => {
  const { history, title } = studio.getState();
  return { composition: history.present, title };
};
const named = (suffix: string) => {
  const { composition, title } = current();
  return midiFileName(title, composition.settings).replace(/\.mid$/, `${suffix}.mid`);
};
const partSlug = (track: TrackId) => TRACK_LABELS[track].toLowerCase().replace(/[^a-z]+/g, '-');
// MIDI track names are plain ASCII.
const plain = (text: string) => text.replace(/[·–—]/g, '-');

/** The current idea, one track per part. */
export function loopFile(): MidiFile {
  const { composition, title } = current();
  return { name: named(''), bytes: compositionToMidi(composition, { title }) };
}

/** One part of the current idea on its own, for a single track in a DAW. */
export function partFile(track: TrackId): MidiFile {
  const { composition, title } = current();
  return { name: named(`-${partSlug(track)}`), bytes: compositionToMidi(composition, { title, tracks: [track] }) };
}

/** The whole arrangement: every section, the drums and section markers. */
export function songFile(): MidiFile {
  const { composition, title } = current();
  const backbeat = KITS[composition.settings.style].clap.snare !== undefined ? GM_SNARE : undefined;
  return { name: named('-song'), bytes: songToMidi(composition, { title, backbeat }) };
}

/** An uploaded part and its variation cards, one track per take. */
export function takesFile(track: TrackId, original: Variation, cards: readonly Variation[]): MidiFile {
  const { composition, title } = current();
  const takes = [original, ...cards].map((take, i) => ({ label: i ? `${i} - ${plain(take.label)}` : plain(take.label), notes: take.notes }));
  return { name: named(`-${partSlug(track)}-variations`), bytes: takesToMidi(composition, track, takes, { title }) };
}

/** One take of an uploaded part: 0 is the original, 1–6 a variation card. */
export function takeFile(track: TrackId, take: Variation, index: number): MidiFile {
  const { composition, title } = current();
  const label = index ? `${index} - ${plain(take.label)}` : plain(take.label);
  const suffix = index ? `-take-${index}` : '-original';
  return { name: named(`-${partSlug(track)}${suffix}`), bytes: takesToMidi(composition, track, [{ label, notes: take.notes }], { title }) };
}

/** Downloads a file and says so. */
export function saveMidi({ name, bytes }: MidiFile): void {
  downloadBytes(bytes, name, 'audio/midi');
  studio.getState().notify(`Exported ${name}`);
}

export const exportMidi = () => saveMidi(loopFile());
export const exportPart = (track: TrackId) => saveMidi(partFile(track));
export const exportSong = () => saveMidi(songFile());
export const exportTakes = (track: TrackId, original: Variation, cards: readonly Variation[]) => saveMidi(takesFile(track, original, cards));
