import type { DragEvent } from 'react';
import { studio } from '../state/useStudio';
import type { MidiFile } from './exportMidi';

interface UserAgentData {
  brands: { brand: string }[];
  mobile: boolean;
}

/**
 * Desktop Chrome and Edge can drag a file out of the page into another app: a DAW track,
 * the desktop or a folder. Other browsers can't, so there the files are click-to-save only.
 */
export const canDragOut = ((): boolean => {
  if (typeof navigator === 'undefined') return false;
  const data = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;
  if (data) return !data.mobile && data.brands.some((b) => b.brand === 'Chromium');
  return /Chrome\//.test(navigator.userAgent) && !/Mobile|Android/.test(navigator.userAgent);
})();

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * The `DownloadURL` drag data Chromium turns into a real file when it's dropped outside the
 * page: "type:name:url". The bytes travel in a data URL, so nothing has to stay alive after
 * the drop.
 */
export function downloadUrl({ name, bytes }: MidiFile): string {
  return `audio/midi:${name.replace(/:/g, '-')}:data:audio/midi;base64,${base64(bytes)}`;
}

/** What follows the pointer: a short name for what's being carried, and its colour. */
export interface DragChip {
  label: string;
  color?: string;
}

function showChip(e: DragEvent, { label, color }: DragChip) {
  const chip = document.createElement('div');
  chip.className = 'drag-chip';
  const name = document.createElement('span');
  name.textContent = label;
  const kind = document.createElement('span');
  kind.textContent = '.mid';
  chip.append(name, kind);
  if (color) chip.style.setProperty('--chip', color);
  document.body.append(chip);
  e.dataTransfer.setDragImage(chip, 14, 14);
  setTimeout(() => chip.remove());
}

/**
 * Props that make an element drag out as a .mid file, written when the drag starts so it
 * matches what's on screen. Nothing (not draggable) where the browser can't do it.
 */
export function dragOut(file: () => MidiFile, chip: DragChip) {
  if (!canDragOut) return {};
  let name = '';
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      const midi = file();
      name = midi.name;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('DownloadURL', downloadUrl(midi));
      showChip(e, chip);
    },
    onDragEnd: (e: DragEvent) => {
      if (e.dataTransfer.dropEffect !== 'none') studio.getState().notify(`Dropped ${name}`);
    },
  };
}
