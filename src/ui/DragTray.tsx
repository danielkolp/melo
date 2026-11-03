import { GripVertical } from 'lucide-react';
import { TRACK_IDS } from '../core/types';
import { canDragOut, dragOut, type DragChip } from '../lib/dragMidi';
import { loopFile, partFile, saveMidi, songFile, type MidiFile } from '../lib/exportMidi';
import { useComposition, useStudio } from '../state/useStudio';
import { TRACK_COLORS, TRACK_LABELS } from '../theme';
import { cx } from './controls';

/** Every part's colour in one swatch, for the files that hold them all. */
const ALL = `linear-gradient(90deg, ${TRACK_IDS.map((t, i) => `${TRACK_COLORS[t]} ${i * 20}% ${(i + 1) * 20}%`).join(', ')})`;

/**
 * The loop as files, on the stage where it's always in reach: drag one onto a track in a DAW
 * (Chrome and Edge), or click to save it.
 */
export function DragTray() {
  const { notes } = useComposition();
  const song = useStudio((s) => s.playMode === 'song');
  return (
    <div className="pointer-events-auto hidden shrink-0 flex-col items-end gap-1.5 md:flex">
      <span className="eyebrow flex items-center gap-1 pr-2">
        <GripVertical size={11} strokeWidth={2} />
        {canDragOut ? 'Drag into your DAW' : 'Save as MIDI'}
      </span>
      <div
        role="group"
        aria-label={canDragOut ? 'Drag into your DAW' : 'Save as MIDI'}
        className="flex gap-0.5 rounded-full bg-panel/85 p-1 shadow-[0_1px_3px_rgba(0,0,0,0.06)] ring-1 ring-line backdrop-blur-sm"
      >
        {song ? (
          <FileChip chip={{ label: 'Song', color: ALL }} what="the whole song" file={songFile} />
        ) : (
          <FileChip chip={{ label: 'All parts', color: ALL }} what="every part" file={loopFile} />
        )}
        {TRACK_IDS.map((track) => (
          <FileChip
            key={track}
            chip={{ label: TRACK_LABELS[track], color: TRACK_COLORS[track] }}
            what={`the ${TRACK_LABELS[track].toLowerCase()}`}
            file={() => partFile(track)}
            disabled={!notes.some((n) => n.track === track)}
          />
        ))}
      </div>
    </div>
  );
}

interface FileChipProps {
  chip: DragChip;
  /** How the tooltip names it: "the bass". */
  what: string;
  file(): MidiFile;
  disabled?: boolean;
}

function FileChip({ chip, what, file, disabled }: FileChipProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => saveMidi(file())}
      title={canDragOut ? `Drag ${what} onto a track in your DAW, or click to save it` : `Save ${what} as a .mid. Dragging into a DAW needs Chrome or Edge.`}
      className={cx(
        'flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12px] text-fg-dim transition-colors duration-150 hover:bg-tint hover:text-fg',
        'disabled:pointer-events-none disabled:opacity-35',
        canDragOut && 'cursor-grab active:cursor-grabbing',
      )}
      {...dragOut(file, chip)}
    >
      <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: chip.color }} />
      {chip.label}
    </button>
  );
}
