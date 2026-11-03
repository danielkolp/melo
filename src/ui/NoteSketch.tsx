import { TICKS_PER_BAR } from '../core/types';
import { cx } from './controls';

interface Props {
  notes: readonly { pitch: number; start: number; duration: number }[];
  /** Length shown, in ticks. */
  ticks: number;
  color: string;
  className?: string;
}

/** A tiny piano roll: each note a bar of colour, with faint bar lines. */
export function NoteSketch({ notes, ticks, color, className }: Props) {
  const pitches = notes.map((n) => n.pitch);
  const high = Math.max(...pitches, 60) + 1;
  const low = Math.min(...pitches, high - 12) - 1;
  const rows = high - low + 1;
  const gap = ticks * 0.004;
  // Wide ranges would leave hairlines; notes stay at least a twelfth of the height.
  const thick = Math.max(1, rows / 12);
  return (
    <svg viewBox={`0 0 ${ticks} ${rows}`} preserveAspectRatio="none" aria-hidden className={cx('block', className)}>
      {Array.from({ length: Math.ceil(ticks / TICKS_PER_BAR) - 1 }, (_, i) => (
        <line
          key={i}
          x1={(i + 1) * TICKS_PER_BAR}
          x2={(i + 1) * TICKS_PER_BAR}
          y1={0}
          y2={rows}
          stroke="var(--color-line-strong)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {notes.map((n, i) =>
        n.start < ticks ? (
          <rect
            key={i}
            x={n.start}
            y={high - n.pitch + 0.5 - thick / 2}
            width={Math.max(gap, Math.min(n.duration, ticks - n.start) - gap)}
            height={thick}
            fill={color}
          />
        ) : null,
      )}
    </svg>
  );
}
