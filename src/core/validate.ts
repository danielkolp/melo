import { DRUM_LEVELS, FILTER_MOVES, MATERIALS, SECTION_KINDS, fitArrangement, suggestArrangement } from './arrangement';
import { AUTOMATION_PARAMS, suggestAutomation } from './automation';
import { generateBrass } from './brass';
import { createSettings, generateComposition, withTransition } from './generator';
import { PHRASE_FORMS } from './melody';
import { sortNotes } from './shared';
import { deriveSeed } from './random';
import { STYLES } from './styles';
import { SCALES } from './theory';
import { TRANSITIONS } from './transition';
import {
  TRACK_IDS,
  type Arrangement,
  type AutomationLane,
  type Chord,
  type Composition,
  type CompositionSettings,
  type ImportSource,
  type Locks,
  type NoteEvent,
  type Phrasing,
  type TrackId,
} from './types';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

function isNote(v: unknown): v is NoteEvent {
  if (!isObj(v)) return false;
  return (
    typeof v.id === 'string' &&
    TRACK_IDS.includes(v.track as never) &&
    isNum(v.pitch) &&
    isNum(v.start) &&
    isNum(v.duration) &&
    isNum(v.velocity) &&
    (v.nudge === undefined || isNum(v.nudge))
  );
}

function isLane(v: unknown): v is AutomationLane {
  if (!isObj(v)) return false;
  return (
    typeof v.id === 'string' &&
    TRACK_IDS.includes(v.track as never) &&
    typeof v.param === 'string' &&
    v.param in AUTOMATION_PARAMS &&
    typeof v.enabled === 'boolean' &&
    typeof v.title === 'string' &&
    typeof v.reason === 'string' &&
    Array.isArray(v.points) &&
    v.points.length > 0 &&
    v.points.every((p) => isObj(p) && isNum(p.tick) && isNum(p.value))
  );
}

function isPhrasing(v: unknown): v is Phrasing {
  if (!isObj(v) || typeof v.form !== 'string' || !(v.form in PHRASE_FORMS) || v.form === 'auto') return false;
  return Array.isArray(v.sections) && v.sections.every((s) => isObj(s) && isNum(s.start) && isNum(s.duration) && typeof s.role === 'string' && TRACK_IDS.includes(s.voice as never));
}

function isArrangement(v: unknown): v is Arrangement {
  if (!isObj(v) || typeof v.style !== 'string' || !(v.style in STYLES) || !isNum(v.template) || !Array.isArray(v.sections)) return false;
  return (
    v.sections.length > 0 &&
    v.sections.every(
      (s) =>
        isObj(s) &&
        typeof s.id === 'string' &&
        typeof s.kind === 'string' &&
        s.kind in SECTION_KINDS &&
        isNum(s.bars) &&
        s.bars > 0 &&
        isObj(s.parts) &&
        TRACK_IDS.every((t) => t === 'brass' || typeof (s.parts as Record<string, unknown>)[t] === 'boolean') &&
        DRUM_LEVELS.includes(s.drums as never) &&
        FILTER_MOVES.includes(s.filter as never) &&
        // Sections saved before materials play auto.
        (s.material === undefined || s.material === 'auto' || (typeof s.material === 'string' && s.material in MATERIALS)),
    )
  );
}

/** Locks from a save, keeping only the parts and bars that exist. Undefined when nothing is locked. */
function readLocks(v: unknown, bars: number): Locks | undefined {
  if (!isObj(v)) return undefined;
  const tracks = Array.isArray(v.tracks) ? TRACK_IDS.filter((t) => (v.tracks as unknown[]).includes(t)) : [];
  const locked = Array.isArray(v.bars) ? [...new Set(v.bars.filter((b): b is number => Number.isInteger(b) && b >= 0 && b < bars))].sort((a, b) => a - b) : [];
  return tracks.length || locked.length ? { tracks, bars: locked } : undefined;
}

/** Sections saved before the brass part bring it in where their kind does. */
function withBrass(arrangement: Arrangement): Arrangement {
  return {
    ...arrangement,
    sections: arrangement.sections.map((s) => (typeof s.parts.brass === 'boolean' ? s : { ...s, parts: { ...s.parts, brass: SECTION_KINDS[s.kind].parts.brass } })),
  };
}

/** An upload saved with the session, or undefined if it's missing or doesn't parse. */
function readSource(v: unknown): ImportSource | undefined {
  if (!isObj(v)) return undefined;
  const valid =
    typeof v.fileName === 'string' &&
    isNum(v.key) &&
    typeof v.scale === 'string' &&
    v.scale in SCALES &&
    [2, 4, 8].includes(v.bars as number) &&
    Array.isArray(v.progression) &&
    v.progression.length > 0 &&
    Array.isArray(v.parts) &&
    v.parts.length > 0 &&
    v.parts.every((p) => isObj(p) && TRACK_IDS.includes(p.track as never) && typeof p.name === 'string' && Array.isArray(p.notes) && p.notes.every(isNote)) &&
    isNum(v.variationSeed) &&
    isNum(v.amount) &&
    isObj(v.picked);
  return valid ? (v as unknown as ImportSource) : undefined;
}

/**
 * Reads a composition loaded from storage, or returns null if it doesn't parse.
 * Saves from before phrasing, automation and arrangement existed are brought up to date;
 * their notes, including edits, are kept as they were.
 */
export function readComposition(value: unknown): Composition | null {
  if (!isObj(value)) return null;
  const s = value.settings;
  if (!isObj(s)) return null;
  const seeds = s.trackSeeds;
  const valid =
    typeof s.style === 'string' &&
    s.style in STYLES &&
    typeof s.scale === 'string' &&
    s.scale in SCALES &&
    isNum(s.key) &&
    isNum(s.bpm) &&
    isNum(s.swing) &&
    [2, 4, 8].includes(s.bars as number) &&
    isNum(s.density) &&
    isNum(s.variation) &&
    isNum(s.seed) &&
    isObj(seeds) &&
    TRACK_IDS.every((t) => t === 'brass' || isNum(seeds[t])) &&
    Array.isArray(value.progression) &&
    Array.isArray(value.notes) &&
    value.notes.every(isNote);
  if (!valid) return null;

  // Saves from before the brass part get one, written around their notes below.
  const brassless = !isNum(seeds.brass);
  const settings = {
    ...s,
    trackSeeds: brassless ? { ...seeds, brass: deriveSeed(s.seed as number, 'brass') } : seeds,
    phrase: typeof s.phrase === 'string' && s.phrase in PHRASE_FORMS ? s.phrase : 'auto',
    transition: typeof s.transition === 'string' && s.transition in TRANSITIONS ? s.transition : 'auto',
    // Saves from before the setting get the default.
    creativity: isNum(s.creativity) ? Math.min(1, Math.max(0, s.creativity)) : createSettings().creativity,
    automationSeed: isNum(s.automationSeed) ? s.automationSeed : deriveSeed(s.seed as number, 'automation'),
  } as CompositionSettings;
  if (!isNum(settings.harmonySeed)) delete settings.harmonySeed;
  const progression = value.progression as Chord[];
  const phrasing = isPhrasing(value.phrasing) ? value.phrasing : generateComposition(settings).phrasing;
  let notes = value.notes as NoteEvent[];
  if (brassless) {
    const part = (...tracks: TrackId[]) => notes.filter((n) => tracks.includes(n.track));
    const brass = generateBrass(settings, progression, part('melody'), part('counter'), part('chords', 'bass'));
    notes = sortNotes([...notes, ...withTransition(settings, progression, phrasing, 'brass', brass, part('melody'))]);
  }
  const base = { settings, progression, notes } as Omit<Composition, 'phrasing' | 'automation'>;
  const automation =
    Array.isArray(value.automation) && value.automation.every(isLane)
      ? value.automation
      : suggestAutomation({ ...base, phrasing });
  const arrangement =
    isArrangement(value.arrangement) && value.arrangement.style === settings.style
      ? fitArrangement(withBrass(value.arrangement), settings.bars)
      : suggestArrangement(settings.style, settings.bars);
  const source = readSource(value.source);
  const locks = readLocks(value.locks, settings.bars);
  const edited = Array.isArray(value.edited) ? TRACK_IDS.filter((t) => (value.edited as unknown[]).includes(t)) : [];
  return { ...base, phrasing, automation, arrangement, ...(source && { source }), ...(locks && { locks }), ...(edited.length ? { edited } : {}) };
}
