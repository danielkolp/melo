import { describe, expect, it } from 'vitest';
import { readMidi } from '../core/readMidi';
import { TRACK_IDS } from '../core/types';
import { studio } from '../state/useStudio';
import { downloadUrl } from './dragMidi';
import { loopFile, partFile } from './exportMidi';

const PREFIX = /^audio\/midi:([^:]+):data:audio\/midi;base64,(.*)$/;
const decode = (url: string) => Uint8Array.from(atob(url.match(PREFIX)![2]), (c) => c.charCodeAt(0));

describe('dragging a .mid out', () => {
  it('carries the file in Chromium’s DownloadURL format, with the bytes intact', () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 37) % 256);
    const url = downloadUrl({ name: 'idea: take 2.mid', bytes });
    expect(url.match(PREFIX)?.[1]).toBe('idea- take 2.mid');
    expect(decode(url)).toEqual(bytes);
  });

  it('drags one part alone, or the whole loop', () => {
    const { notes } = studio.getState().history.present;
    for (const track of TRACK_IDS) {
      const file = partFile(track);
      expect(file.name).toMatch(new RegExp(`-${track}\\.mid$`));
      const read = readMidi(decode(downloadUrl(file)));
      expect(read.tracks).toHaveLength(1);
      expect(read.tracks[0].notes).toHaveLength(notes.filter((n) => n.track === track).length);
    }
    expect(readMidi(decode(downloadUrl(loopFile()))).tracks).toHaveLength(TRACK_IDS.length);
  });
});
