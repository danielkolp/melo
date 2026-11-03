import { Dices } from 'lucide-react';
import { useId } from 'react';
import { AUTOMATION_PARAMS, valueAt } from '../core/automation';
import { unswingTick } from '../core/groove';
import { totalTicks, type AutomationLane } from '../core/types';
import { studio, useComposition, useStudio } from '../state/useStudio';
import { TRACK_COLORS, TRACK_LABELS } from '../theme';
import { Group, IconButton, Switch, cx } from './controls';
import { usePlaybackTicks } from './usePlaybackTicks';

const W = 280;
const H = 30;

function Sparkline({ lane, end, playhead, color }: { lane: AutomationLane; end: number; playhead: number | null; color: string }) {
  const gradient = `spark${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const x = (tick: number) => (tick / end) * W;
  const y = (v: number) => H - 2 - v * (H - 4);
  const line = lane.points.map((p) => `${x(p.tick).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[30px] w-full" aria-hidden>
      <defs>
        <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.32" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${line} ${W},${H}`} fill={`url(#${gradient})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      {playhead !== null && (
        <line x1={x(playhead)} x2={x(playhead)} y1="0" y2={H} stroke="var(--color-fg)" strokeOpacity="0.6" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}

function LaneCard({ lane, focused, end, swing }: { lane: AutomationLane; focused: boolean; end: number; swing: number }) {
  const playing = useStudio((s) => s.isPlaying);
  const ticks = usePlaybackTicks();
  const spec = AUTOMATION_PARAMS[lane.param];
  const color = lane.enabled ? TRACK_COLORS[lane.track] : 'var(--color-fg-faint)';
  const position = unswingTick(ticks % end, swing);
  const live = playing && lane.enabled;

  return (
    <li
      className={cx(
        'rounded-lg px-3 pt-2.5 pb-2 transition-colors duration-150',
        focused ? 'bg-tint' : 'bg-well hover:bg-tint',
      )}
    >
      <div className="flex items-start gap-2.5">
        <button
          type="button"
          aria-pressed={focused}
          onClick={() => studio.getState().focusLane(lane.id)}
          className="min-w-0 flex-1 text-left"
          title="Show in the 3D view"
        >
          <span className={cx('block text-[13.5px] leading-tight', lane.enabled ? 'text-fg' : 'text-fg-faint line-through decoration-fg-faint/50')}>
            {lane.title}
          </span>
          <span className="readout mt-0.5 flex items-baseline justify-between gap-2 text-[10px]">
            <span className="truncate" style={{ color: lane.enabled ? TRACK_COLORS[lane.track] : undefined }}>
              {TRACK_LABELS[lane.track]} · {spec.label}
            </span>
            <span className="shrink-0 text-fg-faint">{live ? spec.format(valueAt(lane.points, position)) : `CC${spec.cc}`}</span>
          </span>
        </button>
        <Switch
          label={`${lane.enabled ? 'Turn off' : 'Turn on'} ${lane.title.toLowerCase()}`}
          checked={lane.enabled}
          color={TRACK_COLORS[lane.track]}
          onChange={() => studio.getState().toggleAutomation(lane.id)}
        />
      </div>
      <button type="button" tabIndex={-1} onClick={() => studio.getState().focusLane(lane.id)} className="mt-1.5 block w-full">
        <Sparkline lane={lane} end={end} playhead={live ? position : null} color={color} />
      </button>
      {focused && <p className="mt-1.5 text-[12px] leading-relaxed text-fg-dim">{lane.reason}</p>}
    </li>
  );
}

/** Suggested automation moves: what each one does and why, with on/off and focus. */
export function AutomationSection() {
  const { automation, settings } = useComposition();
  const focusedId = useStudio((s) => s.focusedLane);
  const focused = automation.find((l) => l.id === focusedId) ?? automation[0];
  const end = totalTicks(settings.bars);
  const enabled = automation.filter((l) => l.enabled).length;

  return (
    <Group
      title="Automation"
      aside={
        <span className="flex items-center gap-1">
          <span className="readout text-[10px] text-fg-faint">
            {enabled}/{automation.length} on
          </span>
          <IconButton size="sm" label="Suggest other moves" onClick={() => studio.getState().rerollAutomation()}>
            <Dices size={15} strokeWidth={1.6} />
          </IconButton>
        </span>
      }
    >
      {automation.length ? (
        <ul className="space-y-1.5">
          {automation.map((lane) => (
            <LaneCard key={lane.id} lane={lane} focused={lane === focused} end={end} swing={settings.swing} />
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-fg-faint">Nothing to suggest for this idea.</p>
      )}
      <p className="mt-3 text-[11.5px] leading-relaxed text-fg-faint">
        Suggestions follow the phrasing. Lanes that are on play back here and export as MIDI CC on their part's channel.
      </p>
    </Group>
  );
}
