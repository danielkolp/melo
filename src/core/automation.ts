import { createRng } from './random';
import { clamp } from './shared';
import {
  PPQ,
  STEP,
  TICKS_PER_BAR,
  TRACK_IDS,
  totalTicks,
  type AutomationLane,
  type AutomationParam,
  type AutomationPoint,
  type Chord,
  type CompositionSettings,
  type NoteEvent,
  type Phrasing,
  type StyleId,
  type TrackId,
} from './types';

/**
 * Automation is stored as normalised 0–1 curves. The mappings below turn those
 * into real units; the audio engine and the UI read the same numbers, and the
 * MIDI export writes them as CC values.
 */

const expRange = (min: number, max: number) => ({
  to: (v: number) => min * Math.pow(max / min, clamp(v, 0, 1)),
  from: (x: number) => clamp(Math.log(x / min) / Math.log(max / min), 0, 1),
});

export const CUTOFF_HZ = expRange(120, 14000);
export const RESONANCE_Q = expRange(0.4, 16);
export const ATTACK_S = expRange(0.001, 0.6);
export const RELEASE_S = expRange(0.03, 3);

const hz = (v: number) => {
  const f = CUTOFF_HZ.to(v);
  return f >= 1000 ? `${(f / 1000).toFixed(1)} kHz` : `${Math.round(f)} Hz`;
};
const seconds = (s: number) => (s >= 1 ? `${s.toFixed(2)} s` : `${Math.round(s * 1000)} ms`);
const percent = (v: number) => `${Math.round(v * 100)}%`;

export interface ParamSpec {
  label: string;
  short: string;
  /** MIDI controller number used on export (the General MIDI / common synth mapping). */
  cc: number;
  format(v: number): string;
}

export const AUTOMATION_PARAMS: Record<AutomationParam, ParamSpec> = {
  cutoff: { label: 'Filter cutoff', short: 'Cutoff', cc: 74, format: hz },
  resonance: { label: 'Resonance', short: 'Resonance', cc: 71, format: (v) => `Q ${RESONANCE_Q.to(v).toFixed(1)}` },
  attack: { label: 'Attack', short: 'Attack', cc: 73, format: (v) => seconds(ATTACK_S.to(v)) },
  release: { label: 'Release', short: 'Release', cc: 72, format: (v) => seconds(RELEASE_S.to(v)) },
  delay: { label: 'Delay send', short: 'Delay', cc: 94, format: percent },
  reverb: { label: 'Reverb send', short: 'Reverb', cc: 91, format: percent },
};

/** Each part's sound when nothing is automated, in real units. The audio engine starts from these. */
export const NATIVE: Record<TrackId, { cutoff: number; resonance: number; attack: number; release: number; delay: number; reverb: number }> = {
  melody: { cutoff: 6500, resonance: 1, attack: 0.004, release: 0.22, delay: 0.45, reverb: 0.35 },
  counter: { cutoff: 5500, resonance: 0.8, attack: 0.003, release: 0.3, delay: 0.25, reverb: 0.3 },
  brass: { cutoff: 6000, resonance: 0.8, attack: 0.006, release: 0.25, delay: 0.2, reverb: 0.4 },
  chords: { cutoff: 6500, resonance: 0.8, attack: 0.004, release: 0.45, delay: 0, reverb: 0.45 },
  bass: { cutoff: 2200, resonance: 0.7, attack: 0.004, release: 0.07, delay: 0, reverb: 0 },
};

/** The same baseline, normalised. Lanes are written relative to it. */
export const BASELINE = Object.fromEntries(
  TRACK_IDS.map((t) => {
    const n = NATIVE[t];
    return [
      t,
      {
        cutoff: CUTOFF_HZ.from(n.cutoff),
        resonance: RESONANCE_Q.from(n.resonance),
        attack: ATTACK_S.from(n.attack),
        release: RELEASE_S.from(n.release),
        delay: n.delay,
        reverb: n.reverb,
      },
    ];
  }),
) as Record<TrackId, Record<AutomationParam, number>>;

/** Linear interpolation between breakpoints; holds the end values outside them. */
export function valueAt(points: readonly AutomationPoint[], tick: number): number {
  if (!points.length) return 0;
  if (tick <= points[0].tick) return points[0].value;
  for (let i = 1; i < points.length; i++) {
    const b = points[i];
    if (tick <= b.tick) {
      const a = points[i - 1];
      return b.tick === a.tick ? b.value : a.value + ((b.value - a.value) * (tick - a.tick)) / (b.tick - a.tick);
    }
  }
  return points[points.length - 1].value;
}

/** Evenly spaced samples across the loop, for scheduling and CC export. */
export function sampleLane(points: readonly AutomationPoint[], loopEnd: number, every = STEP / 2): AutomationPoint[] {
  const out: AutomationPoint[] = [];
  for (let tick = 0; tick < loopEnd; tick += every) out.push({ tick, value: valueAt(points, tick) });
  return out;
}

/** Sorts, clamps and anchors a curve at the loop's start and end. */
function finish(points: AutomationPoint[], end: number): AutomationPoint[] {
  const sorted = points
    .map((p) => ({ tick: Math.round(clamp(p.tick, 0, end)), value: clamp(p.value, 0, 1) }))
    .sort((a, b) => a.tick - b.tick);
  if (!sorted.length || sorted[0].tick > 0) sorted.unshift({ tick: 0, value: sorted[0]?.value ?? 0 });
  if (sorted[sorted.length - 1].tick < end) sorted.push({ tick: end, value: sorted[sorted.length - 1].value });
  return sorted;
}

// ---------------------------------------------------------------------------
// Moves: small, named production ideas. Each one builds a curve from the music.

export interface SuggestionInput {
  settings: CompositionSettings;
  progression: readonly Chord[];
  phrasing: Phrasing;
  notes: readonly NoteEvent[];
}

interface MoveContext extends SuggestionInput {
  end: number;
  base: Record<AutomationParam, number>;
  track: TrackId;
}

interface Move {
  id: string;
  title: string;
  reason: (track: string) => string;
  param: AutomationParam;
  /** Preferred targets, best first. The first one with notes is used. */
  tracks: TrackId[];
  weight: Record<StyleId, number>;
  /** Extra pull for phrase forms the move suits. */
  forms?: Partial<Record<Phrasing['form'], number>>;
  build(ctx: MoveContext): AutomationPoint[];
}

const ANSWER_ROLES = new Set(['response', 'answer']);
const PHRASE_END_ROLES = new Set(['call', 'question', 'hook', 'motif', 'rise', 'peak']);

const MOVES: Move[] = [
  {
    id: 'filter-build',
    title: 'Filter build',
    reason: (t) => `Opens the ${t} filter across the loop, so every pass lifts a little before it resets.`,
    param: 'cutoff',
    tracks: ['chords', 'counter'],
    weight: { ukg: 2, house: 3, deepHouse: 1.2, melodicHouse: 2.5, rap: 2 },
    build: ({ end, base }) => {
      const low = Math.max(0.2, base.cutoff - 0.3);
      const high = Math.min(0.95, base.cutoff + 0.12);
      return [
        { tick: 0, value: low },
        { tick: end * 0.6, value: low + (high - low) * 0.35 },
        { tick: end - STEP, value: high },
        { tick: end, value: high },
      ];
    },
  },
  {
    id: 'breathing-filter',
    title: 'Breathing filter',
    reason: (t) => `A slow two-bar swell keeps the ${t} moving without changing a note.`,
    param: 'cutoff',
    tracks: ['chords', 'counter'],
    weight: { ukg: 0.8, house: 0.8, deepHouse: 3, melodicHouse: 1.5, rap: 1 },
    build: ({ end, base }) => {
      const period = TICKS_PER_BAR * 2;
      const points: AutomationPoint[] = [];
      for (let tick = 0; tick <= end; tick += STEP * 2) {
        points.push({ tick, value: base.cutoff - 0.1 + 0.13 * Math.sin((2 * Math.PI * tick) / period - Math.PI / 2) });
      }
      return points;
    },
  },
  {
    id: 'delay-throws',
    title: 'Delay throws',
    reason: (t) => `Sends only the ${t} phrase endings into the delay, so the echoes fill the gaps it leaves.`,
    param: 'delay',
    tracks: ['melody'],
    weight: { ukg: 2.5, house: 2, deepHouse: 2, melodicHouse: 1.5, rap: 2.5 },
    forms: { callResponse: 1.6, trade: 1.8, questionAnswer: 1.4 },
    build: ({ end, phrasing, notes, track }) => {
      const low = 0.06;
      const points: AutomationPoint[] = [{ tick: 0, value: low }];
      phrasing.sections.forEach((s, i) => {
        if (!PHRASE_END_ROLES.has(s.role) && i !== phrasing.sections.length - 1) return;
        const inSection = notes.filter((n) => n.track === track && n.start >= s.start && n.start < s.start + s.duration);
        const last = inSection[inSection.length - 1];
        if (!last) return;
        const release = Math.min(end, Math.max(last.start + last.duration + PPQ, s.start + s.duration));
        points.push(
          { tick: last.start - STEP, value: low },
          { tick: last.start, value: 0.85 },
          { tick: release - STEP, value: 0.85 },
          { tick: release, value: low },
        );
      });
      return points;
    },
  },
  {
    id: 'darker-answers',
    title: 'Darker answers',
    reason: (t) => `Closes the ${t} filter on each answer, so it sounds like a second voice replying.`,
    param: 'cutoff',
    tracks: ['melody'],
    weight: { ukg: 1.5, house: 1.5, deepHouse: 1.5, melodicHouse: 1, rap: 1.5 },
    forms: { callResponse: 3, questionAnswer: 2.5, hook: 0, sequence: 0, arc: 0, trade: 0 },
    build: ({ phrasing, base }) => {
      const points: AutomationPoint[] = [];
      for (const s of phrasing.sections) {
        const v = ANSWER_ROLES.has(s.role) ? base.cutoff - 0.22 : Math.min(0.95, base.cutoff + 0.04);
        points.push({ tick: s.start, value: v }, { tick: s.start + s.duration - STEP, value: v });
      }
      return points;
    },
  },
  {
    id: 'resonance-rise',
    title: 'Resonance rise',
    reason: (t) => `A resonant peak on the ${t} creeps up through the last bar and signals that something is about to change.`,
    param: 'resonance',
    tracks: ['bass', 'chords'],
    weight: { ukg: 1.5, house: 2, deepHouse: 1, melodicHouse: 2, rap: 1 },
    build: ({ end, base }) => [
      { tick: 0, value: base.resonance },
      { tick: end - TICKS_PER_BAR, value: base.resonance },
      { tick: end - STEP, value: 0.78 },
      { tick: end, value: 0.78 },
    ],
  },
  {
    id: 'attack-bloom',
    title: 'Attack bloom',
    reason: (t) => `The ${t} start as tight stabs and soften towards pads, a build that still works on repeat.`,
    param: 'attack',
    tracks: ['chords'],
    weight: { ukg: 0.8, house: 1, deepHouse: 2, melodicHouse: 2.5, rap: 0.8 },
    build: ({ end }) => [
      { tick: 0, value: 0.12 },
      { tick: end, value: 0.78 },
    ],
  },
  {
    id: 'longer-tails',
    title: 'Longer tails',
    reason: (t) => `Lets the ${t} ring out in the last bar, which smooths the jump back to the top.`,
    param: 'release',
    tracks: ['counter', 'melody'],
    weight: { ukg: 0.6, house: 0.8, deepHouse: 2, melodicHouse: 2, rap: 1.2 },
    build: ({ end, base }) => [
      { tick: 0, value: base.release },
      { tick: end - TICKS_PER_BAR, value: base.release },
      { tick: end, value: Math.min(0.92, base.release + 0.35) },
    ],
  },
  {
    id: 'bass-pulse',
    title: 'Filter pulse',
    reason: (t) => `A quarter-note filter pulse gives the ${t} the pumping feel of sidechain compression.`,
    param: 'cutoff',
    tracks: ['bass'],
    weight: { ukg: 2, house: 1.5, deepHouse: 2.5, melodicHouse: 1.5, rap: 0.3 },
    build: ({ end, base }) => {
      const low = Math.max(0.15, base.cutoff - 0.28);
      const high = Math.min(0.9, base.cutoff + 0.04);
      const points: AutomationPoint[] = [];
      for (let beat = 0; beat < end; beat += PPQ) {
        points.push({ tick: beat, value: low }, { tick: beat + PPQ - STEP / 4, value: high });
      }
      return points;
    },
  },
  {
    id: 'reverb-wash',
    title: 'Reverb wash',
    reason: (t) => `Washes the end of the loop in ${t} reverb, then cuts it dry on the one for impact.`,
    param: 'reverb',
    tracks: ['chords', 'melody'],
    weight: { ukg: 1.2, house: 1.5, deepHouse: 1.5, melodicHouse: 2.5, rap: 1.5 },
    build: ({ end, base }) => [
      { tick: 0, value: base.reverb },
      { tick: end - PPQ * 2, value: base.reverb },
      { tick: end - STEP, value: 0.92 },
      { tick: end, value: 0.92 },
    ],
  },
  {
    id: 'delay-swell',
    title: 'Delay swell',
    reason: (t) => `Feeds more of the ${t} into the delay as the loop goes on, so the space fills in gradually.`,
    param: 'delay',
    tracks: ['melody', 'counter'],
    weight: { ukg: 0.5, house: 0.8, deepHouse: 1.2, melodicHouse: 2.5, rap: 1.5 },
    forms: { arc: 1.6, sequence: 1.4 },
    build: ({ end }) => [
      { tick: 0, value: 0.12 },
      { tick: end, value: 0.68 },
    ],
  },
  {
    id: 'arp-sweep',
    title: 'Arp sweep',
    reason: (t) => `A two-bar cutoff sweep on the ${t} brings the arpeggio out of the background and back again.`,
    param: 'cutoff',
    tracks: ['counter'],
    weight: { ukg: 0, house: 0.3, deepHouse: 0.5, melodicHouse: 3, rap: 1 },
    build: ({ end }) => {
      const points: AutomationPoint[] = [];
      for (let t = 0; t < end; t += TICKS_PER_BAR * 2) {
        points.push({ tick: t, value: 0.32 }, { tick: Math.min(end, t + TICKS_PER_BAR * 2) - STEP / 4, value: 0.88 });
      }
      return points;
    },
  },
];

const TRACK_NOUNS: Record<TrackId, string> = { melody: 'melody', counter: 'counter-melody', brass: 'brass', chords: 'chords', bass: 'bass' };

export const MOVE_IDS = MOVES.map((m) => m.id);

/**
 * Picks a handful of moves that suit the style and the phrasing, and builds
 * each from the actual notes. Deterministic for a given automation seed.
 * On/off choices from `previous` are kept for lanes with the same id.
 */
export function suggestAutomation(input: SuggestionInput, previous: readonly AutomationLane[] = []): AutomationLane[] {
  const { settings, phrasing, notes } = input;
  const rng = createRng(settings.automationSeed);
  const end = totalTicks(settings.bars);
  const count = settings.bars === 2 ? 3 : 4;
  const hasNotes = (t: TrackId) => notes.some((n) => n.track === t);
  const enabled = new Map(previous.map((l) => [l.id, l.enabled]));

  const candidates = MOVES.map((move) => ({
    move,
    track: move.tracks.find(hasNotes),
    weight: move.weight[settings.style] * (move.forms?.[phrasing.form] ?? 1),
  })).filter((c): c is { move: Move; track: TrackId; weight: number } => !!c.track && c.weight > 0);

  const lanes: AutomationLane[] = [];
  const used = new Set<string>();
  while (lanes.length < count) {
    const open = candidates.filter((c) => !used.has(`${c.track}:${c.move.param}`) && !lanes.some((l) => l.id.startsWith(`${c.move.id}:`)));
    if (!open.length) break;
    const { move, track } = rng.weighted(open, open.map((c) => c.weight));
    used.add(`${track}:${move.param}`);
    const id = `${move.id}:${track}`;
    lanes.push({
      id,
      track,
      param: move.param,
      points: finish(move.build({ ...input, end, base: BASELINE[track], track }), end),
      enabled: enabled.get(id) ?? true,
      title: move.title,
      reason: move.reason(TRACK_NOUNS[track]),
    });
  }
  return lanes;
}
