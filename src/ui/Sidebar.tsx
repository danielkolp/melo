import { ChevronRight, Dices, Drum, FileMusic } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { PATCHES, autoPatch, patchesFor, resolvePatch, type PatchId } from '../audio/patches';
import { previewSound } from '../audio/playback';
import { BRASS_ENTRIES, BRASS_KINDS, brassPlan } from '../core/brass';
import { REGISTERS, chordAt } from '../core/generator';
import { formatSeed, parseSeed } from '../core/random';
import { STYLES, STYLE_IDS } from '../core/styles';
import {
  SCALES,
  SCALE_IDS,
  chordSymbol,
  keyLabel,
  noteName,
  pitchClassName,
  prefersFlats,
  romanNumeral,
  scalePitchClasses,
} from '../core/theory';
import { TRACK_IDS, totalTicks, type BarCount } from '../core/types';
import { canDragOut, dragOut } from '../lib/dragMidi';
import { exportPart, partFile } from '../lib/exportMidi';
import type { SidebarTab } from '../state/store';
import { studio, useComposition, useStudio } from '../state/useStudio';
import { TRACK_COLORS, TRACK_LABELS } from '../theme';
import { AutomationSection } from './AutomationSection';
import { Group, IconButton, Segmented, Select, Slider, Switch, cx } from './controls';
import { PhrasingSection } from './PhrasingSection';
import { UploadSection } from './UploadSection';
import { usePlaybackTicks } from './usePlaybackTicks';

const TABS: { id: SidebarTab; label: string }[] = [
  { id: 'tracks', label: 'Tracks' },
  { id: 'composition', label: 'Composition' },
  { id: 'sound', label: 'Sound' },
];

/** The right-hand panel: three tabs, collapsible as a whole. */
export function Sidebar() {
  const open = useStudio((s) => s.sidebarOpen);
  const tab = useStudio((s) => s.sidebarTab);

  return (
    <aside
      aria-label="Panel"
      className={cx(
        'shrink-0 overflow-hidden bg-panel transition-[width] duration-300 ease-[cubic-bezier(0.2,0.7,0.2,1)] lg:border-l lg:border-line',
        open ? 'lg:w-[332px]' : 'hidden lg:block lg:w-0 lg:border-l-0',
      )}
    >
      <div className="flex h-full flex-col lg:w-[332px]">
        <div role="tablist" aria-label="Panel sections" className="flex shrink-0 gap-1 px-4 pt-3 pb-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              onClick={() => studio.getState().setSidebarTab(t.id)}
              className={cx(
                'rounded-md px-2.5 py-1.5 text-[13px] transition-colors duration-150',
                tab === t.id ? 'bg-tint text-fg' : 'text-fg-faint hover:text-fg-dim',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={`panel-${tab}`}
          aria-labelledby={`tab-${tab}`}
          className="quiet-scroll min-h-0 flex-1 space-y-7 overflow-y-auto px-5 pt-3 pb-8"
        >
          {tab === 'tracks' && <TracksTab />}
          {tab === 'composition' && <CompositionTab />}
          {tab === 'sound' && <SoundTab />}
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Tracks

function TracksTab() {
  return (
    <>
      <UploadSection />
      <PartsGroup />
    </>
  );
}

function PartsGroup() {
  const { notes, source, settings } = useComposition();
  const brass = brassPlan(settings);
  const muted = useStudio((s) => s.muted);
  const active = useStudio((s) => s.activeTrack);
  const held = new Set(source?.parts.map((p) => p.track));
  return (
    <Group title="Parts">
      <ul className="-mx-2 space-y-0.5">
        {TRACK_IDS.map((track, i) => {
          const count = notes.filter((n) => n.track === track).length;
          const isActive = track === active;
          return (
            <li
              key={track}
              className={cx(
                'flex items-center gap-2 rounded-lg py-2 pr-1.5 pl-2.5 transition-colors duration-150',
                isActive ? 'bg-tint' : 'hover:bg-well',
              )}
            >
              <button
                type="button"
                aria-pressed={isActive}
                onClick={() => studio.getState().setActiveTrack(track)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                title={`Draw ${TRACK_LABELS[track].toLowerCase()} notes (${i + 1})`}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-[3px] transition-opacity"
                  style={{ background: TRACK_COLORS[track], opacity: muted[track] ? 0.3 : 1 }}
                />
                <span className="min-w-0">
                  <span className={cx('block text-[14px] leading-tight', muted[track] ? 'text-fg-faint' : 'text-fg')}>
                    {TRACK_LABELS[track]}
                  </span>
                  {track === 'brass' && !held.has(track) ? (
                    // What this loop's brass does, in place of its range.
                    <span className="readout block text-[10px] text-fg-faint" title={`${count} notes`}>
                      {BRASS_KINDS[brass.kind]} · {BRASS_ENTRIES[brass.entry]}
                    </span>
                  ) : (
                    <span className="readout block text-[10px] text-fg-faint">
                      {noteName(REGISTERS[track].low)}–{noteName(REGISTERS[track].high)} · {count} notes
                    </span>
                  )}
                </span>
              </button>
              <IconButton
                size="sm"
                label={
                  canDragOut
                    ? `Drag the ${TRACK_LABELS[track].toLowerCase()} into your DAW, or click to save it`
                    : `Save the ${TRACK_LABELS[track].toLowerCase()} as a .mid`
                }
                disabled={!count}
                onClick={() => exportPart(track)}
                className={canDragOut ? 'cursor-grab active:cursor-grabbing' : undefined}
                {...dragOut(() => partFile(track), { label: TRACK_LABELS[track], color: TRACK_COLORS[track] })}
              >
                <FileMusic size={15} strokeWidth={1.6} />
              </IconButton>
              {held.has(track) ? (
                <span
                  className="readout flex h-7 items-center rounded-md px-1.5 text-[9.5px] text-fg-faint"
                  title={`Your uploaded ${TRACK_LABELS[track].toLowerCase()}: kept when the rest is regenerated`}
                >
                  yours
                </span>
              ) : (
                <IconButton
                  size="sm"
                  label={`Regenerate ${TRACK_LABELS[track].toLowerCase()}`}
                  onClick={() => studio.getState().regenerateTrack(track)}
                >
                  <Dices size={15} strokeWidth={1.6} />
                </IconButton>
              )}
              <Switch
                label={`${muted[track] ? 'Unmute' : 'Mute'} ${TRACK_LABELS[track].toLowerCase()}`}
                checked={!muted[track]}
                color={TRACK_COLORS[track]}
                onChange={() => studio.getState().toggleMute(track)}
              />
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[12px] leading-relaxed text-fg-faint">
        Pick a part (or press 1–5) to draw into it, then double-click the grid. The dice rewrite one part and leave the rest.{' '}
        {canDragOut
          ? 'Drag a part’s file icon onto a track in Ableton or any DAW to drop in just that part.'
          : 'The file icon saves just that part as a .mid.'}
      </p>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Composition

function CompositionTab() {
  return (
    <>
      <StyleGroup />
      <PhrasingSection />
      <HarmonyGroup />
      <ShapeGroup />
    </>
  );
}

function StyleGroup() {
  const { settings } = useComposition();
  const style = STYLES[settings.style];
  return (
    <Group
      title="Style"
      aside={
        <span className="readout text-[10px] text-fg-faint">
          {style.bpm} bpm · {style.swing === 50 ? 'straight' : `${style.swing}% swing`}
        </span>
      }
    >
      <Segmented
        label="Style"
        value={settings.style}
        options={STYLE_IDS.map((id) => ({ value: id, label: STYLES[id].short, title: STYLES[id].label }))}
        onChange={(id) => {
          studio.getState().setStyle(id);
          studio.getState().notify(`${STYLES[id].label} · ${STYLES[id].bpm} BPM`);
        }}
      />
    </Group>
  );
}

const WHITE = [0, 2, 4, 5, 7, 9, 11];
const BLACK = [
  { pc: 1, after: 0 },
  { pc: 3, after: 1 },
  { pc: 6, after: 3 },
  { pc: 8, after: 4 },
  { pc: 10, after: 5 },
];

/** One-octave keyboard for choosing the tonic. Dots mark the notes of the current scale. */
function KeyPicker() {
  const { settings } = useComposition();
  const inScale = new Set(scalePitchClasses(settings.key, settings.scale));
  const flats = prefersFlats(settings.key, settings.scale);
  const choose = (pc: number) => studio.getState().changeMusic({ key: pc });
  const dot = (pc: number, onBlack: boolean) => (
    <span
      aria-hidden
      className={cx(
        'h-1 w-1 rounded-full',
        !inScale.has(pc) ? 'bg-transparent' : settings.key === pc ? 'bg-inverse' : onBlack ? 'bg-[#c9c4bb]' : 'bg-fg-faint',
      )}
    />
  );

  return (
    <div role="radiogroup" aria-label="Key" className="relative flex h-[58px] select-none gap-[3px]">
      {WHITE.map((pc) => (
        <button
          key={pc}
          type="button"
          role="radio"
          aria-checked={settings.key === pc}
          aria-label={pitchClassName(pc, flats)}
          onClick={() => choose(pc)}
          className={cx(
            'flex flex-1 flex-col items-center justify-end gap-1.5 rounded-t-sm rounded-b-md pb-1.5 text-[10px] transition-colors duration-150',
            settings.key === pc ? 'bg-fg text-inverse' : 'bg-raised text-fg-faint shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-well',
          )}
        >
          {dot(pc, false)}
          <span className="readout leading-none">{pitchClassName(pc)}</span>
        </button>
      ))}
      {BLACK.map(({ pc, after }) => (
        <button
          key={pc}
          type="button"
          role="radio"
          aria-checked={settings.key === pc}
          aria-label={pitchClassName(pc, flats)}
          onClick={() => choose(pc)}
          style={{ left: `calc(${((after + 1) / 7) * 100}% - 9px)` }}
          className={cx(
            'absolute top-0 z-10 flex h-[32px] w-[18px] items-end justify-center rounded-b-[4px] pb-1.5 ring-2 ring-panel transition-colors duration-150',
            settings.key === pc ? 'bg-fg-dim' : 'bg-ebony hover:bg-fg-dim',
          )}
        >
          {dot(pc, true)}
        </button>
      ))}
    </div>
  );
}

function HarmonyGroup() {
  const { settings, progression } = useComposition();
  const flats = prefersFlats(settings.key, settings.scale);
  const ticks = usePlaybackTicks();
  const playing = useStudio((s) => s.isPlaying);
  const current = playing ? chordAt(progression, ticks % totalTicks(settings.bars)) : null;

  return (
    <Group title="Key & harmony" aside={<span className="text-[13px] text-fg">{keyLabel(settings.key, settings.scale)}</span>}>
      <KeyPicker />
      <div className="mt-2.5">
        <Select
          label="Scale"
          value={settings.scale}
          options={SCALE_IDS.map((id) => ({ value: id, label: SCALES[id].label }))}
          onChange={(scale) => studio.getState().changeMusic({ scale })}
        />
      </div>
      <ol className="mt-3 grid grid-cols-4 gap-1" aria-label="Chord progression">
        {progression.map((chord) => (
          <li
            key={chord.start}
            className={cx('rounded-md px-2 py-1.5 transition-colors duration-150', current === chord ? 'bg-tint' : 'bg-well')}
          >
            <span className="block truncate text-[13px] text-fg">{chordSymbol(chord, flats)}</span>
            <span className="readout block text-[10px] text-fg-faint">{romanNumeral(chord)}</span>
          </li>
        ))}
      </ol>
    </Group>
  );
}

function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-[12.5px] text-fg-faint transition-colors hover:text-fg-dim"
      >
        <ChevronRight size={13} className={cx('transition-transform duration-200', open && 'rotate-90')} />
        {label}
      </button>
      {open && <div className="mt-3 space-y-4">{children}</div>}
    </div>
  );
}

function ShapeGroup() {
  const { settings } = useComposition();
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <Group title="Shape">
      <div className="space-y-4">
        <Segmented<BarCount>
          label="Length"
          value={settings.bars}
          options={[2, 4, 8].map((b) => ({ value: b as BarCount, label: `${b} bars` }))}
          onChange={(bars) => studio.getState().changeMusic({ bars })}
        />
        <Slider
          label="Density"
          value={Math.round(settings.density * 100)}
          min={0}
          max={100}
          display={pct(settings.density)}
          onChange={(v) => studio.getState().changeMusic({ density: v / 100 }, 'density')}
        />
        <div>
          <Slider
            label="Creativity"
            value={Math.round(settings.creativity * 100)}
            min={0}
            max={100}
            display={creativityLabel(settings.creativity)}
            onChange={(v) => studio.getState().changeMusic({ creativity: v / 100 }, 'creativity')}
          />
          <p className="mt-1.5 text-[12px] leading-snug text-fg-faint">{creativityHint(settings.creativity)}</p>
        </div>
        <Disclosure label="Variation, swing and seed">
          <Slider
            label="Variation"
            value={Math.round(settings.variation * 100)}
            min={0}
            max={100}
            display={pct(settings.variation)}
            onChange={(v) => studio.getState().changeMusic({ variation: v / 100 }, 'variation')}
          />
          <Slider
            label="Swing"
            value={settings.swing}
            min={50}
            max={75}
            display={settings.swing === 50 ? 'straight' : `${settings.swing}%`}
            onChange={(v) => studio.getState().setSwing(v)}
          />
          <SeedField />
        </Disclosure>
      </div>
    </Group>
  );
}

function creativityLabel(c: number): string {
  if (c < 0.15) return 'safe';
  if (c < 0.45) return 'a little colour';
  if (c < 0.75) return 'adventurous';
  return 'wild';
}

function creativityHint(c: number): string {
  if (c < 0.15) return 'Diatonic chords, scale notes and the style\'s stock rhythms.';
  if (c < 0.45) return 'Adds chord colours (sus, add9, 11ths) and the odd passing note.';
  if (c < 0.75) return 'Borrowed and passing chords, chromatic approaches, bass fills and pushed stabs.';
  return 'All of that, more often: bolder progressions, leaps, ghost stabs and 808 slides.';
}

function SeedField() {
  const { settings } = useComposition();
  const [draft, setDraft] = useState(formatSeed(settings.seed));
  useEffect(() => setDraft(formatSeed(settings.seed)), [settings.seed]);
  const parsed = parseSeed(draft);
  const apply = () => {
    if (parsed === null) return setDraft(formatSeed(settings.seed));
    if (parsed !== settings.seed) studio.getState().generate(parsed);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <label className="mb-1 flex items-baseline justify-between">
        <span className="text-[13px] text-fg-dim">Seed</span>
        <span className="text-[11px] text-fg-faint">same seed, same idea</span>
      </label>
      <input
        aria-label="Seed"
        value={draft}
        spellCheck={false}
        maxLength={10}
        onChange={(e) => setDraft(e.target.value.toUpperCase())}
        onBlur={apply}
        className={cx(
          'readout w-full rounded-lg bg-well px-3 py-2 text-[13px] tracking-[0.12em] text-fg ring-1 outline-none focus:ring-fg-faint',
          parsed === null ? 'ring-melody/60' : 'ring-transparent',
        )}
      />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Sound

function SoundsGroup() {
  const { settings } = useComposition();
  const { style } = settings;
  const voices = useStudio((s) => s.voices);
  return (
    <Group title="Sounds" aside={<span className="readout text-[10px] text-fg-faint">{STYLES[style].short} palette</span>}>
      <ul className="space-y-3">
        {TRACK_IDS.map((track) => {
          const auto = PATCHES[autoPatch(settings, track)];
          const current = PATCHES[resolvePatch(settings, track, voices[track])];
          return (
            <li key={track}>
              <div className="mb-1.5 flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: TRACK_COLORS[track] }} />
                <span className="text-[12.5px] text-fg-dim">{TRACK_LABELS[track]}</span>
              </div>
              <Select<PatchId | 'auto'>
                label={`${TRACK_LABELS[track]} sound`}
                value={voices[track] ?? 'auto'}
                options={[
                  { value: 'auto', label: `${auto.label} (${track === 'brass' ? 'picked for this loop' : 'style default'})` },
                  ...patchesFor(track).map((p) => ({ value: p.id, label: p.label })),
                ]}
                onChange={(value) => {
                  studio.getState().setVoice(track, value === 'auto' ? null : value);
                  previewSound(track);
                }}
              />
              <p className="mt-1.5 text-[11.5px] leading-snug text-fg-faint">{current.blurb}</p>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[12px] leading-relaxed text-fg-faint">
        Each style brings its own palette. A sound you pick stays when the style changes. Sounds play here only; Export MIDI carries the notes.
      </p>
    </Group>
  );
}

function SoundTab() {
  const beat = useStudio((s) => s.beat);
  const style = STYLES[useComposition().settings.style];
  return (
    <>
      <SoundsGroup />
      <Group title="Playback">
        <div className="flex items-start gap-3 rounded-lg bg-well px-3 py-2.5">
          <Drum size={16} strokeWidth={1.6} className="mt-0.5 shrink-0 text-fg-dim" />
          <div className="min-w-0 flex-1">
            <span className="block text-[13.5px] text-fg">Guide beat</span>
            <span className="block text-[12px] leading-relaxed text-fg-faint">
              {style.label} drums under the loop. Heard only here, not saved or exported.
            </span>
          </div>
          <Switch label={beat ? 'Guide beat off (B)' : 'Guide beat on (B)'} checked={beat} onChange={(on) => studio.getState().setBeat(on)} />
        </div>
      </Group>
      <AutomationSection />
    </>
  );
}
