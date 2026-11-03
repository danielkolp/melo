import { regenerateTrack } from './generator';
import { canRewrite } from './locks';
import { deriveSeed } from './random';
import { scoreBass, scoreMelody } from './score';
import type { Composition, NoteEvent, TrackId } from './types';

/** Parts with a score, so their takes can be ranked. */
export const SCORED_TRACKS: readonly TrackId[] = ['melody', 'bass'];

export interface PartTake {
  /** The part's seed for this take: `regenerateTrack(composition, track, seed)` loads it. */
  seed: number;
  /** How it differs from the part playing now. */
  label: string;
  notes: NoteEvent[];
  score: number;
}

const shape = (notes: readonly NoteEvent[]) => notes.map((n) => `${n.start}:${n.pitch}:${n.duration}`).join();
const meanPitch = (notes: readonly NoteEvent[]) => notes.reduce((a, n) => a + n.pitch, 0) / Math.max(1, notes.length);

/** "Busier, higher" and the like: a take next to the part playing now. */
function describe(notes: readonly NoteEvent[], current: readonly NoteEvent[]): string {
  const ratio = notes.length / Math.max(1, current.length);
  const lift = meanPitch(notes) - meanPitch(current);
  const words = [ratio > 1.15 ? 'busier' : ratio < 0.85 ? 'sparser' : '', lift > 2 ? 'higher' : lift < -2 ? 'lower' : ''].filter(Boolean);
  const text = words.length ? words.join(', ') : 'same feel, new notes';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Other takes on the melody or the bass to audition, best first: written from fresh seeds the way
 * the dice would, scored, with repeats left out. Empty for parts without a score, and for
 * uploaded or locked parts. Same composition, same takes.
 */
export function topTakes(composition: Composition, track: TrackId, count = 4): PartTake[] {
  if (!SCORED_TRACKS.includes(track) || !canRewrite(composition, track)) return [];
  const { settings, progression } = composition;
  const current = composition.notes.filter((n) => n.track === track);
  const chords = composition.notes.filter((n) => n.track === 'chords');
  const seen = new Set([shape(current)]);
  const takes: PartTake[] = [];
  for (let i = 0; i < count * 2; i++) {
    const seed = deriveSeed(settings.trackSeeds[track], `audition/${i}`);
    const notes = regenerateTrack(composition, track, seed).notes.filter((n) => n.track === track);
    if (seen.has(shape(notes))) continue;
    seen.add(shape(notes));
    const score = track === 'melody' ? scoreMelody(notes, progression, settings) : scoreBass(notes, settings, chords);
    takes.push({ seed, label: describe(notes, current), notes, score });
  }
  return takes.sort((a, b) => b.score - a.score).slice(0, count);
}
