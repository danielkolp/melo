import { PHRASE_FORMS, PHRASE_FORM_IDS, ROLE_LABELS } from '../core/melody';
import { TRANSITIONS, TRANSITION_IDS, resolveTransition } from '../core/transition';
import { TICKS_PER_BAR, totalTicks } from '../core/types';
import { studio, useComposition, useStudio } from '../state/useStudio';
import { TRACK_COLORS, TRACK_LABELS } from '../theme';
import { Group, Select, cx } from './controls';
import { usePlaybackTicks } from './usePlaybackTicks';

/** How the melody is organised: the chosen form, what it means, and the role of each bar. */
export function PhrasingSection() {
  const { settings, phrasing, source } = useComposition();
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
          <li
            key={section.start}
            title={`Bar ${i + 1}: ${ROLE_LABELS[section.role]} (${TRACK_LABELS[section.voice].toLowerCase()})${transition && i === lastBar ? `, then a ${TRANSITIONS[transition.kind].label.toLowerCase()}` : ''}`}
            className={cx('relative overflow-hidden rounded-md px-1.5 pt-1.5 pb-1.5 transition-colors duration-150', bar === i ? 'bg-tint' : 'bg-well')}
          >
            <span aria-hidden className="absolute inset-x-0 top-0 h-[2px]" style={{ background: TRACK_COLORS[section.voice] }} />
            <span className="readout block truncate text-[9.5px] text-fg-faint">
              {i + 1}
              {transition && i === lastBar && ' →'}
            </span>
            <span className="block truncate text-[11.5px] text-fg">{ROLE_LABELS[section.role]}</span>
          </li>
        ))}
      </ol>
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
