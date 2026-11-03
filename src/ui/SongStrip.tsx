import { ChevronLeft, ChevronRight, Copy, Dices, Download, Trash2 } from 'lucide-react';
import { useMemo, type CSSProperties, type MouseEvent } from 'react';
import { seek } from '../audio/playback';
import {
  DRUM_LEVELS,
  FILTER_MOVES,
  MATERIALS,
  MATERIAL_IDS,
  SECTION_KINDS,
  SECTION_KIND_IDS,
  SECTION_LENGTHS,
  sectionAt,
  sectionEnergy,
  songLength,
  resolveMaterial,
  songSpans,
  templateName,
  type SongSpan,
} from '../core/arrangement';
import { formatClock, ticksToSeconds } from '../core/format';
import { TICKS_PER_BAR, TRACK_IDS, type DrumLevel, type FilterMove, type SectionKind, type SectionMaterial, type SongSection } from '../core/types';
import { canDragOut, dragOut } from '../lib/dragMidi';
import { exportSong, songFile } from '../lib/exportMidi';
import { studio, useComposition, useStudio } from '../state/useStudio';
import { TRACK_COLORS, TRACK_LABELS } from '../theme';
import { IconButton, Segmented, Select, cx } from './controls';
import { useSongTicks } from './usePlaybackTicks';

/** Narrowest a bar may get before the timeline scrolls sideways. */
const PX_PER_BAR = 7;
const DRUM_LABELS: Record<DrumLevel, string> = { off: 'Off', light: 'Light', full: 'Full', build: 'Build' };
const FILTER_LABELS: Record<FilterMove, string> = { open: 'Open', dark: 'Dark', rise: 'Rise' };
/** Bar heights for the drum cell's little meter, 0–1. */
const DRUM_METER: Record<DrumLevel, number[]> = { off: [], light: [0.35, 0.35], full: [0.8, 0.8, 0.8, 0.8], build: [0.25, 0.45, 0.7, 1] };

const name = (span: SongSpan) => `${SECTION_KINDS[span.section.kind].label} (section ${span.index + 1})`;

function RowLabels() {
  const label = (text: string, color?: string) => (
    <div key={text} className="mb-[3px] flex h-[18px] items-center gap-2">
      <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: color ?? 'var(--color-fg-faint)' }} />
      <span className="truncate text-[11.5px] text-fg-dim">{text}</span>
    </div>
  );
  return (
    <div aria-hidden className="w-[78px] shrink-0 pt-[58px]">
      {TRACK_IDS.map((t) => label(TRACK_LABELS[t], TRACK_COLORS[t]))}
      {label('Drums')}
    </div>
  );
}

function DrumMeter({ level }: { level: DrumLevel }) {
  const bars = DRUM_METER[level];
  return (
    <span className="flex h-full items-end gap-[2px] px-1.5 py-[3px]">
      {bars.map((h, i) => (
        <span key={i} className="w-[3px] rounded-[1px] bg-fg-dim" style={{ height: `${h * 100}%` }} />
      ))}
    </span>
  );
}

function Column({ span, material, total, selected, current }: { span: SongSpan; material: SectionMaterial; total: number; selected: boolean; current: boolean }) {
  const { section } = span;
  const kind = SECTION_KINDS[section.kind];
  const plays = MATERIALS[material];
  const energy = sectionEnergy(section);
  const playing = useStudio((s) => s.isPlaying);
  const shade =
    section.filter === 'dark'
      ? 'color-mix(in oklab, var(--color-fg) 12%, transparent)'
      : section.filter === 'rise'
        ? 'linear-gradient(to right, color-mix(in oklab, var(--color-fg) 16%, transparent), transparent)'
        : undefined;
  const next = DRUM_LEVELS[(DRUM_LEVELS.indexOf(section.drums) + 1) % DRUM_LEVELS.length];

  return (
    <div className="min-w-0 px-[1px]" style={{ width: `${((span.end - span.start) / total) * 100}%` }}>
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`${name(span)}, ${section.bars} bars, plays ${plays.label}`}
        title={`${kind.label} · ${section.bars} bars · ${plays.label} — ${kind.reason}`}
        onClick={() => {
          studio.getState().selectSection(selected ? null : section.id);
          if (!playing) seek(span.start);
        }}
        className={cx(
          'relative mb-1 flex h-[34px] w-full flex-col items-start justify-center overflow-hidden rounded-md px-1.5 text-left transition-shadow duration-150',
          selected ? 'ring-[1.5px] ring-fg' : current ? 'ring-1 ring-fg-faint' : 'hover:ring-1 hover:ring-line-strong',
        )}
        style={{ background: `color-mix(in oklab, var(--color-fg) ${Math.round(3 + energy * 13)}%, var(--color-well))` }}
      >
        {shade && <span aria-hidden className="pointer-events-none absolute inset-0" style={{ background: shade }} />}
        <span className="relative w-full truncate text-[12px] leading-tight font-medium text-fg">{kind.label}</span>
        <span className="readout relative w-full truncate text-[10px] text-fg-faint">
          {section.bars} · {plays.short}
        </span>
      </button>
      {TRACK_IDS.map((track) => {
        const on = section.parts[track];
        return (
          <button
            key={track}
            type="button"
            aria-pressed={on}
            aria-label={`${TRACK_LABELS[track]} in ${name(span)}`}
            title={`${on ? 'Take out' : 'Bring in'} the ${TRACK_LABELS[track].toLowerCase()}`}
            onClick={() => studio.getState().toggleSectionPart(section.id, track)}
            className={cx(
              'mb-[3px] block h-[18px] w-full rounded-[4px] transition-[opacity,box-shadow] duration-150',
              on ? 'hover:opacity-80' : 'ring-1 ring-line ring-inset hover:ring-line-strong',
            )}
            style={on ? { background: TRACK_COLORS[track] } : undefined}
          />
        );
      })}
      <button
        type="button"
        aria-label={`Drums in ${name(span)}: ${DRUM_LABELS[section.drums]}`}
        title={`Drums: ${DRUM_LABELS[section.drums]} (click for ${DRUM_LABELS[next]})`}
        onClick={() => studio.getState().cycleSectionDrums(section.id)}
        className={cx(
          'mb-[3px] block h-[18px] w-full overflow-hidden rounded-[4px] transition-colors duration-150',
          section.drums === 'off' ? 'ring-1 ring-line ring-inset hover:ring-line-strong' : 'bg-tint hover:bg-line',
        )}
      >
        <DrumMeter level={section.drums} />
      </button>
    </div>
  );
}

function Ruler({ total }: { total: number }) {
  const bars = total / TICKS_PER_BAR;
  const every = bars > 96 ? 16 : 8;
  const marks = Array.from({ length: Math.floor((bars - 1) / every) + 1 }, (_, i) => i * every);
  const jump = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const bar = Math.floor(((e.clientX - rect.left) / rect.width) * bars);
    seek(Math.max(0, Math.min(bars - 1, bar)) * TICKS_PER_BAR);
  };
  return (
    <div role="presentation" onClick={jump} className="relative mb-1 h-[16px] cursor-pointer" title="Click to move the playhead">
      {marks.map((bar) => (
        <span key={bar} className="readout absolute top-0 text-[9.5px] text-fg-faint" style={{ left: `${(bar / bars) * 100}%` }}>
          <span className="mr-1 inline-block h-[7px] w-px bg-line-strong align-middle" />
          {bar + 1}
        </span>
      ))}
    </div>
  );
}

function Timeline({ spans, total, selected }: { spans: SongSpan[]; total: number; selected: string | null }) {
  const ticks = useSongTicks();
  const playing = useStudio((s) => s.isPlaying);
  const current = playing ? sectionAt(spans, ticks) : undefined;
  const sections = spans.map((s) => s.section);
  return (
    <div className="quiet-scroll min-w-0 flex-1 overflow-x-auto pb-2">
      <div className="relative" style={{ minWidth: (total / TICKS_PER_BAR) * PX_PER_BAR }}>
        <Ruler total={total} />
        <div className="flex">
          {spans.map((span) => (
            <Column
              key={span.section.id}
              span={span}
              material={resolveMaterial(sections, span.index)}
              total={total}
              selected={span.section.id === selected}
              current={span === current}
            />
          ))}
        </div>
        <span
          aria-hidden
          className="pointer-events-none absolute top-0 bottom-2 w-px bg-fg"
          style={{ left: `${(Math.min(ticks, total) / total) * 100}%`, opacity: playing ? 0.9 : 0.4 } as CSSProperties}
        />
      </div>
    </div>
  );
}

function Inspector({ span, count }: { span: SongSpan | undefined; count: number }) {
  const { settings, arrangement } = useComposition();
  const loopBars = settings.bars;
  if (!span) {
    return (
      <p className="border-t border-line px-4 py-3 text-[12px] text-fg-faint md:px-5">
        Click a section to shape it. Click the coloured cells to bring parts in and out, and the drum cells to change the beat.
      </p>
    );
  }
  const { section } = span;
  const id = section.id;
  const s = studio.getState();
  const lengths = SECTION_LENGTHS.filter((b) => b % loopBars === 0);
  const auto = resolveMaterial(
    arrangement.sections.map((x) => (x.id === id ? { ...x, material: 'auto' as const } : x)),
    span.index,
  );
  const material = resolveMaterial(arrangement.sections, span.index);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-4 py-2.5 md:px-5">
      <div className="w-[124px]">
        <Select<SectionKind>
          label="Section type"
          value={section.kind}
          options={SECTION_KIND_IDS.map((k) => ({ value: k, label: SECTION_KINDS[k].label }))}
          onChange={(kind) => s.updateSection(id, { kind })}
        />
      </div>
      <div className="w-[150px]">
        <Select<NonNullable<SongSection['material']>>
          label="Material"
          value={section.material ?? 'auto'}
          options={[
            { value: 'auto', label: `Auto (${MATERIALS[auto].short})` },
            ...MATERIAL_IDS.map((m) => ({ value: m, label: MATERIALS[m].label })),
          ]}
          onChange={(m) => s.updateSection(id, { material: m })}
        />
      </div>
      <Segmented
        label="Length in bars"
        value={section.bars}
        options={lengths.map((b) => ({ value: b, label: String(b), title: `${b} bars` }))}
        onChange={(bars) => s.updateSection(id, { bars })}
      />
      <Segmented
        label="Drums"
        value={section.drums}
        options={DRUM_LEVELS.map((d) => ({ value: d, label: DRUM_LABELS[d] }))}
        onChange={(drums) => s.updateSection(id, { drums })}
      />
      <Segmented
        label="Filter"
        value={section.filter}
        options={FILTER_MOVES.map((f) => ({ value: f, label: FILTER_LABELS[f] }))}
        onChange={(filter) => s.updateSection(id, { filter })}
      />
      <div className="flex items-center">
        <IconButton size="sm" label="Move earlier" disabled={span.index === 0} onClick={() => s.moveSection(id, -1)}>
          <ChevronLeft size={15} strokeWidth={1.7} />
        </IconButton>
        <IconButton size="sm" label="Move later" disabled={span.index === count - 1} onClick={() => s.moveSection(id, 1)}>
          <ChevronRight size={15} strokeWidth={1.7} />
        </IconButton>
        <IconButton size="sm" label="Duplicate section" onClick={() => s.duplicateSection(id)}>
          <Copy size={14} strokeWidth={1.7} />
        </IconButton>
        <IconButton size="sm" label="Delete section" disabled={count <= 1} onClick={() => s.removeSection(id)}>
          <Trash2 size={14} strokeWidth={1.7} />
        </IconButton>
      </div>
      <p className="min-w-[220px] flex-1 text-[12px] leading-snug text-fg-faint">
        {SECTION_KINDS[section.kind].reason} {MATERIALS[material].reason}
      </p>
    </div>
  );
}

/** The arrangement as a timeline: sections across, parts down. Shown in song mode, under the roll. */
export function SongStrip() {
  const { arrangement, settings } = useComposition();
  const selected = useStudio((s) => s.selectedSection);
  const spans = useMemo(() => songSpans(arrangement), [arrangement]);
  const total = songLength(spans);

  return (
    <section aria-label="Song arrangement" className="shrink-0 border-t border-line bg-panel">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-2.5 pb-1.5 md:px-5">
        <h2 className="eyebrow">Song</h2>
        <span className="readout text-[11px] text-fg-faint">
          {total / TICKS_PER_BAR} bars · {formatClock(ticksToSeconds(total, settings.bpm))}
        </span>
        <span className="text-[12px] text-fg-dim">{templateName(arrangement)}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="w-[132px]">
            <Select<SectionKind | ''>
              label="Add a section"
              value=""
              options={[{ value: '', label: 'Add section…' }, ...SECTION_KIND_IDS.map((k) => ({ value: k, label: SECTION_KINDS[k].label }))]}
              onChange={(kind) => kind && studio.getState().addSection(kind)}
            />
          </div>
          <IconButton size="sm" label="Suggest another structure" onClick={() => studio.getState().suggestArrangement()}>
            <Dices size={15} strokeWidth={1.6} />
          </IconButton>
          <button
            type="button"
            onClick={exportSong}
            title={`Download the whole song as a .mid file, with drums and section markers${canDragOut ? ', or drag it straight into your DAW' : ''}`}
            {...dragOut(songFile, { label: 'Song' })}
            className="flex h-8 items-center gap-1.5 rounded-full bg-fg px-3.5 text-[12.5px] font-medium text-inverse transition-all duration-150 hover:opacity-90 active:scale-[0.98]"
          >
            <Download size={13} strokeWidth={1.9} />
            Export song
          </button>
        </div>
      </header>
      <div className="flex gap-2 px-4 md:px-5">
        <RowLabels />
        <Timeline spans={spans} total={total} selected={selected} />
      </div>
      <Inspector span={spans.find((s) => s.section.id === selected)} count={spans.length} />
    </section>
  );
}
