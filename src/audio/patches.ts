import { createRng, deriveSeed } from '../core/random';
import type { CompositionSettings, StyleId, TrackId } from '../core/types';

/**
 * The instrument library, as plain data so the UI can list it without
 * loading Tone. Each patch stacks a few synth layers (a body, a transient,
 * a sub) and runs them through a short insert chain before the part's filter.
 */

export type VoiceKind = 'synth' | 'mono' | 'fm';

export interface Layer {
  /** Tone voice: Synth, MonoSynth (has its own filter envelope) or FMSynth. */
  kind: VoiceKind;
  /** Options for that voice, as Tone takes them. */
  options: Record<string, unknown>;
  /** Level in dB within the patch. */
  level: number;
  /** Plays this many octaves away from the written note. */
  octave?: number;
  /** How much velocity changes the level, 0 (none) to 1 (fully). Defaults to 0.75. */
  velocity?: number;
  /** Longest this layer holds a note, in seconds, for transient layers. */
  hold?: number;
  /**
   * Makes the layer monophonic, like an 808: a note that starts while the
   * last is still held slides to its pitch over this many seconds.
   */
  glide?: number;
  /** A monophonic layer's pitch drop at the start of each fresh note: from this many semitones up, over `time` seconds. */
  punch?: { semitones: number; time: number };
}

export type Insert =
  | { type: 'chorus'; frequency: number; delayTime: number; depth: number; wet: number }
  | { type: 'drive'; amount: number; wet: number }
  | { type: 'autopan'; frequency: number; depth: number }
  | { type: 'vibrato'; frequency: number; depth: number }
  | { type: 'highpass'; frequency: number };

export interface Patch {
  id: PatchId;
  label: string;
  /** One line on what it is, for the picker. */
  blurb: string;
  /** Parts it is voiced for. */
  parts: readonly TrackId[];
  layers: Layer[];
  inserts: Insert[];
  /** Output level in dB, set so patches for the same part sit at about the same loudness. */
  level: number;
}

export type PatchId =
  | 'vox'
  | 'pluck'
  | 'lead'
  | 'velvet'
  | 'mallet'
  | 'marimba'
  | 'bell'
  | 'arp'
  | 'stab'
  | 'organ'
  | 'keys'
  | 'pad'
  | 'sub'
  | 'pluckBass'
  | 'warmBass'
  | 'rolling'
  | 'square'
  | 'strings'
  | '808'
  | 'eski'
  | 'brass'
  | 'horns'
  | 'trumpet';

const env = (attack: number, decay: number, sustain: number, release: number) => ({ attack, decay, sustain, release });
const filterEnv = (decay: number, sustain: number, baseFrequency: number, octaves: number, attack = 0.001, release = 0.2) => ({
  attack,
  decay,
  sustain,
  release,
  baseFrequency,
  octaves,
  exponent: 2,
});
const LEAD_PARTS = ['melody', 'counter'] as const;
const KEY_PARTS = ['melody', 'counter', 'chords'] as const;
/** Brass sounds suit the brass part and the lines, and held brass chords suit the chords too. */
const BRASS_PARTS = ['brass', 'melody', 'counter', 'chords'] as const;

export const PATCHES: Record<PatchId, Patch> = {
  vox: {
    id: 'vox',
    label: 'Vowel chop',
    blurb: 'Saw through two fixed formants, so it sings “yah” like a cut-up vocal',
    parts: LEAD_PARTS,
    level: 1.5,
    layers: [
      {
        kind: 'mono',
        level: 0,
        options: {
          oscillator: { type: 'sawtooth' },
          filter: { type: 'bandpass', Q: 2.6, rolloff: -12 },
          filterEnvelope: filterEnv(0.14, 0.5, 520, 0.9),
          envelope: env(0.004, 0.24, 0.42, 0.14),
        },
      },
      {
        kind: 'mono',
        level: -3,
        options: {
          oscillator: { type: 'sawtooth' },
          filter: { type: 'bandpass', Q: 3.2, rolloff: -12 },
          filterEnvelope: filterEnv(0.1, 0.55, 1150, 0.55),
          envelope: env(0.004, 0.22, 0.38, 0.14),
        },
      },
      { kind: 'synth', level: -9, options: { oscillator: { type: 'triangle' }, envelope: env(0.005, 0.3, 0.5, 0.14) } },
    ],
    inserts: [
      { type: 'drive', amount: 0.12, wet: 0.35 },
      { type: 'chorus', frequency: 0.7, delayTime: 2.6, depth: 0.3, wet: 0.25 },
    ],
  },
  pluck: {
    id: 'pluck',
    label: 'Supersaw pluck',
    blurb: 'Detuned saws with a fast filter snap and a soft tail',
    parts: KEY_PARTS,
    level: 4,
    layers: [
      {
        kind: 'mono',
        level: 0,
        options: {
          oscillator: { type: 'fatsawtooth', count: 3, spread: 24 },
          filter: { type: 'lowpass', Q: 1.6, rolloff: -24 },
          filterEnvelope: filterEnv(0.22, 0.12, 360, 4.4, 0.001, 0.3),
          envelope: env(0.003, 0.45, 0.16, 0.24),
        },
      },
      { kind: 'synth', level: -11, options: { oscillator: { type: 'triangle' }, envelope: env(0.003, 0.3, 0.2, 0.2) } },
    ],
    inserts: [{ type: 'chorus', frequency: 0.6, delayTime: 3.2, depth: 0.45, wet: 0.35 }],
  },
  lead: {
    id: 'lead',
    label: 'Saw lead',
    blurb: 'Two saws a few cents apart, bright on the attack, warm on the hold',
    parts: [...LEAD_PARTS, 'brass'],
    level: 2,
    layers: [
      {
        kind: 'mono',
        level: 0,
        options: {
          oscillator: { type: 'fatsawtooth', count: 2, spread: 12 },
          filter: { type: 'lowpass', Q: 1.4, rolloff: -24 },
          filterEnvelope: filterEnv(0.3, 0.35, 520, 3.2),
          envelope: env(0.003, 0.35, 0.45, 0.2),
        },
      },
      { kind: 'synth', level: -12, octave: -1, options: { oscillator: { type: 'sine' }, envelope: env(0.004, 0.3, 0.5, 0.2) } },
    ],
    inserts: [
      { type: 'drive', amount: 0.1, wet: 0.3 },
      { type: 'chorus', frequency: 0.5, delayTime: 2.5, depth: 0.3, wet: 0.2 },
    ],
  },
  velvet: {
    id: 'velvet',
    label: 'Velvet lead',
    blurb: 'A breathy two-operator FM voice with a slow vibrato',
    parts: LEAD_PARTS,
    level: -1.5,
    layers: [
      {
        kind: 'fm',
        level: 0,
        options: {
          harmonicity: 2,
          modulationIndex: 1.6,
          oscillator: { type: 'sine' },
          modulation: { type: 'triangle' },
          envelope: env(0.012, 0.5, 0.55, 0.35),
          modulationEnvelope: env(0.005, 0.35, 0.3, 0.4),
        },
      },
      { kind: 'synth', level: -9, options: { oscillator: { type: 'triangle' }, envelope: env(0.02, 0.4, 0.5, 0.35) } },
    ],
    inserts: [
      { type: 'vibrato', frequency: 4.8, depth: 0.04 },
      { type: 'chorus', frequency: 0.4, delayTime: 3.5, depth: 0.35, wet: 0.25 },
    ],
  },
  mallet: {
    id: 'mallet',
    label: 'Glass mallet',
    blurb: 'FM bell with a hard strike that rings out',
    parts: KEY_PARTS,
    level: 4.5,
    layers: [
      {
        kind: 'fm',
        level: 0,
        velocity: 0.8,
        options: {
          harmonicity: 3.5,
          modulationIndex: 5,
          oscillator: { type: 'sine' },
          modulation: { type: 'sine' },
          envelope: env(0.001, 1.1, 0, 0.6),
          modulationEnvelope: env(0.001, 0.3, 0.05, 0.3),
        },
      },
      { kind: 'synth', level: -15, octave: 1, options: { oscillator: { type: 'sine' }, envelope: env(0.001, 0.25, 0, 0.2) } },
    ],
    inserts: [{ type: 'chorus', frequency: 0.8, delayTime: 2.5, depth: 0.25, wet: 0.2 }],
  },
  marimba: {
    id: 'marimba',
    label: 'Marimba',
    blurb: 'Round wooden tone with a short knock on top',
    parts: KEY_PARTS,
    level: -4,
    layers: [
      { kind: 'synth', level: 0, velocity: 0.8, options: { oscillator: { type: 'sine' }, envelope: env(0.001, 0.55, 0, 0.3) } },
      {
        kind: 'fm',
        level: -7,
        hold: 0.15,
        options: {
          harmonicity: 4,
          modulationIndex: 2.2,
          oscillator: { type: 'sine' },
          modulation: { type: 'sine' },
          envelope: env(0.001, 0.12, 0, 0.08),
          modulationEnvelope: env(0.001, 0.07, 0, 0.05),
        },
      },
    ],
    inserts: [],
  },
  bell: {
    id: 'bell',
    label: 'Soft bell',
    blurb: 'A muted, slightly inharmonic bell that drifts across the stereo field',
    parts: KEY_PARTS,
    level: 3.5,
    layers: [
      {
        kind: 'fm',
        level: 0,
        velocity: 0.7,
        options: {
          harmonicity: 5.07,
          modulationIndex: 1.4,
          oscillator: { type: 'sine' },
          modulation: { type: 'sine' },
          envelope: env(0.002, 0.9, 0.08, 0.7),
          modulationEnvelope: env(0.002, 0.5, 0.1, 0.5),
        },
      },
      { kind: 'synth', level: -8, options: { oscillator: { type: 'triangle' }, envelope: env(0.004, 0.6, 0.15, 0.6) } },
    ],
    inserts: [{ type: 'autopan', frequency: 0.25, depth: 0.45 }],
  },
  arp: {
    id: 'arp',
    label: 'Arp pluck',
    blurb: 'A tight pulse-wave blip made for fast patterns',
    parts: KEY_PARTS,
    level: -3,
    layers: [
      {
        kind: 'mono',
        level: 0,
        options: {
          oscillator: { type: 'pulse', width: 0.4 },
          filter: { type: 'lowpass', Q: 2.8, rolloff: -24 },
          filterEnvelope: filterEnv(0.12, 0.05, 300, 4, 0.001, 0.1),
          envelope: env(0.002, 0.2, 0.1, 0.15),
        },
      },
    ],
    inserts: [{ type: 'chorus', frequency: 0.9, delayTime: 2.2, depth: 0.3, wet: 0.25 }],
  },
  stab: {
    id: 'stab',
    label: 'Garage stab',
    blurb: 'Detuned saws over an organ body, cut short by the filter',
    parts: ['chords', 'melody', 'counter', 'brass'],
    level: 4,
    layers: [
      {
        kind: 'mono',
        level: 0,
        options: {
          oscillator: { type: 'fatsawtooth', count: 3, spread: 18 },
          filter: { type: 'lowpass', Q: 2.4, rolloff: -12 },
          filterEnvelope: filterEnv(0.18, 0.25, 420, 3.6),
          envelope: env(0.002, 0.3, 0.35, 0.18),
        },
      },
      {
        kind: 'synth',
        level: -7,
        options: { oscillator: { type: 'custom', partials: [1, 0.7, 0.45, 0, 0.3] }, envelope: env(0.002, 0.2, 0.3, 0.15) },
      },
    ],
    inserts: [
      { type: 'drive', amount: 0.1, wet: 0.3 },
      { type: 'chorus', frequency: 0.7, delayTime: 3, depth: 0.4, wet: 0.3 },
    ],
  },
  organ: {
    id: 'organ',
    label: 'House organ',
    blurb: 'The bright, barking organ of early-90s house',
    parts: ['chords', 'melody', 'counter', 'brass'],
    level: -3,
    layers: [
      {
        kind: 'synth',
        level: 0,
        options: { oscillator: { type: 'custom', partials: [1, 0.85, 0.5, 0.35, 0.25, 0, 0.15, 0.1] }, envelope: env(0.001, 0.25, 0.55, 0.12) },
      },
      { kind: 'synth', level: -6, octave: 1, hold: 0.12, options: { oscillator: { type: 'sine' }, envelope: env(0.001, 0.09, 0, 0.05) } },
    ],
    inserts: [
      { type: 'drive', amount: 0.18, wet: 0.35 },
      { type: 'chorus', frequency: 1.2, delayTime: 2.5, depth: 0.3, wet: 0.25 },
    ],
  },
  keys: {
    id: 'keys',
    label: 'Electric piano',
    blurb: 'Tine piano with a bell-like strike, a pad underneath and stereo tremolo',
    parts: KEY_PARTS,
    level: 5,
    layers: [
      {
        kind: 'fm',
        level: 0,
        velocity: 0.6,
        options: {
          harmonicity: 1,
          modulationIndex: 2.2,
          oscillator: { type: 'sine' },
          modulation: { type: 'sine' },
          envelope: env(0.002, 1.6, 0.25, 0.6),
          modulationEnvelope: env(0.002, 0.5, 0.15, 0.5),
        },
      },
      {
        kind: 'fm',
        level: -15,
        hold: 0.4,
        options: {
          harmonicity: 14,
          modulationIndex: 0.6,
          oscillator: { type: 'sine' },
          modulation: { type: 'sine' },
          envelope: env(0.001, 0.35, 0, 0.3),
          modulationEnvelope: env(0.001, 0.25, 0, 0.2),
        },
      },
      {
        kind: 'mono',
        level: -14,
        velocity: 0.3,
        options: {
          oscillator: { type: 'fatsawtooth', count: 2, spread: 30 },
          filter: { type: 'lowpass', Q: 0.5, rolloff: -12 },
          filterEnvelope: filterEnv(1, 0.6, 300, 2.2, 0.25, 0.8),
          envelope: env(0.12, 1, 0.7, 0.8),
        },
      },
    ],
    inserts: [
      { type: 'autopan', frequency: 3.2, depth: 0.35 },
      { type: 'chorus', frequency: 0.5, delayTime: 3.5, depth: 0.5, wet: 0.4 },
    ],
  },
  pad: {
    id: 'pad',
    label: 'Wide pad',
    blurb: 'Four detuned saws that open slowly, with a pluck to mark the attack',
    parts: ['chords', 'melody', 'counter'],
    level: -3,
    layers: [
      {
        kind: 'mono',
        level: 0,
        velocity: 0.4,
        options: {
          oscillator: { type: 'fatsawtooth', count: 3, spread: 35 },
          filter: { type: 'lowpass', Q: 0.8, rolloff: -12 },
          filterEnvelope: filterEnv(1.2, 0.55, 500, 2.6, 0.08, 0.9),
          envelope: env(0.05, 1, 0.65, 0.9),
        },
      },
      {
        kind: 'mono',
        level: -8,
        hold: 0.3,
        options: {
          oscillator: { type: 'sawtooth' },
          filter: { type: 'lowpass', Q: 1.2, rolloff: -24 },
          filterEnvelope: filterEnv(0.12, 0, 600, 3),
          envelope: env(0.002, 0.2, 0, 0.12),
        },
      },
    ],
    inserts: [{ type: 'chorus', frequency: 0.35, delayTime: 4, depth: 0.6, wet: 0.5 }],
  },
  sub: {
    id: 'sub',
    label: 'Garage sub',
    blurb: 'A sine sub an octave down with a driven square growl on top',
    parts: ['bass'],
    level: 1,
    layers: [
      { kind: 'synth', level: 0, octave: -1, velocity: 0.3, options: { oscillator: { type: 'sine' }, envelope: env(0.004, 0.4, 0.85, 0.07) } },
      {
        kind: 'mono',
        level: -6,
        options: {
          oscillator: { type: 'square' },
          filter: { type: 'lowpass', Q: 3, rolloff: -24 },
          filterEnvelope: filterEnv(0.16, 0.2, 120, 3.4, 0.001, 0.1),
          envelope: env(0.003, 0.25, 0.5, 0.07),
        },
      },
    ],
    inserts: [{ type: 'drive', amount: 0.35, wet: 0.5 }],
  },
  pluckBass: {
    id: 'pluckBass',
    label: 'Pluck bass',
    blurb: 'A resonant saw that snaps shut, over a clean sub',
    parts: ['bass'],
    level: 0,
    layers: [
      {
        kind: 'mono',
        level: 0,
        options: {
          oscillator: { type: 'sawtooth' },
          filter: { type: 'lowpass', Q: 4.5, rolloff: -24 },
          filterEnvelope: filterEnv(0.13, 0.12, 90, 3.6, 0.001, 0.1),
          envelope: env(0.002, 0.3, 0.55, 0.06),
        },
      },
      { kind: 'synth', level: -3, octave: -1, velocity: 0.3, options: { oscillator: { type: 'sine' }, envelope: env(0.003, 0.3, 0.9, 0.06) } },
    ],
    inserts: [{ type: 'drive', amount: 0.15, wet: 0.4 }],
  },
  warmBass: {
    id: 'warmBass',
    label: 'Warm sub',
    blurb: 'A round triangle sub with a little filtered saw for definition',
    parts: ['bass'],
    level: 4.5,
    layers: [
      { kind: 'synth', level: 0, octave: -1, velocity: 0.35, options: { oscillator: { type: 'triangle' }, envelope: env(0.006, 0.5, 0.8, 0.12) } },
      {
        kind: 'mono',
        level: -9,
        options: {
          oscillator: { type: 'sawtooth' },
          filter: { type: 'lowpass', Q: 1.2, rolloff: -24 },
          filterEnvelope: filterEnv(0.35, 0.3, 140, 2, 0.002, 0.15),
          envelope: env(0.004, 0.4, 0.6, 0.1),
        },
      },
    ],
    inserts: [{ type: 'drive', amount: 0.1, wet: 0.3 }],
  },
  rolling: {
    id: 'rolling',
    label: 'Rolling bass',
    blurb: 'Short detuned saws for driving sixteenth-note lines',
    parts: ['bass'],
    level: 7,
    layers: [
      {
        kind: 'mono',
        level: 0,
        options: {
          oscillator: { type: 'fatsawtooth', count: 2, spread: 12 },
          filter: { type: 'lowpass', Q: 2, rolloff: -24 },
          filterEnvelope: filterEnv(0.1, 0.12, 110, 3.2, 0.001, 0.08),
          envelope: env(0.002, 0.2, 0.45, 0.05),
        },
      },
      { kind: 'synth', level: -2, octave: -1, velocity: 0.3, options: { oscillator: { type: 'sine' }, envelope: env(0.002, 0.2, 0.6, 0.05) } },
    ],
    inserts: [{ type: 'drive', amount: 0.12, wet: 0.35 }],
  },
  square: {
    id: 'square',
    label: 'Square lead',
    blurb: 'Bare square waves with a quick blip on top, cold and digital like an eskibeat riff',
    parts: [...KEY_PARTS, 'brass'],
    level: -6,
    layers: [
      {
        kind: 'mono',
        level: 0,
        options: {
          oscillator: { type: 'square' },
          filter: { type: 'lowpass', Q: 0.7, rolloff: -12 },
          filterEnvelope: filterEnv(0.15, 0.6, 1200, 2),
          envelope: env(0.002, 0.25, 0.5, 0.12),
        },
      },
      { kind: 'synth', level: -14, octave: 1, hold: 0.06, options: { oscillator: { type: 'square' }, envelope: env(0.001, 0.05, 0, 0.03) } },
    ],
    inserts: [{ type: 'chorus', frequency: 0.5, delayTime: 2, depth: 0.15, wet: 0.15 }],
  },
  strings: {
    id: 'strings',
    label: 'Dark strings',
    blurb: 'A slow-bowed saw ensemble, dark and wide, for cinematic minor chords',
    parts: ['chords', 'melody', 'counter', 'brass'],
    level: -4,
    layers: [
      {
        kind: 'mono',
        level: 0,
        velocity: 0.4,
        options: {
          oscillator: { type: 'fatsawtooth', count: 3, spread: 22 },
          filter: { type: 'lowpass', Q: 0.6, rolloff: -12 },
          filterEnvelope: filterEnv(0.8, 0.7, 450, 1.8, 0.12, 0.6),
          envelope: env(0.14, 0.8, 0.85, 0.6),
        },
      },
      { kind: 'synth', level: -10, velocity: 0.4, options: { oscillator: { type: 'triangle' }, envelope: env(0.2, 1, 0.8, 0.6) } },
    ],
    inserts: [
      { type: 'vibrato', frequency: 5, depth: 0.03 },
      { type: 'chorus', frequency: 0.4, delayTime: 4, depth: 0.5, wet: 0.45 },
    ],
  },
  '808': {
    id: '808',
    label: '808',
    blurb: 'A long sine boom with a pitch-drop punch and grit, sliding between notes that run together',
    parts: ['bass'],
    level: 5,
    layers: [
      {
        kind: 'synth',
        level: 0,
        octave: -1,
        velocity: 0.3,
        glide: 0.07,
        punch: { semitones: 12, time: 0.04 },
        options: { oscillator: { type: 'sine' }, envelope: env(0.002, 1.6, 0.5, 0.12) },
      },
      { kind: 'synth', level: -16, hold: 0.04, options: { oscillator: { type: 'triangle' }, envelope: env(0.001, 0.03, 0, 0.02) } },
    ],
    inserts: [{ type: 'drive', amount: 0.45, wet: 0.6 }],
  },
  eski: {
    id: 'eski',
    label: 'Eski square',
    blurb: 'A hollow square-wave bass with a sine underneath, the sound of early grime',
    parts: ['bass'],
    level: 0,
    layers: [
      {
        kind: 'mono',
        level: 0,
        glide: 0.03,
        punch: { semitones: 12, time: 0.012 },
        options: {
          oscillator: { type: 'square' },
          filter: { type: 'lowpass', Q: 1, rolloff: -24 },
          filterEnvelope: filterEnv(0.2, 0.5, 300, 2.2),
          envelope: env(0.002, 0.3, 0.7, 0.06),
        },
      },
      { kind: 'synth', level: -4, octave: -1, options: { oscillator: { type: 'sine' }, envelope: env(0.002, 0.3, 0.8, 0.06) } },
    ],
    inserts: [{ type: 'drive', amount: 0.2, wet: 0.35 }],
  },
  brass: {
    id: 'brass',
    label: 'Synth brass',
    blurb: 'Fat saws whose filter swells open on every note, the analogue brass of 80s pop and French house',
    parts: BRASS_PARTS,
    level: 1,
    layers: [
      {
        kind: 'mono',
        level: 0,
        options: {
          oscillator: { type: 'fatsawtooth', count: 3, spread: 16 },
          filter: { type: 'lowpass', Q: 1.1, rolloff: -24 },
          filterEnvelope: filterEnv(0.35, 0.55, 380, 3, 0.07, 0.25),
          envelope: env(0.035, 0.3, 0.8, 0.22),
        },
      },
      {
        kind: 'mono',
        level: -9,
        options: {
          oscillator: { type: 'pulse', width: 0.3 },
          filter: { type: 'lowpass', Q: 0.8, rolloff: -12 },
          filterEnvelope: filterEnv(0.3, 0.5, 500, 2.4, 0.05, 0.2),
          envelope: env(0.04, 0.3, 0.7, 0.2),
        },
      },
    ],
    inserts: [
      { type: 'vibrato', frequency: 5.2, depth: 0.02 },
      { type: 'chorus', frequency: 0.5, delayTime: 3, depth: 0.35, wet: 0.3 },
    ],
  },
  horns: {
    id: 'horns',
    label: 'Horn stabs',
    blurb: 'A brassy section blast: the filter barks open and shuts fast, with a growl of drive',
    parts: BRASS_PARTS,
    level: 2,
    layers: [
      {
        kind: 'mono',
        level: 0,
        options: {
          oscillator: { type: 'fatsawtooth', count: 2, spread: 10 },
          filter: { type: 'lowpass', Q: 2, rolloff: -24 },
          filterEnvelope: filterEnv(0.16, 0.35, 450, 3.4, 0.012, 0.12),
          envelope: env(0.008, 0.22, 0.6, 0.12),
        },
      },
      {
        kind: 'mono',
        level: -8,
        options: {
          oscillator: { type: 'square' },
          filter: { type: 'bandpass', Q: 1.6, rolloff: -12 },
          filterEnvelope: filterEnv(0.12, 0.4, 900, 1.4, 0.01, 0.1),
          envelope: env(0.01, 0.2, 0.5, 0.1),
        },
      },
    ],
    inserts: [
      { type: 'drive', amount: 0.22, wet: 0.4 },
      { type: 'chorus', frequency: 0.8, delayTime: 2.4, depth: 0.25, wet: 0.2 },
    ],
  },
  trumpet: {
    id: 'trumpet',
    label: 'FM trumpet',
    blurb: 'A single brass voice in FM that brightens as the note blows in, with a singing vibrato',
    parts: BRASS_PARTS,
    level: -1,
    layers: [
      {
        kind: 'fm',
        level: 0,
        options: {
          harmonicity: 1,
          modulationIndex: 3.2,
          oscillator: { type: 'sine' },
          modulation: { type: 'sine' },
          envelope: env(0.025, 0.25, 0.85, 0.16),
          modulationEnvelope: env(0.05, 0.3, 0.65, 0.2),
        },
      },
      { kind: 'synth', level: -12, octave: -1, options: { oscillator: { type: 'triangle' }, envelope: env(0.03, 0.3, 0.6, 0.16) } },
    ],
    inserts: [
      { type: 'vibrato', frequency: 5.6, depth: 0.035 },
      { type: 'chorus', frequency: 0.4, delayTime: 2.8, depth: 0.2, wet: 0.15 },
    ],
  },
};

export const PATCH_IDS = Object.keys(PATCHES) as PatchId[];

/** Each style's palette: what plays a part until you choose something else. */
export const STYLE_SOUNDS: Record<StyleId, Record<TrackId, PatchId>> = {
  ukg: { melody: 'vox', counter: 'mallet', brass: 'horns', chords: 'stab', bass: 'sub' },
  house: { melody: 'lead', counter: 'marimba', brass: 'horns', chords: 'organ', bass: 'pluckBass' },
  deepHouse: { melody: 'velvet', counter: 'bell', brass: 'trumpet', chords: 'keys', bass: 'warmBass' },
  melodicHouse: { melody: 'pluck', counter: 'arp', brass: 'brass', chords: 'pad', bass: 'rolling' },
  rap: { melody: 'square', counter: 'mallet', brass: 'horns', chords: 'strings', bass: '808' },
};

/** The brass sounds each style draws from, weighted. */
const BRASS_SOUNDS: Record<StyleId, [PatchId, number][]> = {
  ukg: [['horns', 2], ['brass', 1.5], ['trumpet', 1]],
  house: [['horns', 2], ['brass', 2], ['trumpet', 1]],
  deepHouse: [['trumpet', 2], ['brass', 1.5], ['horns', 0.8]],
  melodicHouse: [['brass', 2.5], ['trumpet', 1], ['horns', 0.8]],
  rap: [['horns', 2.5], ['brass', 1], ['trumpet', 1]],
};

type SoundSettings = Pick<CompositionSettings, 'style' | 'trackSeeds'>;

/**
 * What a part plays until you choose: the style's sound. The brass picks one of the style's brass
 * sounds with its own seed, so a new loop or a reroll of the brass can bring a new one.
 */
export function autoPatch(settings: SoundSettings, track: TrackId): PatchId {
  if (track !== 'brass') return STYLE_SOUNDS[settings.style][track];
  const table = BRASS_SOUNDS[settings.style];
  const rng = createRng(deriveSeed(settings.trackSeeds.brass, 'sound'));
  return rng.weighted(table.map(([id]) => id), table.map(([, w]) => w));
}

/** Patches voiced for a part, in library order. */
export function patchesFor(track: TrackId): Patch[] {
  return PATCH_IDS.map((id) => PATCHES[id]).filter((p) => p.parts.includes(track));
}

/** What a part plays: the chosen patch, or the automatic one. */
export function resolvePatch(settings: SoundSettings, track: TrackId, chosen?: PatchId | null): PatchId {
  return chosen && PATCHES[chosen]?.parts.includes(track) ? chosen : autoPatch(settings, track);
}
