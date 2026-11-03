import { deriveSeed } from './random';
import { developPart } from './variations';
import { STEP, TRACK_IDS, totalTicks, type Composition, type NoteEvent, type SectionMaterial, type TrackId } from './types';

/**
 * How a song moves on from its loop. Each section plays a version of the loop, its material: A as
 * written; A′ with new endings and the bass leaning into the changes; A″ a busier, brighter return;
 * B a contrast made from the same notes; reduced the bare bones, for intros and outros. Parts move
 * by the variation cards' named moves, so every version is still recognisably the loop. Uploaded
 * parts play as uploaded.
 */

type Developed = Exclude<SectionMaterial, 'A'>;

/** For each material and part, the ways it can move on, each a list of moves in order. The first way that changes the part is used. */
const WAYS: Record<Developed, Partial<Record<TrackId, string[][]>>> = {
  A1: {
    melody: [['newEnding']],
    counter: [['newEnding']],
    bass: [['approach'], ['anticipate']],
  },
  A2: {
    melody: [['octaves', 'newEnding'], ['passing', 'newEnding'], ['passing']],
    counter: [['passing'], ['octaves']],
    brass: [['octaves']],
    chords: [['restab'], ['addColour'], ['spread']],
    bass: [['busier', 'approach'], ['walk'], ['busier']],
  },
  B: {
    melody: [['sequence'], ['invert'], ['newRhythm'], ['reverse']],
    counter: [['invert'], ['reverse']],
    chords: [['pads'], ['invertUp']],
    bass: [['rootsOnly'], ['legato']],
  },
  reduced: {
    melody: [['strip']],
    counter: [['strip']],
    chords: [['pads']],
    bass: [['rootsOnly']],
  },
};

/** How far each material strays: A′ barely, B the most. */
const AMOUNT: Record<Developed, number> = { A1: 0.35, A2: 0.6, B: 0.7, reduced: 0.4 };

const BEAT = STEP * 4;
const TOP_LINES: readonly TrackId[] = ['melody', 'counter', 'brass'];

const held = (composition: Composition) => new Set(composition.source?.parts.map((p) => p.track));
const partOf = (notes: readonly NoteEvent[], track: TrackId) => notes.filter((n) => n.track === track);

/** The loop's notes as a material plays them. A is the loop itself. */
export function developMaterial(composition: Composition, material: SectionMaterial): NoteEvent[] {
  if (material === 'A') return composition.notes;
  const { settings, progression } = composition;
  const keep = held(composition);
  return TRACK_IDS.flatMap((track) => {
    const part = partOf(composition.notes, track);
    const ways = WAYS[material][track];
    if (!ways || !part.length || keep.has(track)) return part;
    const seed = deriveSeed(settings.trackSeeds[track], `develop/${material}`);
    // Start from a way picked by the seed, then try the rest in turn.
    const first = seed % ways.length;
    for (let k = 0; k < ways.length; k++) {
      const moved = developPart(part, settings, progression, ways[(first + k) % ways.length], deriveSeed(seed, String(k)), AMOUNT[material]);
      if (moved) return moved;
    }
    return part;
  });
}

/**
 * The last pass before a drop or a hook: the top lines rest through the final two beats, leaving
 * a gap for the drop to land in, and the bass walks up into it.
 */
export function turnaround(composition: Composition, notes: readonly NoteEvent[]): NoteEvent[] {
  const { settings, progression } = composition;
  const keep = held(composition);
  const rest = totalTicks(settings.bars) - 2 * BEAT;
  const out: NoteEvent[] = [];
  for (const n of notes) {
    if (!TOP_LINES.includes(n.track) || keep.has(n.track)) out.push(n);
    else if (n.start < rest) out.push(n.start + n.duration > rest ? { ...n, duration: Math.max(STEP, rest - n.start) } : n);
  }
  const bass = partOf(out, 'bass');
  if (!bass.length || keep.has('bass')) return out;
  const walked = developPart(bass, settings, progression, ['walkUp'], deriveSeed(settings.trackSeeds.bass, 'turnaround'), 0.4);
  return walked ? [...out.filter((n) => n.track !== 'bass'), ...walked] : out;
}
