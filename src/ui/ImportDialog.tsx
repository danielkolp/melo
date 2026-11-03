import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { IMPORT_ROLES, analyseMidi, buildImport, chosenNotes, rankKeys, type ImportAnalysis, type ImportRole, type KeyReading } from '../core/importing';
import { randomSeed } from '../core/random';
import { readMidi } from '../core/readMidi';
import { SCALES, SCALE_IDS, keyLabel, noteName, pitchClassName, prefersFlats } from '../core/theory';
import { TICKS_PER_BAR, type BarCount, type CompositionSettings, type ScaleId } from '../core/types';
import { MAX_BPM, MIN_BPM } from '../state/store';
import { studio, useStudio } from '../state/useStudio';
import { TRACK_COLORS, TRACK_LABELS } from '../theme';
import { IconButton, Segmented, Select, Switch } from './controls';
import { NoteSketch } from './NoteSketch';

const ROLE_LABELS: Record<ImportRole, string> = { ...TRACK_LABELS, skip: 'Leave out' };
const BAR_OPTIONS: BarCount[] = [2, 4, 8];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const listed = (words: readonly string[]) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);
/** Other readings shown beside the detected key: different tonics, and only ones that fit nearly as well. */
const ALTERNATIVE_MARGIN = 0.35;

interface Key {
  key: number;
  scale: ScaleId;
}

/** The key read from the chosen parts and bars, the readings that nearly tie with it, and the parts it came from. */
function useDetectedKey(analysis: ImportAnalysis, roles: readonly ImportRole[], startBar: number, bars: number) {
  return useMemo(() => {
    const notes = chosenNotes(analysis, roles, startBar, bars);
    if (!notes.length) return { detected: { key: analysis.key, scale: analysis.scale }, alternatives: [] as KeyReading[], from: [] as string[] };
    const [best, ...rest] = rankKeys(notes);
    const alternatives: KeyReading[] = [];
    for (const r of rest) {
      if (r.score < best.score - ALTERNATIVE_MARGIN || alternatives.length === 2) break;
      if (r.key !== best.key && !alternatives.some((a) => a.key === r.key)) alternatives.push(r);
    }
    const from = (['bass', 'chords', 'melody', 'counter', 'brass'] as const).filter((t) => roles.includes(t)).map((t) => (t === 'counter' ? 'counter-melody' : t));
    return { detected: { key: best.key, scale: best.scale }, alternatives, from };
  }, [analysis, roles, startBar, bars]);
}

/** Asks what each track of an uploaded file is, then holds those parts in the loop. */
export function ImportDialog() {
  const pending = useStudio((s) => s.pendingImport);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (pending && !d.open) {
      d.showModal();
      // Start on the dialog itself rather than ringing the close button; Tab moves into it.
      d.focus();
    } else if (!pending && d.open) d.close();
  }, [pending]);

  const read = useMemo(() => {
    if (!pending) return null;
    try {
      return { analysis: analyseMidi(readMidi(pending.bytes), pending.name) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'This file could not be read.' };
    }
  }, [pending]);

  const close = () => studio.getState().setPendingImport(null);

  return (
    <dialog
      ref={dialog}
      // The close event arrives a moment late; ignore it if another file has opened the dialog since.
      onClose={(e) => !e.currentTarget.open && close()}
      aria-labelledby="import-title"
      tabIndex={-1}
      className="m-auto outline-none max-h-[calc(100dvh-32px)] w-[600px] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl bg-raised p-0 text-fg shadow-[0_24px_80px_rgba(0,0,0,0.28)] ring-1 ring-line backdrop:bg-[rgba(10,10,12,0.42)]"
    >
      {pending && read && (
        <div className="flex max-h-[calc(100dvh-32px)] flex-col">
          <header className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
            <div className="min-w-0">
              <h2 id="import-title" className="truncate text-[16px] font-semibold tracking-[-0.01em]">
                Import {pending.name}
              </h2>
              {'analysis' in read && read.analysis && <Summary analysis={read.analysis} />}
            </div>
            <IconButton size="sm" label="Close" onClick={close}>
              <X size={16} strokeWidth={1.7} />
            </IconButton>
          </header>
          {'error' in read ? (
            <div className="px-5 pb-5">
              <p role="alert" className="rounded-lg bg-well px-3.5 py-3 text-[13px] text-fg">
                {read.error}
              </p>
              <p className="mt-3 text-[12.5px] text-fg-faint">Choose a Standard MIDI file (.mid) exported from your DAW.</p>
              <div className="mt-4 flex justify-end">
                <button type="button" onClick={close} className="h-9 rounded-full bg-well px-4 text-[13px] text-fg transition-colors hover:bg-tint">
                  OK
                </button>
              </div>
            </div>
          ) : (
            <ImportForm key={pending.name + pending.bytes.length} analysis={read.analysis!} onDone={close} />
          )}
        </div>
      )}
    </dialog>
  );
}

function Summary({ analysis }: { analysis: ImportAnalysis }) {
  const pitched = analysis.tracks.filter((t) => !t.drums).length;
  const [beats, unit] = analysis.timeSignature;
  return (
    <p className="readout mt-1 text-[10.5px] text-fg-faint">
      {plural(pitched, 'part')} · {plural(analysis.length, 'bar')} · {Math.round(analysis.bpm)} BPM
      {(beats !== 4 || unit !== 4) && ` · ${beats}/${unit}, read as 4/4`}
    </p>
  );
}

function ImportForm({ analysis, onDone }: { analysis: ImportAnalysis; onDone(): void }) {
  const [roles, setRoles] = useState<ImportRole[]>(() => analysis.tracks.map((t) => t.guess));
  const [bars, setBars] = useState<BarCount>(analysis.bars);
  const [startBar, setStartBar] = useState(analysis.firstBar);
  /** A key picked by hand; until then the key follows what is read from the chosen parts and bars. */
  const [picked, setPicked] = useState<Key | null>(null);
  const [useFileTempo, setUseFileTempo] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const starts: number[] = [];
  for (let b = analysis.firstBar; b < analysis.firstBar + analysis.length; b += bars) starts.push(b);
  const start = starts.includes(startBar) ? startBar : starts[0];
  const chosen = roles.filter((r) => r !== 'skip');
  const clash = chosen.find((r, i) => chosen.indexOf(r) !== i);
  const bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(analysis.bpm)));
  const { detected, alternatives, from } = useDetectedKey(analysis, roles, start, bars);
  const { key, scale } = picked ?? detected;
  const flats = prefersFlats(key, scale);

  const submit = () => {
    try {
      const source = buildImport(analysis, { roles, bars, startBar: start, key, scale }, randomSeed());
      const patch: Partial<CompositionSettings> = { key, scale, bars, ...(useFileTempo && { bpm, swing: analysis.swing }) };
      studio.getState().importParts(source, patch);
      onDone();
      const parts = listed(source.parts.map((p) => TRACK_LABELS[p.track].toLowerCase()));
      studio.getState().notify(`Holding your ${parts} in ${keyLabel(key, scale)}. The rest is written to fit.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="quiet-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-4">
        <section aria-label="Tracks">
          <h3 className="eyebrow mb-2">What is each track?</h3>
          <ul className="space-y-1.5">
            {analysis.tracks.map((t, i) => {
              const role = roles[i];
              const color = role === 'skip' ? 'var(--color-line-strong)' : TRACK_COLORS[role];
              const from = start * TICKS_PER_BAR;
              const window = t.notes.filter((n) => n.start >= from && n.start < from + bars * TICKS_PER_BAR).map((n) => ({ ...n, start: n.start - from }));
              return (
                <li key={i} className="flex items-center gap-3 rounded-xl bg-well py-2 pr-2 pl-3">
                  <span aria-hidden className="h-8 w-1 shrink-0 rounded-full" style={{ background: color }} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] text-fg">{t.name}</div>
                    <div className="readout truncate text-[10px] text-fg-faint">
                      {t.drums && 'drums · '}
                      {plural(t.notes.length, 'note')} · {noteName(t.low, flats)}–{noteName(t.high, flats)}
                    </div>
                  </div>
                  <NoteSketch notes={window} ticks={bars * TICKS_PER_BAR} color={color} className="hidden h-8 w-28 shrink-0 rounded-sm bg-panel sm:block" />
                  <div className="w-[138px] shrink-0">
                    <Select
                      label={`Part for ${t.name}`}
                      value={role}
                      options={IMPORT_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
                      onChange={(r) => {
                        setRoles(roles.map((x, j) => (j === i ? r : x)));
                        setError(null);
                      }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
          {clash && (
            <p role="alert" className="mt-2 text-[12.5px] text-melody">
              Two tracks are set to {TRACK_LABELS[clash as keyof typeof TRACK_LABELS].toLowerCase()}. Pick one, or leave the other out.
            </p>
          )}
        </section>

        <section aria-label="Length" className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
          <div>
            <h3 className="eyebrow mb-2">Loop length</h3>
            <Segmented label="Loop length" value={bars} options={BAR_OPTIONS.map((b) => ({ value: b, label: `${b} bars` }))} onChange={(b) => setBars(b as BarCount)} />
          </div>
          {starts.length > 1 && (
            <div>
              <h3 className="eyebrow mb-2">From the file</h3>
              <Select
                label="Bars to use"
                value={String(start)}
                options={starts.map((b) => ({ value: String(b), label: `Bars ${b + 1}–${b + bars}` }))}
                onChange={(b) => setStartBar(Number(b))}
              />
            </div>
          )}
        </section>

        <section aria-label="Key">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h3 className="eyebrow">Key</h3>
            {picked ? (
              <button type="button" onClick={() => setPicked(null)} className="text-[12px] text-fg-dim underline-offset-2 hover:text-fg hover:underline">
                Use detected: {keyLabel(detected.key, detected.scale)}
              </button>
            ) : (
              <span className="text-[12px] text-fg-faint">{from.length ? `Detected from your ${listed(from)}` : 'Detected from the notes'}</span>
            )}
          </div>
          <div className="grid grid-cols-[1fr_2fr] gap-2">
            <Select
              label="Tonic"
              value={String(key)}
              options={Array.from({ length: 12 }, (_, pc) => ({ value: String(pc), label: pitchClassName(pc, flats) }))}
              onChange={(pc) => setPicked({ key: Number(pc), scale })}
            />
            <Select label="Scale" value={scale} options={SCALE_IDS.map((id) => ({ value: id, label: SCALES[id].label }))} onChange={(s) => setPicked({ key, scale: s as ScaleId })} />
          </div>
          {!picked && alternatives.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 text-[12px] text-fg-faint">Also fits</span>
              {alternatives.map((a) => (
                <button
                  key={`${a.key}-${a.scale}`}
                  type="button"
                  onClick={() => setPicked({ key: a.key, scale: a.scale })}
                  className="h-7 rounded-full bg-well px-3 text-[12px] text-fg-dim transition-colors hover:bg-tint hover:text-fg"
                >
                  {keyLabel(a.key, a.scale)}
                </button>
              ))}
            </div>
          )}
        </section>

        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[13px] text-fg-dim">Use the file’s tempo and swing</div>
            <div className="readout text-[10.5px] text-fg-faint">
              {bpm} BPM · {analysis.swing === 50 ? 'straight' : `${analysis.swing}% swing`}
            </div>
          </div>
          <Switch label="Use the file’s tempo and swing" checked={useFileTempo} onChange={setUseFileTempo} />
        </div>
        {error && (
          <p role="alert" className="text-[12.5px] text-melody">
            {error}
          </p>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3.5">
        <p className="max-w-[300px] text-[11.5px] leading-snug text-fg-faint">Snapped to 16ths. Melody, counter and bass keep one note at a time.</p>
        <div className="flex gap-2">
          <button type="button" onClick={onDone} className="h-9 rounded-full px-4 text-[13px] text-fg-dim transition-colors hover:bg-tint hover:text-fg">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!chosen.length || !!clash}
            className="h-9 rounded-full bg-fg px-4 text-[13px] font-medium text-inverse transition-all duration-150 hover:opacity-90 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-30"
          >
            Import
          </button>
        </div>
      </footer>
    </>
  );
}
