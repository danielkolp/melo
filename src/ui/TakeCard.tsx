import type { TrackId } from '../core/types';
import type { Variation } from '../core/variations';
import { canDragOut, dragOut } from '../lib/dragMidi';
import { takeFile } from '../lib/exportMidi';
import { cx } from './controls';
import { NoteSketch } from './NoteSketch';

interface TakeCardProps {
  take: Variation;
  track: TrackId;
  /** Shown before the label, and in the file's name; 0 for the original. */
  index: number;
  picked: boolean;
  ticks: number;
  color: string;
  wide?: boolean;
  /** What the card is, for its tooltip. */
  what: string;
  onPick(): void;
}

/** One take of a part to audition: a sketch of its notes and what it is. Click to load it, or drag it into a DAW. */
export function TakeCard({ take, track, index, picked, ticks, color, wide, what, onPick }: TakeCardProps) {
  return (
    <button
      type="button"
      aria-pressed={picked}
      onClick={onPick}
      title={canDragOut ? `${what}. Drag it into your DAW to drop in this take alone.` : what}
      {...dragOut(() => takeFile(track, take, index), { label: index ? `${index} · ${take.label}` : 'Original', color })}
      className={cx(
        'group flex w-full flex-col gap-1.5 rounded-lg p-2 text-left transition-colors duration-150',
        picked ? 'bg-tint ring-1 ring-line-strong' : 'bg-well hover:bg-tint',
      )}
    >
      <NoteSketch notes={take.notes} ticks={ticks} color={color} className={cx('w-full rounded-[3px] bg-panel', wide ? 'h-10' : 'h-9')} />
      <span className={cx('flex items-start gap-1.5 text-[11.5px] leading-snug', !wide && 'min-h-[2lh]')}>
        {index > 0 && <span className="readout mt-px text-[9.5px] text-fg-faint">{index}</span>}
        <span className={cx('line-clamp-2', picked ? 'text-fg' : 'text-fg-dim group-hover:text-fg')}>{take.label}</span>
      </span>
    </button>
  );
}
