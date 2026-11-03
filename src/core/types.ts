/**
 * The composition model. Everything else (3D view, audio, MIDI export) reads
 * these types; nothing here knows about rendering or sound.
 *
 * Time is measured in MIDI ticks at a fixed resolution so the same numbers
 * drive the renderer, the Tone.js scheduler and the exported file.
 */

/** Ticks per quarter note. Matches the exported MIDI file's division. */
export const PPQ = 480;
/** One sixteenth note — the editing grid. */
export const STEP = PPQ / 4;
export const STEPS_PER_BEAT = 4;
export const BEATS_PER_BAR = 4;
export const STEPS_PER_BAR = STEPS_PER_BEAT * BEATS_PER_BAR;
export const TICKS_PER_BAR = PPQ * BEATS_PER_BAR;

export type TrackId = 'melody' | 'counter' | 'brass' | 'chords' | 'bass';

/** Ordered high register to low register. */
export const TRACK_IDS: readonly TrackId[] = ['melody', 'counter', 'brass', 'chords', 'bass'];

export interface NoteEvent {
  /** Stable identity used for selection, editing and render keys. */
  id: string;
  track: TrackId;
  /** MIDI note number, 60 = C4. */
  pitch: number;
  /** Start in ticks from the top of the pattern (straight time, before swing). */
  start: number;
  /** Length in ticks. */
  duration: number;
  /** MIDI velocity, 1–127. */
  velocity: number;
  /**
   * Ticks off the grid, early (negative) or late, applied after swing when the note is played or
   * exported: the feel of the part. Absent means on the grid. The editor works on `start`.
   */
  nudge?: number;
}

export type ScaleId =
  | 'minor'
  | 'dorian'
  | 'phrygian'
  | 'harmonicMinor'
  | 'minorPentatonic'
  | 'major'
  | 'lydian'
  | 'mixolydian'
  | 'majorPentatonic';

export type StyleId = 'ukg' | 'house' | 'deepHouse' | 'melodicHouse' | 'rap';

export type BarCount = 2 | 4 | 8;

/**
 * How the melody is organised into phrases. `trade` passes the answer to the
 * counter-melody, so two instruments talk to each other.
 */
export type PhraseForm = 'auto' | 'callResponse' | 'trade' | 'hook' | 'questionAnswer' | 'sequence' | 'arc';
export type ResolvedForm = Exclude<PhraseForm, 'auto'>;

/** `yours`: a bar of an uploaded melody. */
export type PhraseRole = 'call' | 'response' | 'hook' | 'question' | 'answer' | 'motif' | 'rise' | 'peak' | 'fall' | 'yours';

export interface PhraseSection {
  start: number;
  duration: number;
  role: PhraseRole;
  /** Which part carries this phrase. */
  voice: TrackId;
}

export interface Phrasing {
  form: ResolvedForm;
  sections: PhraseSection[];
}

/** Synth parameters an automation lane can move. Values are normalised 0–1. */
export type AutomationParam = 'cutoff' | 'resonance' | 'attack' | 'release' | 'delay' | 'reverb';

export interface AutomationPoint {
  tick: number;
  value: number;
}

export interface AutomationLane {
  /** Stable per move and target, so on/off choices survive regeneration. */
  id: string;
  track: TrackId;
  param: AutomationParam;
  /** Breakpoints, sorted by tick, joined by straight lines. First at 0, last at the loop end. */
  points: AutomationPoint[];
  enabled: boolean;
  title: string;
  /** Why the move works, in a sentence. */
  reason: string;
}

export type TrackSeeds = Record<TrackId, number>;

/** How an 8-bar loop's last bar hands over to the next: a clap roll, a stop, or a lift with the kick out. */
export type TransitionKind = 'roll' | 'stop' | 'lift';
export type TransitionChoice = 'auto' | TransitionKind | 'none';

export interface CompositionSettings {
  style: StyleId;
  /** Tonic pitch class, 0 = C. */
  key: number;
  scale: ScaleId;
  bpm: number;
  /** Swing as a percentage of a sixteenth pair: 50 = straight, 66.7 = triplet. */
  swing: number;
  bars: BarCount;
  /** 0–1. How busy the parts are. */
  density: number;
  /** 0–1. How far repeated phrases drift from their first statement. */
  variation: number;
  /**
   * 0–1. How far the parts reach beyond the safe choices: chord colours, borrowed and passing
   * chords, chromatic approach notes, leaps, fills and rhythmic surprises. 0 keeps to the basics.
   */
  creativity: number;
  /** Master seed. The progression derives from it directly, unless `harmonySeed` is set. */
  seed: number;
  /** Set by New chords: the progression's own seed, so the harmony can change on its own. */
  harmonySeed?: number;
  /** Per-track seeds, so one part can be regenerated without touching the rest. */
  trackSeeds: TrackSeeds;
  phrase: PhraseForm;
  /** The transition at the end of an 8-bar loop. */
  transition: TransitionChoice;
  /** Seed for automation suggestions, so they can be re-rolled on their own. */
  automationSeed: number;
}

export type ChordQuality = 'maj' | 'min' | 'dim' | 'aug' | 'sus2' | 'sus4';

export interface Chord {
  /** 0-based scale degree in the harmonic parent scale. */
  degree: number;
  /** Root pitch class. */
  root: number;
  /** Chord tones as pitch classes: root, third (or its suspension), fifth, then any colour tones. */
  tones: number[];
  quality: ChordQuality;
  start: number;
  duration: number;
  /**
   * Set when the chord reaches outside the key (borrowed from the parallel mode, or a secondary
   * dominant): the pitch classes that suit it, which melodic parts follow while it plays.
   */
  scale?: number[];
  /** Roman numeral for a chord outside the key, such as bVI or V/ii. */
  numeral?: string;
}

// ---------------------------------------------------------------------------
// Song arrangement: the loop laid out into a full track.

export type SectionKind = 'intro' | 'verse' | 'build' | 'drop' | 'hook' | 'breakdown' | 'bridge' | 'outro';
/** How much of the guide beat plays. `build` drops the kick and rolls the clap faster and faster. */
export type DrumLevel = 'off' | 'light' | 'full' | 'build';
/** A low-pass move across the whole section: none, held dark, or opening up into what follows. */
export type FilterMove = 'open' | 'dark' | 'rise';

/**
 * Which version of the loop a section plays: A as written, A1 (A′) with new endings, A2 (A″) a
 * busier return, B a contrast made from the same notes, reduced the bare bones.
 */
export type SectionMaterial = 'A' | 'A1' | 'A2' | 'B' | 'reduced';

export interface SongSection {
  id: string;
  kind: SectionKind;
  /** Length in bars, always whole passes of the loop. Each section plays the loop from its top. */
  bars: number;
  parts: Record<TrackId, boolean>;
  drums: DrumLevel;
  filter: FilterMove;
  /** Which version of the loop it plays. Unset or auto: chosen from the section's kind and place in the song. */
  material?: SectionMaterial | 'auto';
}

export interface Arrangement {
  /** The style it was laid out for; a new style suggests a new structure. */
  style: StyleId;
  /** Which of the style's templates it started from. */
  template: number;
  sections: SongSection[];
}

// ---------------------------------------------------------------------------
// Uploaded parts: a MIDI file's parts held in the loop while the rest is written around them.

export interface ImportedPart {
  track: TrackId;
  /** The track's name in the file. */
  name: string;
  /** As uploaded: snapped to the grid and fitted into the loop, in the key the file was read in. */
  notes: NoteEvent[];
}

/** Number of variation cards offered for each uploaded part. */
export const VARIATION_COUNT = 6;

export interface ImportSource {
  fileName: string;
  /** Key, scale and length the parts were read in. The loop moves them from here. */
  key: number;
  scale: ScaleId;
  bars: BarCount;
  /** The harmony read from the upload, in the same key. */
  progression: Chord[];
  parts: ImportedPart[];
  variationSeed: number;
  /** 0–1. How far the variations stray from the upload. */
  amount: number;
  /** The take each part last loaded: 0 the upload, 1–6 a variation card. Unset after new cards are dealt. */
  picked: Partial<Record<TrackId, number>>;
}

/** What Generate and changes to the music leave alone. */
export interface Locks {
  tracks: TrackId[];
  /** 0-based bars whose notes, in every part, are kept. */
  bars: number[];
}

export interface Composition {
  settings: CompositionSettings;
  progression: Chord[];
  phrasing: Phrasing;
  notes: NoteEvent[];
  automation: AutomationLane[];
  arrangement: Arrangement;
  /** Set while uploaded parts are held: those parts are kept and everything else is written around them. */
  source?: ImportSource;
  /** Locked parts and bars. Unset: nothing locked. */
  locks?: Locks;
  /**
   * Parts changed by hand since they were written. They are kept when another part is rewritten
   * and moved, not rewritten, when only the key changes. Unset: none.
   */
  edited?: TrackId[];
}

export function totalTicks(bars: number): number {
  return bars * TICKS_PER_BAR;
}
