import { studio } from '../state/useStudio';

/** Reads a dropped or chosen file and opens the import dialog on it. The dialog says if it isn't MIDI. */
export async function openMidiFile(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  studio.getState().setPendingImport({ name: file.name, bytes });
}
