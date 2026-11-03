import { BASELINE, valueAt } from './automation';
import { beatHits, type DrumHit } from './beat';
import { resolveTransition } from './transition';
import {
  STEPS_PER_BAR,
  STEP,
  TICKS_PER_BAR,
  TRACK_IDS,
  totalTicks,
  type Arrangement,
  type AutomationParam,
  type AutomationPoint,
  type Composition,
  type DrumLevel,
  type FilterMove,
  type NoteEvent,
  type SectionKind,
  type SongSection,
  type StyleId,
  type TrackId,
} from './types';

/**
 * Song arrangement: lays the loop out into a full track as a run of
 * sections, each choosing which parts play, how much of the beat, and
 * whether the mix is filtered. Pure data in, data out; the audio engine and
 * the song export both read it from here.
 */

type Parts = Record<TrackId, boolean>;
/** Which parts play. The brass, last, comes in only where the track lifts. */
const parts = (melody: boolean, counter: boolean, chords: boolean, bass: boolean, brass = false): Parts => ({ melody, counter, brass, chords, bass });
const ALL = parts(true, true, true, true, true);

export interface SectionKindDef {
  label: string;
  /** Why a section like this is there, in a sentence. */
  reason: string;
  parts: Parts;
  drums: DrumLevel;
  filter: FilterMove;
}

export const SECTION_KINDS: Record<SectionKind, SectionKindDef> = {
  intro: {
    label: 'Intro',
    reason: 'A filtered loop over light drums gives the listener (and the DJ) a way in before the bass arrives.',
    parts: parts(false, false, true, false),
    drums: 'light',
    filter: 'dark',
  },
  verse: {
    label: 'Verse',
    reason: 'Bass, chords and drums carry the groove and leave the top line free for a vocal.',
    parts: parts(false, true, true, true),
    drums: 'full',
    filter: 'open',
  },
  build: {
    label: 'Build',
    reason: 'The kick drops out, a clap roll speeds up and the filter opens, so the drop lands harder.',
    parts: parts(false, true, true, false),
    drums: 'build',
    filter: 'rise',
  },
  drop: {
    label: 'Drop',
    reason: 'Everything in at once: the payoff the intro and build were promising.',
    parts: ALL,
    drums: 'full',
    filter: 'open',
  },
  hook: {
    label: 'Hook',
    reason: 'The catchiest version of the loop, every part in, so it sticks.',
    parts: ALL,
    drums: 'full',
    filter: 'open',
  },
  breakdown: {
    label: 'Breakdown',
    reason: 'Drums and bass step out so the chords and melody can breathe before the next drop.',
    parts: parts(true, false, true, false),
    drums: 'off',
    filter: 'open',
  },
  bridge: {
    label: 'Bridge',
    reason: 'A change of texture between hooks, so the last one feels new again.',
    parts: parts(false, true, true, true, true),
    drums: 'light',
    filter: 'open',
  },
  outro: {
    label: 'Outro',
    reason: 'Parts leave the way they came in, so the track winds down and can be mixed out.',
    parts: parts(false, false, true, true),
    drums: 'light',
    filter: 'dark',
  },
};

export const SECTION_KIND_IDS = Object.keys(SECTION_KINDS) as SectionKind[];
export const DRUM_LEVELS: readonly DrumLevel[] = ['off', 'light', 'full', 'build'];
export const FILTER_MOVES: readonly FilterMove[] = ['open', 'dark', 'rise'];
export const SECTION_LENGTHS = [4, 8, 16, 32] as const;

type Entry = [SectionKind, number, Partial<Pick<SongSection, 'parts' | 'drums' | 'filter'>>?];
interface Template {
  name: string;
  entries: Entry[];
}

const rapIntro = { parts: parts(true, false, true, false), drums: 'off' as const };

/** Two structures per style: the full-length version and a shorter one. */
const TEMPLATES: Record<StyleId, Template[]> = {
  house: [
    { name: 'Club mix', entries: [['intro', 16], ['build', 8], ['drop', 32], ['breakdown', 16], ['build', 8], ['drop', 32], ['outro', 16]] },
    { name: 'Radio edit', entries: [['intro', 8], ['drop', 16], ['breakdown', 8], ['build', 8], ['drop', 16], ['outro', 8]] },
  ],
  deepHouse: [
    { name: 'Long blend', entries: [['intro', 16], ['verse', 16], ['drop', 32], ['breakdown', 16], ['drop', 32], ['outro', 16]] },
    { name: 'Short groove', entries: [['intro', 8], ['verse', 16], ['breakdown', 8], ['drop', 32], ['outro', 8]] },
  ],
  melodicHouse: [
    {
      name: 'Journey',
      entries: [
        ['intro', 16],
        ['build', 16],
        ['drop', 32],
        ['breakdown', 16, { parts: parts(true, true, true, false) }],
        ['build', 8],
        ['drop', 32],
        ['outro', 16],
      ],
    },
    { name: 'Radio edit', entries: [['intro', 8], ['build', 8], ['drop', 16], ['breakdown', 8], ['drop', 16], ['outro', 8]] },
  ],
  ukg: [
    {
      name: 'Vocal garage',
      entries: [['intro', 8], ['verse', 16], ['hook', 16], ['verse', 16], ['hook', 16], ['breakdown', 8], ['hook', 16], ['outro', 8]],
    },
    { name: 'Dub', entries: [['intro', 8], ['drop', 16], ['breakdown', 8], ['build', 4], ['drop', 16], ['outro', 8]] },
  ],
  rap: [
    {
      name: 'Two verses',
      entries: [
        ['intro', 8, rapIntro],
        ['hook', 8],
        ['verse', 16],
        ['hook', 8],
        ['verse', 16],
        ['bridge', 8],
        ['hook', 8],
        ['outro', 8, rapIntro],
      ],
    },
    { name: 'Short', entries: [['intro', 4, rapIntro], ['verse', 16], ['hook', 8], ['verse', 16], ['hook', 8], ['outro', 4, rapIntro]] },
  ],
};

/** Rounds a length up to whole passes of the loop, so every section starts at the loop's top. */
export function fitBars(bars: number, loopBars: number): number {
  return Math.max(loopBars, Math.ceil(bars / loopBars) * loopBars);
}

function makeSection(id: string, kind: SectionKind, bars: number, extra: Entry[2] = {}): SongSection {
  const def = SECTION_KINDS[kind];
  return {
    id,
    kind,
    bars,
    parts: { ...def.parts, ...extra.parts },
    drums: extra.drums ?? def.drums,
    filter: extra.filter ?? def.filter,
  };
}

export function templateCount(style: StyleId): number {
  return TEMPLATES[style].length;
}

export function templateName(arrangement: Arrangement): string {
  const list = TEMPLATES[arrangement.style];
  return list[arrangement.template % list.length].name;
}

export function suggestArrangement(style: StyleId, loopBars: number, template = 0): Arrangement {
  const list = TEMPLATES[style];
  const index = ((template % list.length) + list.length) % list.length;
  return {
    style,
    template: index,
    sections: list[index].entries.map(([kind, bars, extra], i) => makeSection(`s${i + 1}`, kind, fitBars(bars, loopBars), extra)),
  };
}

/** The style's next structure, for the dice. */
export function nextTemplate(arrangement: Arrangement, loopBars: number): Arrangement {
  return suggestArrangement(arrangement.style, loopBars, arrangement.template + 1);
}

/** Keeps sections whole passes of the loop when the loop length changes. Returns the same object when nothing moves. */
export function fitArrangement(arrangement: Arrangement, loopBars: number): Arrangement {
  if (arrangement.sections.every((s) => s.bars === fitBars(s.bars, loopBars))) return arrangement;
  return { ...arrangement, sections: arrangement.sections.map((s) => ({ ...s, bars: fitBars(s.bars, loopBars) })) };
}

// ---------------------------------------------------------------------------
// Timeline

export interface SongSpan {
  section: SongSection;
  index: number;
  /** Ticks from the top of the song. */
  start: number;
  end: number;
}

export function songSpans(arrangement: Arrangement): SongSpan[] {
  let start = 0;
  return arrangement.sections.map((section, index) => {
    const span = { section, index, start, end: start + section.bars * TICKS_PER_BAR };
    start = span.end;
    return span;
  });
}

export function songLength(spans: readonly SongSpan[]): number {
  return spans.length ? spans[spans.length - 1].end : 0;
}

export function sectionAt(spans: readonly SongSpan[], tick: number): SongSpan | undefined {
  return spans.find((s) => tick >= s.start && tick < s.end) ?? (tick >= songLength(spans) ? spans[spans.length - 1] : undefined);
}

/** Where in the loop the song is: each section restarts the loop at its top. */
export function loopTickAt(spans: readonly SongSpan[], loopTicks: number, tick: number): number {
  const span = sectionAt(spans, tick);
  return ((tick - (span?.start ?? 0)) % loopTicks + loopTicks) % loopTicks;
}

/** 0–1: how full a section is, for the timeline's tint. */
export function sectionEnergy(section: SongSection): number {
  const playing = TRACK_IDS.filter((t) => section.parts[t]).length;
  const drums = { off: 0, light: 0.15, build: 0.25, full: 0.35 }[section.drums];
  return Math.min(1, (playing / TRACK_IDS.length) * 0.65 + drums);
}

// ---------------------------------------------------------------------------
// What plays where

/**
 * Whether a loop drum hit plays at a drum level. A build keeps only the hats; its clap roll comes
 * from `buildRoll`. Rolls and the transition's fill only play with the full beat.
 */
export function drumPlays(level: DrumLevel, hit: Pick<DrumHit, 'voice' | 'roll' | 'fill'>): boolean {
  const steady = !hit.roll && !hit.fill;
  switch (level) {
    case 'off':
      return false;
    case 'full':
      return true;
    case 'light':
      return steady && hit.voice !== 'clap';
    case 'build':
      return steady && (hit.voice === 'hat' || hit.voice === 'openHat');
  }
}

/** A build's clap roll, from the section's top: quarters, then eighths, then sixteenths, getting louder. */
export function buildRoll(bars: number): DrumHit[] {
  const hits: DrumHit[] = [];
  const total = bars * STEPS_PER_BAR;
  for (let bar = 0; bar < bars; bar++) {
    const through = bar / bars;
    const every = through < 0.5 ? 4 : through < 0.75 ? 2 : 1;
    for (let step = 0; step < STEPS_PER_BAR; step += every) {
      const at = bar * STEPS_PER_BAR + step;
      hits.push({ tick: at * STEP, voice: 'clap', velocity: 0.4 + (0.6 * at) / total });
    }
  }
  return hits;
}

/** The cutoff a filter move asks for, `through` (0–1) of the way into the section. */
export function filterLevel(move: FilterMove, base: number, through: number): number {
  const clamp = (v: number) => Math.min(1, Math.max(0.05, v));
  if (move === 'dark') return clamp(base - 0.35);
  if (move === 'rise') return clamp(base - 0.4 + 0.4 * Math.min(1, Math.max(0, through)));
  return base;
}

/** Each pass of the loop inside a span, as tick offsets. */
function passes(span: SongSpan, loopTicks: number): number[] {
  const out: number[] = [];
  for (let at = span.start; at < span.end; at += loopTicks) out.push(at);
  return out;
}

/** Every note of the song: the active parts' loop notes, pass by pass, cut at each section's end. */
export function songNotes(composition: Composition): NoteEvent[] {
  const loop = totalTicks(composition.settings.bars);
  const out: NoteEvent[] = [];
  for (const span of songSpans(composition.arrangement)) {
    passes(span, loop).forEach((offset, pass) => {
      for (const n of composition.notes) {
        if (!span.section.parts[n.track]) continue;
        const start = offset + n.start;
        if (start >= span.end) continue;
        out.push({ ...n, id: `${n.id}@${span.index}.${pass}`, start, duration: Math.min(n.duration, span.end - start) });
      }
    });
  }
  return out;
}

/** Every drum hit of the song, by each section's drum level. */
export function songBeat(composition: Composition): DrumHit[] {
  const { settings } = composition;
  const loop = totalTicks(settings.bars);
  const hits = beatHits(settings, resolveTransition(settings));
  const out: DrumHit[] = [];
  for (const span of songSpans(composition.arrangement)) {
    const { drums } = span.section;
    if (drums === 'off') continue;
    for (const offset of passes(span, loop)) {
      for (const h of hits) if (drumPlays(drums, h) && offset + h.tick < span.end) out.push({ ...h, tick: offset + h.tick });
    }
    if (drums === 'build') for (const h of buildRoll(span.section.bars)) out.push({ ...h, tick: span.start + h.tick });
  }
  return out.sort((a, b) => a.tick - b.tick);
}

export interface SongLane {
  track: TrackId;
  param: AutomationParam;
  points: AutomationPoint[];
}

/**
 * Full-length automation: enabled lanes repeat on every pass, and sections
 * with a filter move take over the cutoff. Anything else sits at the part's
 * native value.
 */
export function songAutomation(composition: Composition): SongLane[] {
  const loop = totalTicks(composition.settings.bars);
  const spans = songSpans(composition.arrangement);
  const lanes = composition.automation.filter((l) => l.enabled);
  const wanted = new Map<string, { track: TrackId; param: AutomationParam }>();
  for (const l of lanes) wanted.set(`${l.track}:${l.param}`, { track: l.track, param: l.param });
  for (const span of spans) {
    if (span.section.filter === 'open') continue;
    for (const t of TRACK_IDS) if (span.section.parts[t]) wanted.set(`${t}:cutoff`, { track: t, param: 'cutoff' });
  }

  return [...wanted.values()].map(({ track, param }) => {
    const lane = lanes.find((l) => l.track === track && l.param === param);
    const base = BASELINE[track][param];
    const points: AutomationPoint[] = [];
    for (const span of spans) {
      const move = span.section.filter;
      if (param === 'cutoff' && move !== 'open') {
        points.push({ tick: span.start, value: filterLevel(move, base, 0) }, { tick: span.end, value: filterLevel(move, base, 1) });
      } else if (lane) {
        for (const offset of passes(span, loop)) {
          for (const p of lane.points) if (offset + p.tick <= span.end) points.push({ tick: offset + p.tick, value: p.value });
          if (offset + loop > span.end) points.push({ tick: span.end, value: valueAt(lane.points, span.end - offset) });
        }
      } else {
        points.push({ tick: span.start, value: base }, { tick: span.end, value: base });
      }
    }
    return { track, param, points };
  });
}

// ---------------------------------------------------------------------------
// Edits. Each returns a new arrangement, or the same one when nothing changes.

type SectionPatch = Partial<Pick<SongSection, 'kind' | 'bars' | 'drums' | 'filter'>>;

const withSections = (arrangement: Arrangement, sections: SongSection[]): Arrangement => ({ ...arrangement, sections });
const nextId = (arrangement: Arrangement) => `s${Math.max(0, ...arrangement.sections.map((s) => Number(s.id.slice(1)) || 0)) + 1}`;

export function toggleSectionPart(arrangement: Arrangement, id: string, track: TrackId): Arrangement {
  return withSections(
    arrangement,
    arrangement.sections.map((s) => (s.id === id ? { ...s, parts: { ...s.parts, [track]: !s.parts[track] } } : s)),
  );
}

/** Off, light, full, build, then round again. */
export function cycleDrums(arrangement: Arrangement, id: string): Arrangement {
  const section = arrangement.sections.find((s) => s.id === id);
  if (!section) return arrangement;
  const next = DRUM_LEVELS[(DRUM_LEVELS.indexOf(section.drums) + 1) % DRUM_LEVELS.length];
  return updateSection(arrangement, id, { drums: next });
}

/** A new kind brings that kind's parts, drums and filter with it, unless the patch sets them too. */
export function updateSection(arrangement: Arrangement, id: string, patch: SectionPatch): Arrangement {
  const section = arrangement.sections.find((s) => s.id === id);
  if (!section) return arrangement;
  const keys = Object.keys(patch) as (keyof SectionPatch)[];
  if (keys.every((k) => patch[k] === section[k])) return arrangement;
  const base = patch.kind && patch.kind !== section.kind ? makeSection(section.id, patch.kind, section.bars) : section;
  const next = { ...base, ...patch };
  return withSections(arrangement, arrangement.sections.map((s) => (s.id === id ? next : s)));
}

export function moveSection(arrangement: Arrangement, id: string, by: -1 | 1): Arrangement {
  const i = arrangement.sections.findIndex((s) => s.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= arrangement.sections.length) return arrangement;
  const sections = [...arrangement.sections];
  [sections[i], sections[j]] = [sections[j], sections[i]];
  return withSections(arrangement, sections);
}

export function duplicateSection(arrangement: Arrangement, id: string): Arrangement {
  const i = arrangement.sections.findIndex((s) => s.id === id);
  if (i < 0) return arrangement;
  const sections = [...arrangement.sections];
  sections.splice(i + 1, 0, { ...sections[i], parts: { ...sections[i].parts }, id: nextId(arrangement) });
  return withSections(arrangement, sections);
}

/** Adds a section of a kind after `afterId`, or at the end. */
export function insertSection(arrangement: Arrangement, kind: SectionKind, afterId: string | null, loopBars: number): Arrangement {
  const sections = [...arrangement.sections];
  const i = afterId ? sections.findIndex((s) => s.id === afterId) : -1;
  sections.splice(i < 0 ? sections.length : i + 1, 0, makeSection(nextId(arrangement), kind, fitBars(8, loopBars)));
  return withSections(arrangement, sections);
}

/** Removes a section, keeping at least one. */
export function removeSection(arrangement: Arrangement, id: string): Arrangement {
  if (arrangement.sections.length <= 1 || !arrangement.sections.some((s) => s.id === id)) return arrangement;
  return withSections(
    arrangement,
    arrangement.sections.filter((s) => s.id !== id),
  );
}
