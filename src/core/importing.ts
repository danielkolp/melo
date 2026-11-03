import { fitArrangement, suggestArrangement } from './arrangement';
import { suggestAutomation } from './automation';
import { generateBrass } from './brass';
import { perform } from './expression';
import { clearMelody, generateBass, generateChords, generateCounter, generateProgression, melodySettings, refreshAutomation, withTransition } from './generator';
import { unswingTick } from './groove';
import { generateMelody } from './melody';
import { deriveSeed } from './random';
import type { MidiFile } from './readMidi';
import { clamp, noteId, pc, sortNotes } from './shared';
import { SCALES, buildChord, chromaticNumeral, harmonyPitchClasses, type Extension } from './theory';
import { makeVariations } from './variations';
import {
  PPQ,
  STEP,
  TICKS_PER_BAR,
  TRACK_IDS,
  totalTicks,
  type Arrangement,
  type AutomationLane,
  type BarCount,
  type Chord,
  type ChordQuality,
  type Composition,
  type CompositionSettings,
  type ImportedPart,
  type ImportSource,
  type NoteEvent,
  type Phrasing,
  type ScaleId,
  type StyleId,
  type TrackId,
} from './types';

/** What an uploaded track becomes: one of the parts, or left out. */
export type ImportRole = TrackId | 'skip';
export const IMPORT_ROLES: readonly ImportRole[] = [...TRACK_IDS, 'skip'];

/** A note on the app's grid: PPQ 480, swing taken out, snapped to sixteenths. */
export interface GridNote {
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
}

export interface ImportTrack {
  name: string;
  channel: number;
  drums: boolean;
  /** From the top of the file. */
  notes: GridNote[];
  low: number;
  high: number;
  /** Notes per onset: about 1 for a line, 3 or more for chords. */
  polyphony: number;
  guess: ImportRole;
}

export interface ImportAnalysis {
  fileName: string;
  tracks: ImportTrack[];
  /** The file's tempo, as written. */
  bpm: number;
  /** Read from how late the off-beat sixteenths fall; 50 is straight. */
  swing: number;
  timeSignature: [number, number];
  /** First bar of music (0-based), after any pickup. */
  firstBar: number;
  /** The bar before `firstBar` only has notes in its last beat: a pickup, which wraps round to the end of the loop. */
  pickup: boolean;
  /** Bars of music from `firstBar`. */
  length: number;
  /** Suggested loop length. */
  bars: BarCount;
  key: number;
  scale: ScaleId;
}

export interface ImportChoices {
  /** One per analysed track. */
  roles: ImportRole[];
  bars: BarCount;
  /** First bar of the file to use, 0-based. */
  startBar: number;
  key: number;
  scale: ScaleId;
}

const MONO: ReadonlySet<TrackId> = new Set(['melody', 'counter', 'brass', 'bass']);
const PAIR = 2 * STEP;

// ---------------------------------------------------------------------------
// Reading the file

/** Swing as a percentage, from where the off-beat sixteenths sit inside their pair. */
function estimateSwing(starts: readonly number[]): number {
  const offs = starts.map((t) => t % PAIR).filter((p) => p >= 0.4 * PAIR && p <= 0.8 * PAIR);
  if (offs.length < 4 || offs.length < starts.length * 0.1) return 50;
  offs.sort((a, b) => a - b);
  const swing = Math.round((offs[offs.length >> 1] / PAIR) * 100);
  return swing < 54 ? 50 : clamp(swing, 50, 75);
}

/** Same-pitch notes at the same start merged, and overlapping repeats cut short. */
function tidyNotes(notes: GridNote[]): GridNote[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch || b.duration - a.duration);
  const out = sorted.filter((n, i) => i === 0 || n.start !== sorted[i - 1].start || n.pitch !== sorted[i - 1].pitch);
  out.forEach((n, i) => {
    const next = out.slice(i + 1).find((m) => m.pitch === n.pitch);
    if (next) n.duration = Math.max(STEP, Math.min(n.duration, next.start - n.start));
  });
  return out;
}

/** One note at a time: the top of each onset for a melody, the bottom for a bass line. */
function monophonic(notes: GridNote[], keep: 'top' | 'bottom'): GridNote[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start || (keep === 'top' ? b.pitch - a.pitch : a.pitch - b.pitch));
  const out = sorted.filter((n, i) => i === 0 || n.start !== sorted[i - 1].start);
  out.forEach((n, i) => {
    const next = out[i + 1];
    if (next) n.duration = Math.max(STEP, Math.min(n.duration, next.start - n.start));
  });
  return out;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

function guessRole(track: Pick<ImportTrack, 'name' | 'drums' | 'notes' | 'polyphony'>): ImportRole {
  if (track.drums) return 'skip';
  const name = track.name.toLowerCase();
  if (/bass|808|sub\b/.test(name)) return 'bass';
  if (/chord|pad|keys|piano|stab|organ|rhodes/.test(name)) return 'chords';
  if (/brass|horn|trumpet|trombone|sax/.test(name)) return 'brass';
  if (/arp|counter|pluck/.test(name)) return 'counter';
  if (/lead|melody|vox|vocal|hook|top/.test(name)) return 'melody';
  if (track.polyphony >= 1.8) return 'chords';
  if (median(track.notes.map((n) => n.pitch)) < 52) return 'bass';
  return 'melody';
}

/** One track per part: the busiest keeps a contested role, and a second melody becomes the counter-melody. */
function assignRoles(tracks: readonly Omit<ImportTrack, 'guess'>[], guesses: ImportRole[]): ImportRole[] {
  const out = [...guesses];
  const holders = (role: TrackId) => out.map((g, i) => (g === role ? i : -1)).filter((i) => i >= 0);
  const melodies = holders('melody').sort((a, b) => median(tracks[b].notes.map((n) => n.pitch)) - median(tracks[a].notes.map((n) => n.pitch)));
  if (melodies.length > 1 && !holders('counter').length) out[melodies[1]] = 'counter';
  for (const role of TRACK_IDS) {
    const list = holders(role).sort((a, b) =>
      role === 'melody' ? melodies.indexOf(a) - melodies.indexOf(b) : tracks[b].notes.length - tracks[a].notes.length,
    );
    for (const extra of list.slice(1)) out[extra] = 'skip';
  }
  return out;
}

// Key detection

/** The scales a key can be read as, each with a small handicap: modes need clearer evidence than major and minor. */
const KEY_MODES: readonly [ScaleId, number][] = [
  ['minor', 0],
  ['major', 0.01],
  ['dorian', 0.05],
  ['mixolydian', 0.05],
  ['phrygian', 0.06],
  ['harmonicMinor', 0.06],
  ['lydian', 0.15],
];
/** How much the bass naming a tonic counts, against how well the notes match the key's profile (a correlation, up to 1). */
const ROOT_PULL = 0.9;
/** Notes outside the scale count against it this much, per share of the music. */
const OUTSIDE_COST = 2;
/** The first bar usually states the tonic: its roots count this many times over. */
const FIRST_BAR_PULL = 3;
/** Roots are read from notes below this; a high melody alone says little about the root. */
const ROOT_CEILING = 64;

/** After Krumhansl–Kessler: the tonic weighs most, then the fifth, then the third, then the rest of the scale. */
function keyProfile(scale: ScaleId): number[] {
  const set = SCALES[scale].harmony;
  return Array.from({ length: 12 }, (_, i) => (i === 0 ? 6.35 : !set.includes(i) ? 2.4 : i === 7 ? 5 : i === 3 || i === 4 ? 4.5 : 3.6));
}
const KEY_PROFILES = new Map(KEY_MODES.map(([scale]) => [scale, keyProfile(scale)]));

function correlation(xs: readonly number[], ys: readonly number[]): number {
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  xs.forEach((x, i) => {
    num += (x - mx) * (ys[i] - my);
    dx += (x - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  });
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

/** The likeliest root of notes heard together: the one with most chord tones above it, the lowest note favoured. */
function rootOf(pitches: readonly number[], lowest: number): number {
  const has = new Set(pitches.map(pc));
  let best = pc(lowest);
  let top = -Infinity;
  for (const r of has) {
    const at = (i: number) => has.has(pc(r + i));
    const score = (at(7) ? 1 : 0) + (at(3) || at(4) ? 0.8 : 0) + (at(10) || at(11) ? 0.3 : 0) + (r === pc(lowest) ? 0.75 : 0);
    if (score > top) [top, best] = [score, r];
  }
  return best;
}

/** How often each pitch class is the root at the head of a half bar: where the bass and chords name the tonic. */
function rootShares(notes: readonly GridNote[]): number[] {
  const roots = new Array<number>(12).fill(0);
  const half = TICKS_PER_BAR / 2;
  const first = Math.min(...notes.map((n) => n.start));
  const last = Math.max(...notes.map((n) => n.start));
  const firstBarEnd = (Math.floor(first / TICKS_PER_BAR) + 1) * TICKS_PER_BAR;
  for (let at = Math.floor(first / half) * half; at <= last; at += half) {
    // What is sounding as the half bar starts, or arrives within a dotted eighth of it.
    const heard = notes.filter((n) => (n.start <= at && n.start + n.duration > at) || (n.start >= at && n.start < at + 3 * STEP));
    if (!heard.length) continue;
    const lowest = Math.min(...heard.map((n) => n.pitch));
    if (lowest >= ROOT_CEILING) continue;
    const weight = (at % TICKS_PER_BAR === 0 ? 1 : 0.5) * (at < firstBarEnd ? FIRST_BAR_PULL : 1);
    roots[rootOf(heard.map((n) => n.pitch), lowest)] += weight;
  }
  const total = roots.reduce((a, b) => a + b, 0) || 1;
  return roots.map((w) => w / total);
}

export interface KeyReading {
  key: number;
  scale: ScaleId;
  score: number;
}

/**
 * Every key the notes could be in, likeliest first. Each is scored on how well the notes match its
 * profile (tonic, fifth and third weigh most), how often the bass and chords sit on its tonic
 * (most of all in the first bar), and how many notes fall outside its scale.
 */
export function rankKeys(notes: readonly GridNote[]): KeyReading[] {
  const hist = new Array<number>(12).fill(0);
  for (const n of notes) hist[pc(n.pitch)] += (Math.min(n.duration, TICKS_PER_BAR) / STEP) * (n.start % TICKS_PER_BAR === 0 ? 1.5 : 1);
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return [{ key: 0, scale: 'minor', score: 0 }];
  const roots = rootShares(notes);
  const out: KeyReading[] = [];
  for (let key = 0; key < 12; key++) {
    const rotated = hist.map((_, i) => hist[(i + key) % 12]);
    for (const [scale, handicap] of KEY_MODES) {
      const set = new Set(harmonyPitchClasses(key, scale));
      const outside = hist.reduce((sum, w, p) => (set.has(p) ? sum : sum + w), 0) / total;
      const score = correlation(rotated, KEY_PROFILES.get(scale)!) + ROOT_PULL * roots[key] - OUTSIDE_COST * outside - handicap;
      out.push({ key, scale, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The key the notes are most likely in. */
export function detectKey(notes: readonly GridNote[]): { key: number; scale: ScaleId } {
  const [{ key, scale }] = rankKeys(notes);
  return { key, scale };
}

/** Notes of the tracks given a part, inside the chosen bars: what the key is read from. */
export function chosenNotes(analysis: Pick<ImportAnalysis, 'tracks'>, roles: readonly ImportRole[], startBar: number, bars: number): GridNote[] {
  const from = startBar * TICKS_PER_BAR;
  const to = from + bars * TICKS_PER_BAR;
  return analysis.tracks.flatMap((t, i) => (t.drums || roles[i] === 'skip' ? [] : t.notes.filter((n) => n.start >= from && n.start < to)));
}

/** Reads an uploaded file into tracks on the grid, with guesses for role, key, groove and length. */
export function analyseMidi(file: MidiFile, fileName: string): ImportAnalysis {
  const scale = PPQ / file.ppq;
  const raw = file.tracks.map((t) => t.notes.map((n) => ({ ...n, start: n.start * scale, duration: n.duration * scale })));
  const swing = estimateSwing(raw.flatMap((notes, i) => (file.tracks[i].drums ? [] : notes.map((n) => n.start))));
  const grid = (t: number) => Math.round(unswingTick(t, swing) / STEP) * STEP;

  const base = file.tracks.map((t, i) => {
    const notes = tidyNotes(
      raw[i].map((n) => {
        const start = grid(n.start);
        return { pitch: n.pitch, start, duration: Math.max(STEP, grid(n.start + n.duration) - start), velocity: n.velocity };
      }),
    );
    const pitches = notes.map((n) => n.pitch);
    return {
      name: t.name,
      channel: t.channel,
      drums: t.drums,
      notes,
      low: Math.min(...pitches),
      high: Math.max(...pitches),
      polyphony: notes.length / new Set(notes.map((n) => n.start)).size,
    };
  });
  const roles = assignRoles(base, base.map(guessRole));
  const tracks = base.map((t, i) => ({ ...t, guess: roles[i] }));

  const pitched = tracks.filter((t) => !t.drums);
  const music = (pitched.length ? pitched : tracks).flatMap((t) => t.notes);
  const starts = music.map((n) => n.start);
  let firstBar = Math.floor(Math.min(...starts) / TICKS_PER_BAR);
  const last = Math.max(...starts);
  const opening = music.filter((n) => n.start < (firstBar + 1) * TICKS_PER_BAR);
  const pickup = last >= (firstBar + 1) * TICKS_PER_BAR && opening.every((n) => n.start >= firstBar * TICKS_PER_BAR + 3 * PPQ);
  if (pickup) firstBar++;
  const length = Math.max(1, Math.ceil((last + STEP - firstBar * TICKS_PER_BAR) / TICKS_PER_BAR));

  const bars: BarCount = length <= 2 ? 2 : length <= 4 ? 4 : 8;
  // Read from the parts and bars the dialog starts on; with every track left out, from all of them.
  const chosen = chosenNotes({ tracks }, roles, firstBar, bars);
  return {
    fileName,
    tracks,
    bpm: file.bpm,
    swing,
    timeSignature: file.timeSignature,
    firstBar,
    pickup,
    length,
    bars,
    ...detectKey(chosen.length ? chosen : pitched.flatMap((t) => t.notes)),
  };
}

// ---------------------------------------------------------------------------
// Harmony

interface Candidate extends Omit<Chord, 'start' | 'duration'> {
  outside: boolean;
  /** Pitch class of the seventh this chord could take. */
  seventh: number;
}

/** Diatonic triads, plus major and minor triads on every other root for chords from outside the key. */
function candidates(key: number, scale: ScaleId): Candidate[] {
  const keyScale = harmonyPitchClasses(key, scale);
  const out: Candidate[] = Array.from({ length: 7 }, (_, d) => {
    const chord = buildChord(key, scale, d, 3);
    return { ...chord, outside: false, seventh: keyScale[(d + 6) % 7] };
  });
  const known = new Set(out.map((c) => c.tones.join()));
  for (let root = 0; root < 12; root++) {
    for (const quality of ['maj', 'min'] as ChordQuality[]) {
      const tones = [root, (root + (quality === 'maj' ? 4 : 3)) % 12, (root + 7) % 12];
      if (known.has(tones.join())) continue;
      // Over it, each borrowed tone takes the place of the scale note a semitone away (above first: a flat).
      const altered = [...keyScale];
      for (const t of tones.filter((x) => !keyScale.includes(x))) {
        const i = [altered.indexOf((t + 1) % 12), altered.indexOf((t + 11) % 12)].find((j) => j >= 0 && !tones.includes(altered[j]));
        if (i !== undefined) altered[i] = t;
      }
      const degree = [root, (root + 1) % 12, (root + 11) % 12].map((p) => keyScale.indexOf(p)).find((d) => d >= 0) ?? 0;
      out.push({
        degree,
        root,
        tones,
        quality,
        scale: altered,
        numeral: chromaticNumeral(key, root, quality),
        outside: true,
        seventh: (root + 10) % 12,
      });
    }
  }
  return out;
}

/** How much each part's notes say about the harmony. */
const ROLE_WEIGHT: Record<TrackId, number> = { chords: 1.2, bass: 1, melody: 0.7, counter: 0.6, brass: 0.6 };

interface Segment {
  start: number;
  end: number;
  /** Weight per pitch class. */
  hist: number[];
  total: number;
  /** The bass note under the segment's start, if the upload has one. */
  bass: number | null;
}

function segment(parts: readonly ImportedPart[], start: number, end: number): Segment {
  const hist = new Array<number>(12).fill(0);
  for (const part of parts) {
    for (const n of part.notes) {
      const s = Math.max(n.start, start);
      const e = Math.min(n.start + n.duration, end);
      if (e <= s) continue;
      const fresh = n.start >= start;
      const strength = !fresh ? 0.8 : n.start % TICKS_PER_BAR === 0 ? 1.6 : n.start % (2 * PPQ) === 0 ? 1.3 : n.start % PPQ === 0 ? 1.15 : 1;
      hist[pc(n.pitch)] += Math.sqrt((e - s) / STEP) * strength * ROLE_WEIGHT[part.track];
    }
  }
  const low = parts.find((p) => p.track === 'bass') ?? parts.find((p) => p.track === 'chords');
  const under = low?.notes
    .filter((n) => n.start < Math.min(end, start + PPQ) && n.start + n.duration > start)
    .sort((a, b) => a.pitch - b.pitch)[0];
  return { start, end, hist, total: hist.reduce((a, b) => a + b, 0), bass: under ? pc(under.pitch) : null };
}

function score(c: Candidate, seg: Segment, keyScale: readonly number[], first: boolean): number {
  let s = 0;
  seg.hist.forEach((w, p) => {
    if (!w) return;
    const i = c.tones.indexOf(p);
    if (i === 0) s += w;
    else if (i === 1) s += 0.9 * w;
    else if (i === 2) s += 0.75 * w;
    else if (p === c.seventh) s += 0.2 * w;
    else s -= ((c.scale ?? keyScale).includes(p) ? 0.55 : 1) * w;
  });
  if (seg.bass !== null) s += (seg.bass === c.root ? 0.45 : c.tones.includes(seg.bass) ? 0.1 : -0.2) * seg.total;
  if (c.outside) s -= 0.3 * seg.total;
  if (c.quality === 'dim' || c.quality === 'aug') s -= 0.35 * seg.total;
  if (first && !c.outside && c.degree === 0) s += 0.08 * seg.total;
  return s;
}

/** The best chord for a segment, with a seventh (and ninth) where the upload plays them. */
function bestChord(options: readonly Candidate[], seg: Segment, key: number, scale: ScaleId, first: boolean): { chord: Candidate; score: number } {
  const keyScale = harmonyPitchClasses(key, scale);
  let best = options[0];
  let top = -Infinity;
  for (const c of options) {
    const s = score(c, seg, keyScale, first);
    if (s > top) {
      top = s;
      best = c;
    }
  }
  const plays = (p: number) => seg.hist[p] >= 0.12 * seg.total;
  if (!plays(best.seventh)) return { chord: best, score: top };
  if (best.outside) return { chord: { ...best, tones: [...best.tones, best.seventh] }, score: top };
  const ninth = keyScale[(best.degree + 1) % 7];
  const size: Extension = plays(ninth) ? 5 : 4;
  return { chord: { ...best, ...buildChord(key, scale, best.degree, size) }, score: top };
}

const sameChord = (a: Pick<Chord, 'tones'>, b: Pick<Chord, 'tones'>) => a.tones.join() === b.tones.join();

/**
 * The chords the upload implies, one per bar, or two where the bar clearly changes halfway.
 * Uploaded chords are read most literally, then the bass (its downbeat note is taken as the
 * root), then the melody, whose strong beats count most.
 */
export function inferProgression(parts: readonly ImportedPart[], key: number, scale: ScaleId, bars: number): Chord[] {
  const options = candidates(key, scale);
  // A melody alone moves around inside a chord, so it needs more evidence before a bar is split.
  const margin = parts.some((p) => p.track === 'chords' || p.track === 'bass') ? 0.08 : 0.2;
  const out: Chord[] = [];
  const place = (c: Candidate, start: number, duration: number): Chord => ({
    degree: c.degree,
    root: c.root,
    tones: c.tones,
    quality: c.quality,
    ...(c.scale && { scale: c.scale }),
    ...(c.numeral && { numeral: c.numeral }),
    start,
    duration,
  });
  for (let bar = 0; bar < bars; bar++) {
    const start = bar * TICKS_PER_BAR;
    const half = start + TICKS_PER_BAR / 2;
    const whole = segment(parts, start, start + TICKS_PER_BAR);
    const previous = out[out.length - 1];
    if (!whole.total) {
      const held = previous ?? { ...buildChord(key, scale, 0, 3), start: 0, duration: 0 };
      out.push({ ...held, start, duration: TICKS_PER_BAR });
      continue;
    }
    const full = bestChord(options, whole, key, scale, bar === 0);
    const front = segment(parts, start, half);
    const back = segment(parts, half, start + TICKS_PER_BAR);
    if (front.total > 0.2 * whole.total && back.total > 0.2 * whole.total) {
      const a = bestChord(options, front, key, scale, bar === 0);
      const b = bestChord(options, back, key, scale, false);
      if (!sameChord(a.chord, b.chord) && a.score + b.score > full.score + margin * whole.total) {
        out.push(place(a.chord, start, TICKS_PER_BAR / 2), place(b.chord, half, TICKS_PER_BAR / 2));
        continue;
      }
    }
    out.push(place(full.chord, start, TICKS_PER_BAR));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Building the source

/**
 * The chosen tracks as parts, fitted into the loop: a shorter idea repeats to fill it, a pickup
 * wraps round to the end, and melody, counter and bass keep one note at a time.
 */
export function buildImport(analysis: ImportAnalysis, choices: ImportChoices, seed: number): ImportSource {
  const end = totalTicks(choices.bars);
  const origin = choices.startBar * TICKS_PER_BAR;
  const available = Math.max(1, analysis.length - (choices.startBar - analysis.firstBar));
  const span = available < choices.bars && choices.bars % available === 0 ? available : choices.bars;
  const wrap = analysis.pickup && choices.startBar === analysis.firstBar;

  const parts: ImportedPart[] = [];
  analysis.tracks.forEach((t, i) => {
    const track = choices.roles[i];
    if (!track || track === 'skip') return;
    const window = t.notes
      .filter((n) => n.start >= origin && n.start < origin + span * TICKS_PER_BAR)
      .map((n) => ({ ...n, start: n.start - origin, duration: Math.min(n.duration, origin + span * TICKS_PER_BAR - n.start) }));
    let notes: GridNote[] = [];
    for (let k = 0; k < choices.bars / span; k++) notes.push(...window.map((n) => ({ ...n, start: n.start + k * span * TICKS_PER_BAR })));
    if (wrap) notes.push(...t.notes.filter((n) => n.start >= origin - PPQ && n.start < origin).map((n) => ({ ...n, start: end - (origin - n.start), duration: Math.min(n.duration, origin - n.start) })));
    notes = notes.map((n) => ({ ...n, duration: Math.min(n.duration, end - n.start) }));
    notes = MONO.has(track) ? monophonic(notes, track === 'bass' ? 'bottom' : 'top') : tidyNotes(notes);
    if (!notes.length) return;
    const partSeed = deriveSeed(seed, `upload/${track}`);
    parts.push({ track, name: t.name, notes: notes.map((n, j) => ({ ...n, id: noteId(track, partSeed, j), track })) });
  });
  if (!parts.length) throw new Error('There are no notes in the chosen bars for the parts you picked.');

  return {
    fileName: analysis.fileName,
    key: choices.key,
    scale: choices.scale,
    bars: choices.bars,
    progression: inferProgression(parts, choices.key, choices.scale, choices.bars),
    parts,
    variationSeed: deriveSeed(seed, 'variations'),
    amount: 0.5,
    picked: Object.fromEntries(parts.map((p) => [p.track, 0])),
  };
}

// ---------------------------------------------------------------------------
// Moving held parts with the loop's key, scale and length

export interface Place {
  key: number;
  scale: ScaleId;
}

/** The nearest way to move from one tonic to another, -6 to +5 semitones. */
const shiftBetween = (from: number, to: number) => ((((to - from) % 12) + 18) % 12) - 6;

/** Transposes to the new tonic and, if the scale changes, moves each note to the same degree of the new one. */
export function movePitch(pitch: number, from: Place, to: Place): number {
  const shift = shiftBetween(from.key, to.key);
  const a = SCALES[from.scale].harmony;
  const b = SCALES[to.scale].harmony;
  if (a.every((x, i) => x === b[i])) return pitch + shift;
  const rel = pc(pitch - from.key);
  let i = a.length - 1;
  while (i > 0 && a[i] > rel) i--;
  return pitch - rel + shift + b[i] + (rel - a[i]);
}

export function moveNotes(notes: readonly NoteEvent[], from: Place, to: Place): NoteEvent[] {
  if (from.key === to.key && from.scale === to.scale) return [...notes];
  return notes.map((n) => {
    let pitch = movePitch(n.pitch, from, to);
    while (pitch > 108) pitch -= 12;
    while (pitch < 21) pitch += 12;
    return { ...n, pitch };
  });
}

/** Chords in the key are rebuilt on the same degree; chords from outside it keep their relation to the tonic. */
export function moveChords(chords: readonly Chord[], from: Place, to: Place): Chord[] {
  if (from.key === to.key && from.scale === to.scale) return [...chords];
  const shift = shiftBetween(from.key, to.key);
  return chords.map((c) => {
    if (c.numeral) {
      const move = (p: number) => pc(p + shift);
      return { ...c, root: move(c.root), tones: c.tones.map(move), scale: c.scale?.map(move) };
    }
    const size = clamp(c.tones.length, 3, 5) as Extension;
    return { ...c, ...buildChord(to.key, to.scale, c.degree, size) };
  });
}

/** Repeats a shorter loop to fill a longer one, or cuts a longer one down. */
export function fitToBars<T extends { start: number; duration: number }>(items: readonly T[], from: number, to: number, rename?: (item: T, copy: number) => T): T[] {
  if (from === to) return [...items];
  const end = totalTicks(to);
  if (to < from) return items.filter((n) => n.start < end).map((n) => ({ ...n, duration: Math.min(n.duration, end - n.start) }));
  const out: T[] = [];
  for (let k = 0; k < to / from; k++) {
    for (const n of items) {
      const copy = { ...n, start: n.start + k * totalTicks(from) };
      out.push(k && rename ? rename(copy, k) : copy);
    }
  }
  return out;
}

export const renameNote = (n: NoteEvent, copy: number): NoteEvent => ({ ...n, id: `${n.id}~${copy}` });

/** The notes of one take: 0 the upload, 1–6 a variation card. */
export function takeNotes(source: ImportSource, track: TrackId, style: StyleId, take = source.picked[track] ?? 0): NoteEvent[] {
  const part = source.parts.find((p) => p.track === track);
  if (!part) return [];
  if (take <= 0) return part.notes;
  return makeVariations(source, track, style)[take - 1]?.notes ?? part.notes;
}

/** A take moved into the loop's key and length. */
function placeTake(source: ImportSource, track: TrackId, settings: CompositionSettings, take?: number): NoteEvent[] {
  const notes = moveNotes(takeNotes(source, track, settings.style, take), source, settings);
  return fitToBars(notes, source.bars, settings.bars, renameNote);
}

export interface Held {
  progression: Chord[];
  /** Notes of the held parts. */
  notes: NoteEvent[];
}

export const heldTracks = (source: ImportSource | undefined): Set<TrackId> => new Set(source?.parts.map((p) => p.track));

/** The held parts and harmony, freshly loaded from the source's picked takes. */
export function loadHeld(source: ImportSource, settings: CompositionSettings): Held {
  return {
    progression: fitToBars(moveChords(source.progression, source, settings), source.bars, settings.bars),
    notes: source.parts.flatMap((p) => placeTake(source, p.track, settings)),
  };
}

/**
 * The held parts for new settings. A key or scale change moves the notes as they are, edits and
 * all; a new length reloads the picked takes, since a cut-down loop can't be grown back.
 */
export function heldFor(composition: Composition, next: CompositionSettings): Held {
  const { source, settings } = composition;
  if (!source) return { progression: [], notes: [] };
  if (next.bars !== settings.bars) {
    const held = loadHeld(source, next);
    // After New chords the harmony is the loop's own, written again for the new length.
    return next.harmonySeed === undefined ? held : { ...held, progression: generateProgression(next) };
  }
  const held = heldTracks(source);
  return {
    progression: moveChords(composition.progression, settings, next),
    notes: moveNotes(
      composition.notes.filter((n) => held.has(n.track)),
      settings,
      next,
    ),
  };
}

/** An uploaded melody carries itself: every bar is the upload's own. */
function heldPhrasing(bars: number): Phrasing {
  return {
    form: 'hook',
    sections: Array.from({ length: bars }, (_, bar) => ({ start: bar * TICKS_PER_BAR, duration: TICKS_PER_BAR, role: 'yours', voice: 'melody' })),
  };
}

/** The loop written around the held parts: their harmony, their notes, and fresh parts for the rest. */
export function composeAround(
  settings: CompositionSettings,
  source: ImportSource,
  held: Held,
  previousLanes: readonly AutomationLane[] = [],
  previousArrangement?: Arrangement,
): Composition {
  return composeParts(settings, { ...held, tracks: heldTracks(source) }, previousLanes, previousArrangement, source);
}

/** Parts kept while the rest of the loop is written: uploaded, locked or edited ones. */
export interface Fixed {
  /** The harmony they were written over. */
  progression: Chord[];
  tracks: ReadonlySet<TrackId>;
  notes: NoteEvent[];
  /** A kept melody's phrasing. Unset: an uploaded melody, which carries every bar itself. */
  phrasing?: Phrasing;
}

/**
 * The loop written around fixed parts: their harmony and notes, exactly as they are, and fresh
 * parts for the rest, which take the style's touch and their share of the transition.
 */
export function composeParts(
  settings: CompositionSettings,
  fixed: Fixed,
  previousLanes: readonly AutomationLane[] = [],
  previousArrangement?: Arrangement,
  source?: ImportSource,
): Composition {
  const { tracks, progression } = fixed;
  const keep = (track: TrackId) => fixed.notes.filter((n) => n.track === track);

  // As in a fresh loop, each written part locks to the ones already there, held parts included.
  const chords = tracks.has('chords') ? keep('chords') : generateChords(settings, progression, keep('bass'));
  const bass = tracks.has('bass') ? keep('bass') : generateBass(settings, progression, chords);
  let melody: NoteEvent[];
  let phrasing: Phrasing;
  if (tracks.has('melody')) {
    melody = keep('melody');
    phrasing = fixed.phrasing ?? heldPhrasing(settings.bars);
  } else {
    ({ notes: melody, phrasing } = generateMelody(melodySettings(settings, tracks), progression));
  }
  // Written parts play their share of the loop's transition; held parts stay exactly as uploaded.
  const top = tracks.has('melody') ? melody : withTransition(settings, progression, phrasing, 'melody', melody);
  const ending = (track: TrackId, part: NoteEvent[]) => (tracks.has(track) ? part : withTransition(settings, progression, phrasing, track, part, top));
  const counter = tracks.has('counter') ? keep('counter') : generateCounter(settings, progression, melody, phrasing);
  const brass = tracks.has('brass') ? keep('brass') : generateBrass(settings, progression, melody, counter, [...chords, ...bass]);
  // Written parts are played with the style's touch; held parts keep the upload's own.
  const written = new Set(TRACK_IDS.filter((t) => !tracks.has(t)));
  const notes = perform(settings, sortNotes([
    ...top,
    ...ending('counter', counter),
    ...ending('brass', brass),
    ...ending('chords', tracks.has('chords') ? chords : clearMelody(generateChords(settings, progression, keep('bass'), top), top)),
    ...ending('bass', bass),
  ]), written);
  const automation = suggestAutomation({ settings, progression, phrasing, notes }, previousLanes);
  const arrangement =
    previousArrangement?.style === settings.style
      ? fitArrangement(previousArrangement, settings.bars)
      : suggestArrangement(settings.style, settings.bars);
  return { settings, progression, phrasing, notes, automation, arrangement, ...(source && { source }) };
}

/**
 * Loads a take of one held part into the loop. A generated counter-melody and brass are
 * rewritten for a new melody take, since they are written around the melody.
 */
export function loadTake(composition: Composition, track: TrackId, take: number): Composition {
  const { source, settings, progression, phrasing } = composition;
  if (!source || !source.parts.some((p) => p.track === track)) return composition;
  const next = { ...source, picked: { ...source.picked, [track]: take } };
  const fresh = placeTake(next, track, settings, take);
  const replaced = new Set<TrackId>([track]);
  const held = heldTracks(source);
  const melody = track === 'melody' ? [...fresh] : composition.notes.filter((n) => n.track === 'melody');
  let counter = composition.notes.filter((n) => n.track === 'counter');
  if (track === 'melody' && !held.has('counter')) {
    replaced.add('counter');
    counter = generateCounter(settings, progression, melody, phrasing);
    fresh.push(...withTransition(settings, progression, phrasing, 'counter', counter));
  }
  if (track === 'melody' && !held.has('brass')) {
    replaced.add('brass');
    const around = composition.notes.filter((n) => n.track === 'chords' || n.track === 'bass');
    fresh.push(...withTransition(settings, progression, phrasing, 'brass', generateBrass(settings, progression, melody, counter, around), melody));
  }
  const kept = composition.notes.filter((n) => !replaced.has(n.track));
  // The rewritten followers get the style's touch; the take itself plays as uploaded.
  const followers = new Set([...replaced].filter((t) => t !== track));
  return refreshAutomation({ ...composition, source: next, notes: sortNotes([...kept, ...perform(settings, fresh, followers)]) });
}
