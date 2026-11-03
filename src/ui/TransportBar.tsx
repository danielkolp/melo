import { Dices, Download, Drum, ListMusic, Pause, Play, Redo2, Repeat, Square, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { seek, stopPlayback, togglePlayback } from '../audio/playback';
import { songLength, songSpans } from '../core/arrangement';
import { formatClock, formatPosition, ticksToSeconds } from '../core/format';
import { STEP, totalTicks } from '../core/types';
import { canDragOut, dragOut } from '../lib/dragMidi';
import { exportMidi, loopFile } from '../lib/exportMidi';
import { MAX_BPM, MIN_BPM } from '../state/store';
import { studio, useComposition, useStudio } from '../state/useStudio';
import { IconButton, Kbd } from './controls';
import { usePlaybackTicks, useSongTicks } from './usePlaybackTicks';

function Divider() {
  return <span aria-hidden className="mx-1.5 hidden h-6 w-px bg-line md:block" />;
}

function TempoField() {
  const bpm = useComposition().settings.bpm;
  const [draft, setDraft] = useState(String(bpm));
  useEffect(() => setDraft(String(bpm)), [bpm]);
  const commit = () => {
    const value = Number(draft);
    if (Number.isFinite(value) && value > 0) studio.getState().setTempo(value);
    else setDraft(String(bpm));
  };
  return (
    <label className="flex h-8 items-center gap-1.5 rounded-lg bg-well px-2.5 ring-1 ring-transparent transition-shadow focus-within:ring-fg-faint">
      <input
        type="number"
        inputMode="numeric"
        min={MIN_BPM}
        max={MAX_BPM}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            studio.getState().setTempo(bpm + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
          }
        }}
        aria-label="Tempo in BPM"
        className="no-spin readout w-[34px] bg-transparent text-right text-[13px] text-fg outline-none"
      />
      <span className="eyebrow">bpm</span>
    </label>
  );
}

/** In song mode the readout and slider cover the whole arrangement. */
function Position() {
  const { settings, arrangement } = useComposition();
  const song = useStudio((s) => s.playMode === 'song');
  const loopTicks = usePlaybackTicks();
  const songTicks = useSongTicks();
  const songEnd = useMemo(() => songLength(songSpans(arrangement)), [arrangement]);
  const end = song ? songEnd : totalTicks(settings.bars);
  const pos = song ? Math.min(songTicks, end) : loopTicks % end;
  const fill = `${(pos / end) * 100}%`;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <span className="readout hidden w-[50px] shrink-0 text-[12px] text-fg sm:block" aria-label="Position (bar.beat.sixteenth)">
        {formatPosition(pos)}
      </span>
      <input
        type="range"
        className="range min-w-[80px] flex-1"
        min={0}
        max={end}
        step={STEP}
        value={pos}
        aria-label="Playback position"
        style={{ '--fill': fill } as CSSProperties}
        onChange={(e) => seek(Number(e.target.value))}
      />
      <span className="readout shrink-0 text-[11px] text-fg-faint">
        {formatClock(ticksToSeconds(pos, settings.bpm))} / {formatClock(ticksToSeconds(end, settings.bpm))}
      </span>
    </div>
  );
}

/** Fixed-height bar: transport on the left, position in the middle, history and output on the right. */
export function TransportBar() {
  const isPlaying = useStudio((s) => s.isPlaying);
  const loop = useStudio((s) => s.loop);
  const beat = useStudio((s) => s.beat);
  const song = useStudio((s) => s.playMode === 'song');
  const canUndo = useStudio((s) => s.history.past.length > 0);
  const canRedo = useStudio((s) => s.history.future.length > 0);

  return (
    <footer className="sticky bottom-0 z-20 flex shrink-0 flex-wrap items-center gap-x-1 gap-y-3 border-t border-line bg-panel px-4 py-3 md:h-16 md:flex-nowrap md:py-0 md:pr-4 md:pl-5">
      <button
        type="button"
        onClick={() => void togglePlayback()}
        aria-label={isPlaying ? 'Pause' : 'Play'}
        title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
        className="mr-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-fg text-inverse transition-transform duration-150 hover:scale-[1.04] active:scale-95"
      >
        {isPlaying ? <Pause size={16} fill="currentColor" strokeWidth={0} /> : <Play size={16} fill="currentColor" strokeWidth={0} className="translate-x-[1px]" />}
      </button>
      <IconButton label="Stop and return to start" onClick={stopPlayback}>
        <Square size={12} fill="currentColor" strokeWidth={0} />
      </IconButton>
      <IconButton label={loop ? 'Loop on (L)' : 'Loop off (L)'} active={loop} aria-pressed={loop} onClick={() => studio.getState().setLoop(!loop)}>
        <Repeat size={15} strokeWidth={1.7} />
      </IconButton>
      <IconButton
        label={beat ? 'Guide beat on (B)' : 'Guide beat off (B)'}
        active={beat}
        aria-pressed={beat}
        onClick={() => studio.getState().setBeat(!beat)}
      >
        <Drum size={15} strokeWidth={1.7} />
      </IconButton>
      <IconButton
        label={song ? 'Song mode on: plays the arrangement (S)' : 'Song mode off: plays the loop (S)'}
        active={song}
        aria-pressed={song}
        onClick={() => studio.getState().setPlayMode(song ? 'loop' : 'song')}
      >
        <ListMusic size={16} strokeWidth={1.7} />
      </IconButton>
      <Divider />
      <TempoField />
      <Divider />
      <div className="order-last w-full md:order-none md:w-auto md:min-w-0 md:flex-1">
        <Position />
      </div>
      <Divider />
      <div className="flex w-full items-center gap-1 md:w-auto">
        <IconButton label="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => studio.getState().undo()}>
          <Undo2 size={15} strokeWidth={1.7} />
        </IconButton>
        <IconButton label="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => studio.getState().redo()}>
          <Redo2 size={15} strokeWidth={1.7} />
        </IconButton>
        <div className="ml-auto flex items-center gap-2 md:ml-2">
          <button
            type="button"
            onClick={() => studio.getState().generate()}
            title="Generate a new idea (G)"
            className="flex h-9 items-center gap-2 rounded-full bg-raised px-4 text-[13px] font-medium text-fg shadow-[0_1px_2px_rgba(0,0,0,0.08)] ring-1 ring-line transition-all duration-150 hover:ring-line-strong active:scale-[0.98]"
          >
            <Dices size={15} strokeWidth={1.8} />
            Generate
            <span className="hidden xl:inline">
              <Kbd>G</Kbd>
            </span>
          </button>
          <button
            type="button"
            onClick={exportMidi}
            title={canDragOut ? 'Download a .mid file with one track per part, or drag it straight into your DAW' : 'Download a .mid file with one track per part'}
            {...dragOut(loopFile, { label: 'Whole loop' })}
            className="flex h-9 items-center gap-2 rounded-full bg-fg px-4 text-[13px] font-medium text-inverse transition-all duration-150 hover:opacity-90 active:scale-[0.98]"
          >
            <Download size={14} strokeWidth={1.9} />
            Export MIDI
          </button>
        </div>
      </div>
    </footer>
  );
}
