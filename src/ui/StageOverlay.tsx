import { Minus, Orbit, Plus, Scan, Trash2, X } from 'lucide-react';
import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { SECTION_KINDS, sectionAt, songSpans } from '../core/arrangement';
import { findNote, type NotePatch } from '../core/edit';
import { formatPosition, lengthLabel } from '../core/format';
import { formatSeed } from '../core/random';
import { STYLES } from '../core/styles';
import { keyLabel, noteName, prefersFlats } from '../core/theory';
import { STEP, TICKS_PER_BAR, type NoteEvent } from '../core/types';
import { audition } from '../audio/playback';
import { studio, useComposition, useStudio } from '../state/useStudio';
import { TRACK_COLORS, TRACK_LABELS } from '../theme';
import { IconButton, Segmented } from './controls';
import { DragTray } from './DragTray';
import { useSongTicks } from './usePlaybackTicks';

export function StageOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-4 md:px-7 md:py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <TitleBlock />
        <ViewControls />
      </div>
      <div className="flex items-end justify-between gap-4">
        <InspectorOrHint />
        <DragTray />
      </div>
    </div>
  );
}

/** In song mode, which section the playhead is in and how far through it. */
function SectionReadout() {
  const { arrangement } = useComposition();
  const spans = useMemo(() => songSpans(arrangement), [arrangement]);
  const ticks = useSongTicks();
  const span = sectionAt(spans, ticks);
  if (!span) return null;
  const bar = Math.min(span.section.bars, Math.floor((ticks - span.start) / TICKS_PER_BAR) + 1);
  return (
    <span className="block whitespace-nowrap text-fg-dim">
      {SECTION_KINDS[span.section.kind].label} · bar {bar} of {span.section.bars}
    </span>
  );
}

function TitleBlock() {
  const title = useStudio((s) => s.title);
  const { settings } = useComposition();
  const song = useStudio((s) => s.playMode === 'song');
  const meta = [
    STYLES[settings.style].label,
    `${settings.bpm} BPM`,
    keyLabel(settings.key, settings.scale),
    `${settings.bars} bars`,
    `Seed ${formatSeed(settings.seed)}`,
  ];
  return (
    <div className="pointer-events-auto min-w-0">
      <input
        value={title}
        onChange={(e) => studio.getState().setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        aria-label="Idea name"
        spellCheck={false}
        className="-ml-1.5 w-full max-w-[420px] truncate sm:w-[min(420px,52vw)] rounded-md bg-transparent px-1.5 py-0.5 text-[19px] font-medium tracking-[-0.015em] text-fg outline-none transition-colors hover:bg-fg/[0.04] focus:bg-fg/[0.05] md:text-[21px]"
      />
      <p className="eyebrow mt-0.5 leading-relaxed sm:max-w-[min(560px,52vw)]">
        {meta.map((m, i) => (
          <span key={m}>
            <span className="whitespace-nowrap">{m}</span>
            {i < meta.length - 1 && <span className="px-1.5 text-line-strong">·</span>}{' '}
          </span>
        ))}
        {song && <SectionReadout />}
      </p>
    </div>
  );
}

/** Isometric and Top are the main views; Explore (free orbit) sits beside them as a quieter toggle. */
function ViewControls() {
  const view = useStudio((s) => s.view);
  const exploring = view === 'explore';
  return (
    <div className="pointer-events-auto flex shrink-0 items-center gap-1">
      <Segmented
        label="View"
        value={exploring ? null : view}
        options={[
          { value: 'iso', label: 'Isometric', title: 'Composed angled view (V)' },
          { value: 'top', label: 'Top', title: 'Flat view for precise editing (V)' },
        ]}
        onChange={(v) => studio.getState().setView(v)}
        className="bg-fg/[0.05]"
      />
      <IconButton
        size="sm"
        className="h-8 w-8"
        label={exploring ? 'Leave Explore (E)' : 'Explore: orbit freely (E)'}
        active={exploring}
        aria-pressed={exploring}
        onClick={() => studio.getState().setView(exploring ? 'iso' : 'explore')}
      >
        <Orbit size={15} strokeWidth={1.7} />
      </IconButton>
      <IconButton size="sm" className="h-8 w-8" label="Reframe (F)" onClick={() => studio.getState().resetCamera()}>
        <Scan size={14} strokeWidth={1.8} />
      </IconButton>
    </div>
  );
}

function InspectorOrHint() {
  const selectedId = useStudio((s) => s.selectedId);
  const composition = useComposition();
  const activeTrack = useStudio((s) => s.activeTrack);
  const view = useStudio((s) => s.view);
  const note = selectedId ? findNote(composition, selectedId) : undefined;
  if (note) return <NoteInspector note={note} flats={prefersFlats(composition.settings.key, composition.settings.scale)} />;
  const part = <span style={{ color: TRACK_COLORS[activeTrack] }}>{TRACK_LABELS[activeTrack].toLowerCase()}</span>;
  return (
    <p className="readout hidden min-w-0 max-w-[640px] text-[10.5px] leading-relaxed text-fg-faint md:block">
      {view === 'explore' ? (
        <>Drag to orbit · Right-drag to pan · Scroll to zoom · Notes stay editable</>
      ) : (
        <>Double-click to add a {part} note · Drag a note to move it, its end to resize · Scroll to zoom</>
      )}
    </p>
  );
}

function Stepper({ label, value, onStep }: { label: string; value: ReactNode; onStep(dir: -1 | 1): void }) {
  return (
    <div>
      <span className="eyebrow mb-1 block">{label}</span>
      <div className="flex items-center rounded-md bg-well">
        <button type="button" aria-label={`Decrease ${label.toLowerCase()}`} onClick={() => onStep(-1)} className="p-1.5 text-fg-faint hover:text-fg">
          <Minus size={12} />
        </button>
        <span className="readout flex-1 text-center text-[12px] text-fg">{value}</span>
        <button type="button" aria-label={`Increase ${label.toLowerCase()}`} onClick={() => onStep(1)} className="p-1.5 text-fg-faint hover:text-fg">
          <Plus size={12} />
        </button>
      </div>
    </div>
  );
}

function NoteInspector({ note, flats }: { note: NoteEvent; flats: boolean }) {
  const update = (patch: NotePatch) => studio.getState().updateNote(note.id, patch, `inspect:${note.id}`);
  const color = TRACK_COLORS[note.track];
  return (
    <div
      className="pointer-events-auto w-[300px] rounded-xl bg-raised p-3.5 shadow-[0_10px_32px_rgba(0,0,0,0.12)] ring-1 ring-line"
      role="group"
      aria-label="Selected note"
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2 text-[13.5px] text-fg">
          <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color }} />
          {TRACK_LABELS[note.track]} note
        </span>
        <IconButton size="sm" label="Deselect (Esc)" onClick={() => studio.getState().select(null)}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Stepper
          label="Pitch"
          value={noteName(note.pitch, flats)}
          onStep={(d) => {
            update({ pitch: note.pitch + d });
            audition(note.track, note.pitch + d, note.velocity / 127);
          }}
        />
        <Stepper label="Start" value={formatPosition(note.start)} onStep={(d) => update({ start: note.start + d * STEP })} />
        <Stepper
          label="Length"
          value={lengthLabel(note.duration)}
          onStep={(d) => update({ duration: Math.max(STEP, note.duration + d * STEP) })}
        />
      </div>
      <label className="mt-3 flex items-center gap-3">
        <span className="eyebrow w-[54px]">Velocity</span>
        <input
          type="range"
          className="range flex-1"
          min={1}
          max={127}
          value={note.velocity}
          style={{ '--fill': `${(note.velocity / 127) * 100}%`, '--accent': color } as CSSProperties}
          onChange={(e) => update({ velocity: Number(e.target.value) })}
        />
        <span className="readout w-7 text-right text-[11px] text-fg-dim">{note.velocity}</span>
      </label>
      <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
        <span className="readout text-[10px] text-fg-faint">↑↓ pitch · ←→ move · Alt+←→ length</span>
        <button
          type="button"
          onClick={() => studio.getState().deleteNote(note.id)}
          title="Delete (Del)"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-fg-dim transition-colors hover:bg-tint hover:text-fg"
        >
          <Trash2 size={13} />
          Delete
        </button>
      </div>
    </div>
  );
}
