import { makePlan } from './plan';
import { velocity } from './shared';
import { STEP, TICKS_PER_BAR, type CompositionSettings, type NoteEvent, type StyleId, type TrackId } from './types';

/**
 * How a part is played rather than which notes it has: where it sits against the grid, how hard
 * each phrase leans, and how short the stabs are. Each style and instrument has its own touch; a
 * sub-bass, a chord stab and a lead don't move the same way. Applied once to freshly written
 * parts, never to uploaded ones.
 */

/** Largest timing nudge, in ticks (a 20th of a beat). */
export const MAX_NUDGE = 24;

interface Touch {
  /** Ticks off the grid for notes off the beat; on-beat notes take half of it. Negative is early. */
  nudge: number;
  /** Extra lateness for ghost notes, which sit behind the beat. */
  ghost?: number;
  /** How far the velocity follows the plan's energy, in velocity points across its range. */
  dynamics: number;
  /** Short notes (four sixteenths or less) sound for this share of their length. */
  gate?: number;
}

/**
 * UKG: stabs pushed a hair early, ghosts dragged late, the lead on the grid. House: stabs a touch
 * early. Deep house: the top lines laid back. Melodic house: tight, its arps on the grid. Rap:
 * tight, with the 808 untouched.
 */
const TOUCH: Record<StyleId, Partial<Record<TrackId, Touch>>> = {
  ukg: {
    melody: { nudge: 0, dynamics: 16 },
    counter: { nudge: 4, dynamics: 12 },
    brass: { nudge: -4, dynamics: 14 },
    chords: { nudge: -6, dynamics: 8, gate: 0.75 },
    bass: { nudge: 0, ghost: 8, dynamics: 4 },
  },
  house: {
    melody: { nudge: 0, dynamics: 14 },
    counter: { nudge: 0, dynamics: 10 },
    brass: { nudge: -4, dynamics: 14 },
    chords: { nudge: -3, dynamics: 8, gate: 0.85 },
    bass: { nudge: 0, ghost: 6, dynamics: 4 },
  },
  deepHouse: {
    melody: { nudge: 8, dynamics: 12 },
    counter: { nudge: 6, dynamics: 10 },
    brass: { nudge: 4, dynamics: 10 },
    chords: { nudge: 2, dynamics: 6 },
    bass: { nudge: 0, ghost: 6, dynamics: 3 },
  },
  melodicHouse: {
    melody: { nudge: 0, dynamics: 16 },
    counter: { nudge: 0, dynamics: 10 },
    brass: { nudge: 0, dynamics: 12 },
    chords: { nudge: 0, dynamics: 10 },
    bass: { nudge: 0, dynamics: 3 },
  },
  rap: {
    melody: { nudge: 2, dynamics: 12 },
    counter: { nudge: 0, dynamics: 8 },
    brass: { nudge: -2, dynamics: 12 },
    chords: { nudge: 0, dynamics: 6 },
    bass: { nudge: 0, dynamics: 2 },
  },
};

const clampNudge = (n: number) => Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, Math.round(n)));
const isGhost = (n: Pick<NoteEvent, 'duration' | 'velocity'>) => n.duration <= STEP && n.velocity < 72;

/** Ticks a note sits off the grid in a style's feel; 0 on the grid. */
export function feel(style: StyleId, track: TrackId, n: Pick<NoteEvent, 'start' | 'duration' | 'velocity'>): number {
  const t = TOUCH[style][track];
  if (!t) return 0;
  const offbeat = n.start % (STEP * 4) !== 0;
  return clampNudge((offbeat ? t.nudge : t.nudge / 2) + (isGhost(n) ? (t.ghost ?? 0) : 0));
}

/**
 * The finished parts, played: each bar louder or softer with the plan's energy (centred, so the
 * part's overall level stays), short chord stabs clipped, and notes nudged off the grid by the
 * style's feel. `tracks`: the parts to touch; the rest pass through as they are.
 */
export function perform(settings: CompositionSettings, notes: readonly NoteEvent[], tracks: ReadonlySet<TrackId>): NoteEvent[] {
  const { bars } = makePlan(settings);
  const mean = bars.reduce((a, b) => a + b.energy, 0) / bars.length;
  const touch = TOUCH[settings.style];
  return notes.map((n) => {
    const t = touch[n.track];
    if (!t || !tracks.has(n.track)) return n;
    const bar = bars[Math.min(bars.length - 1, Math.floor(n.start / TICKS_PER_BAR))];
    const lean = isGhost(n) ? 0 : (bar.energy - mean) * t.dynamics * 2;
    const nudge = feel(settings.style, n.track, n);
    const duration = t.gate && n.duration <= STEP * 4 && n.duration > STEP ? Math.max(STEP, Math.round((n.duration * t.gate) / STEP) * STEP) : n.duration;
    const played: NoteEvent = { ...n, velocity: velocity(n.velocity + lean), duration };
    if (nudge) played.nudge = nudge;
    else delete played.nudge;
    return played;
  });
}
