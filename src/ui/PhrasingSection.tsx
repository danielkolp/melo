import { Dices, Lock, LockOpen } from 'lucide-react';
import { useState } from 'react';
import { canRewrite } from '../core/locks';
import { PHRASE_FORMS, PHRASE_FORM_IDS, ROLE_LABELS } from '../core/melody';
import { TRANSITIONS, TRANSITION_IDS, resolveTransition } from '../core/transition';
import { TICKS_PER_BAR, totalTicks } from '../core/types';
import { studio, useComposition, useStudio } from '../state/useStudio';
import { TRACK_COLORS, TRACK_LABELS } from '../theme';
import { Group, Select, cx } from './controls';
import { usePlaybackTicks } from './usePlaybackTicks';

/** How the melody is organised: the chosen form, what it means, and the role of each bar. Each bar can be locked or rewritten. */
export function PhrasingSection() {
  const composition = useComposition();
  const { settings, phrasing, source } = composition;
  const active = useStudio((s) => s.activeTrack);
  const [picked, setPicked] = useState<number | null>(null);
  const locked = new Set(composition.locks?.bars);
  const chosen = picked !== null && picked < phrasing.sections.length ? picked : null;
  const heldMelody = !!source?.parts.some((p) => p.track === 'melody');
  const playing = useStudio((s) => s.isPlaying);
  const ticks = usePlaybackTicks();
  const bar = playing ? Math.floor((ticks % totalTicks(settings.bars)) / TICKS_PER_BAR) : -1;
  const resolved = PHRASE_FORMS[phrasing.form];
  const voices = [...new Set(phrasing.sections.map((s) => s.voice))];
  const transition = resolveTransition(settings);
  const lastBar = phrasing.sections.length - 1;
  const about = settings.bars !== 8
    ? 'Plays at the end of 8-bar loops. Set the length to 8 bars to hear it.'
    : TRANSITIONS[transition?.kind ?? 'none'].description;

  return (
    <Group
      title="Phrasing"
      aside={!heldMelody && settings.phrase === 'auto' && <span className="text-[12px] text-fg-faint">Auto chose {resolved.label.toLowerCase()}</span>}
    >
      {heldMelody ? (
        <p className="text-[12.5px] leading-relaxed text-fg-dim">Your uploaded melody sets the phrasing. The counter-melody plays around it.</p>
      ) : (
        <>
          <Select
            label="Phrase form"
            value={settings.phrase}
            options={PHRASE_FORM_IDS.map((id) => ({ value: id, label: PHRASE_FORMS[id].label }))}
            onChange={(phrase) => studio.getState().changeMusic({ phrase })}
          />
          <p className="mt-2 text-[12.5px] leading-relaxed text-fg-dim">{resolved.description}</p>
        </>
      )}

      <ol
        className="mt-3 grid gap-1"
        style={{ gridTemplateColumns: `repeat(${phrasing.sections.length}, minmax(0, 1fr))` }}
        aria-label="Phrase plan"
      >
        {phrasing.sections.map((section, i) => (
          <li key={section.start}>
            <button
              type="button"
              aria-pressed={chosen === i}
              onClick={() => setPicked(chosen === i ? null : i)}
              title={`Bar ${i + 1}: ${ROLE_LABELS[section.role]} (${TRACK_LABELS[section.voice].toLowerCase()})${transition && i === lastBar ? `, then a ${TRANSITIONS[transition.kind].label.toLowerCase()}` : ''}${locked.has(i) ? ', locked' : ''}. Click to lock or rewrite it.`}
              className={cx(
                'relative block w-full overflow-hidden rounded-md px-1.5 pt-1.5 pb-1.5 text-left transition-[background-color,box-shadow] duration-150',
                bar === i ? 'bg-tint' : 'bg-well hover:bg-tint',
                chosen === i && 'ring-[1.5px] ring-fg',
              )}
            >
              <span aria-hidden className="absolute inset-x-0 top-0 h-[2px]" style={{ background: TRACK_COLORS[section.voice] }} />
              <span className="readout flex items-center gap-1 truncate text-[9.5px] text-fg-faint">
                {i + 1}
                {transition && i === lastBar && ' →'}
                {locked.has(i) && <Lock aria-label="locked" size={9} strokeWidth={2} className="ml-auto shrink-0 text-fg-dim" />}
              </span>
              <span className="block truncate text-[11.5px] text-fg">{ROLE_LABELS[section.role]}</span>
            </button>
          </li>
        ))}
      </ol>
      {chosen !== null && (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            aria-pressed={locked.has(chosen)}
            onClick={() => studio.getState().toggleBarLock(chosen)}
            title={locked.has(chosen) ? `Let Generate rewrite bar ${chosen + 1} again` : `Keep every part of bar ${chosen + 1} through Generate`}
            className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full bg-well px-3 text-[12.5px] text-fg transition-colors hover:bg-tint disabled:pointer-events-none disabled:opacity-40"
          >
            {locked.has(chosen) ? <Lock size={13} strokeWidth={1.8} /> : <LockOpen size={13} strokeWidth={1.7} />}
            {locked.has(chosen) ? `Unlock bar ${chosen + 1}` : `Lock bar ${chosen + 1}`}
          </button>
          <button
            type="button"
            disabled={locked.has(chosen) || !canRewrite(composition, active)}
            onClick={() => studio.getState().rewriteBar(active, chosen)}
            title={
              locked.has(chosen)
                ? 'This bar is locked'
                : !canRewrite(composition, active)
                  ? `The ${TRACK_LABELS[active].toLowerCase()} is locked or uploaded`
                  : `Another take on bar ${chosen + 1} of the ${TRACK_LABELS[active].toLowerCase()}, the rest left as it is. Press again for another.`
            }
            className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full bg-well px-3 text-[12.5px] text-fg transition-colors hover:bg-tint disabled:pointer-events-none disabled:opacity-40"
          >
            <Dices size={13} strokeWidth={1.7} />
            Rewrite {TRACK_LABELS[active].toLowerCase()}
          </button>
        </div>
      )}
      {voices.length > 1 && (
        <p className="mt-2 flex items-center gap-3 text-[11.5px] text-fg-faint">
          {voices.map((v) => (
            <span key={v} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-[2px]" style={{ background: TRACK_COLORS[v] }} />
              {TRACK_LABELS[v]}
            </span>
          ))}
        </p>
      )}

      <div className="mt-4">
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-[12.5px] text-fg-dim">Transition at the end of bar 8</span>
          {settings.transition === 'auto' && transition && (
            <span className="text-[12px] text-fg-faint">Auto chose {TRANSITIONS[transition.kind].label.toLowerCase()}</span>
          )}
        </div>
        <Select
          label="Transition at the end of bar 8"
          value={settings.transition}
          options={TRANSITION_IDS.map((id) => ({ value: id, label: TRANSITIONS[id].label }))}
          onChange={(value) => studio.getState().changeMusic({ transition: value })}
        />
        <p className="mt-2 text-[12.5px] leading-relaxed text-fg-dim">{about}</p>
      </div>
    </Group>
  );
}
