import type * as ToneNS from 'tone';
import type { StyleId } from '../core/types';
import { softClip } from './instruments';
import { Sound, dbToGain, type Adsr } from './voice';

type Tone = typeof ToneNS;

/** How a style's guide beat is tuned. Levels in dB; kick drive is the saturation curve's steepness. */
export interface KitSpec {
  kick: { pitch: number; sweep: number; pitchDecay: number; decay: number; drive: number; click: number };
  /** `snare` layers a tuned 808-style snare body under the clap, at that level. */
  clap: { tone: number; decay: number; room: number; level: number; snare?: number };
  hat: { decay: number; open: number; brightness: number; level: number };
  /** Sidechain: how far the music ducks on each kick (0–1) and how fast it recovers, in beats. */
  pump: { depth: number; recovery: number };
}

export const KITS: Record<StyleId, KitSpec> = {
  ukg: {
    kick: { pitch: 56, sweep: 5, pitchDecay: 0.035, decay: 0.3, drive: 2.2, click: -16 },
    clap: { tone: 1500, decay: 0.12, room: 0.25, level: -2 },
    hat: { decay: 0.03, open: 0.2, brightness: 8000, level: 1 },
    pump: { depth: 0.28, recovery: 0.14 },
  },
  house: {
    kick: { pitch: 52, sweep: 5.5, pitchDecay: 0.045, decay: 0.42, drive: 2, click: -18 },
    clap: { tone: 1300, decay: 0.16, room: 0.3, level: -2 },
    hat: { decay: 0.04, open: 0.24, brightness: 7500, level: 2 },
    pump: { depth: 0.35, recovery: 0.16 },
  },
  deepHouse: {
    kick: { pitch: 49, sweep: 4.5, pitchDecay: 0.05, decay: 0.5, drive: 1.4, click: -22 },
    clap: { tone: 1050, decay: 0.2, room: 0.4, level: -4 },
    hat: { decay: 0.05, open: 0.26, brightness: 6500, level: -1 },
    pump: { depth: 0.3, recovery: 0.18 },
  },
  melodicHouse: {
    kick: { pitch: 47, sweep: 5, pitchDecay: 0.05, decay: 0.55, drive: 1.7, click: -19 },
    clap: { tone: 1250, decay: 0.18, room: 0.35, level: -3 },
    hat: { decay: 0.028, open: 0.22, brightness: 8500, level: -1 },
    pump: { depth: 0.42, recovery: 0.17 },
  },
  // A short, hard kick that leaves the low end to the 808, a snare-and-clap backbeat and no pumping.
  rap: {
    kick: { pitch: 52, sweep: 6, pitchDecay: 0.03, decay: 0.22, drive: 2.6, click: -14 },
    clap: { tone: 1800, decay: 0.14, room: 0.18, level: -1, snare: -3 },
    hat: { decay: 0.025, open: 0.18, brightness: 9000, level: -2 },
    pump: { depth: 0, recovery: 0.1 },
  },
};

/** Clap flams: three short bursts a few milliseconds apart, then the tail. */
const FLAMS = [0, 0.008, 0.017];

/** Tone's noise, as stereo buffers made once per audio context: white, and pink by Paul Kellet's filter. */
const noiseCache = new WeakMap<BaseAudioContext, Record<'white' | 'pink', AudioBuffer>>();
function noiseBuffers(ctx: BaseAudioContext): Record<'white' | 'pink', AudioBuffer> {
  let buffers = noiseCache.get(ctx);
  if (!buffers) {
    const length = ctx.sampleRate * 2;
    const white = ctx.createBuffer(2, length, ctx.sampleRate);
    const pink = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const w = white.getChannelData(c);
      const p = pink.getChannelData(c);
      let [b0, b1, b2, b3, b4, b5, b6] = [0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < length; i++) {
        w[i] = Math.random() * 2 - 1;
        const x = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + x * 0.0555179;
        b1 = 0.99332 * b1 + x * 0.0750759;
        b2 = 0.969 * b2 + x * 0.153852;
        b3 = 0.8665 * b3 + x * 0.3104856;
        b4 = 0.55 * b4 + x * 0.5329522;
        b5 = -0.7616 * b5 - x * 0.016898;
        p[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362) * 0.11;
        b6 = x * 0.115926;
      }
    }
    buffers = { white, pink };
    noiseCache.set(ctx, buffers);
  }
  return buffers;
}

/** The partials of a cymbal-like metal tone, as ratios of its pitch (Tone's MetalSynth). */
const METAL_RATIOS = [1, 1.483, 1.932, 2.546, 2.63, 3.897];

const adsr = (attack: number, decay: number, sustain: number, release: number): Adsr => ({ attack, decay, sustain, release });

/**
 * The guide beat's drum machine. A kick built from a swept sine body, a
 * knock and a click; a clap from flammed noise bursts in a small room; and
 * hats that mix noise with a metallic FM tone. Each hit is its own short-lived
 * graph of native nodes (see voice.ts); the routing it plays into stays put.
 */
export class DrumKit {
  readonly output: ToneNS.Gain;
  private spec: KitSpec;
  private readonly ctx: BaseAudioContext;
  private readonly noise: Record<'white' | 'pink', AudioBuffer>;
  private readonly drive: ToneNS.WaveShaper;
  private readonly kickLevel: ToneNS.Gain;
  private readonly clapTone: ToneNS.Filter;
  private readonly clapLevel: ToneNS.Gain;
  private readonly snareLevel: ToneNS.Gain;
  private readonly roomSend: ToneNS.Gain;
  private readonly hatTone: ToneNS.Filter;
  private readonly hatLevel: ToneNS.Gain;
  /** Where each kind of hit plays into. */
  private readonly into: Record<'kick' | 'click' | 'clap' | 'snare' | 'hat', AudioNode>;
  /** Open hats still ringing, so a closed one can choke them. */
  private open: Sound[] = [];
  private lastOpen = -1;

  constructor(T: Tone, spec: KitSpec) {
    this.spec = spec;
    this.ctx = T.getContext().rawContext as unknown as BaseAudioContext;
    this.noise = noiseBuffers(this.ctx);
    this.output = new T.Gain(1);
    const entry = (to: ToneNS.ToneAudioNode) => new T.Gain(1).connect(to).input as unknown as AudioNode;

    // Saturation rounds the body's peaks, adding the harmonics that let a kick read on small speakers.
    this.kickLevel = new T.Gain(1).connect(this.output);
    const kickOut = new T.Filter({ frequency: 9000, type: 'lowpass' }).connect(this.kickLevel);
    this.drive = new T.WaveShaper(softClip(spec.kick.drive), 2048).connect(kickOut);

    const room = new T.Reverb({ decay: 0.9, preDelay: 0.004, wet: 1 }).connect(this.output);
    this.clapLevel = new T.Gain(1).connect(this.output);
    this.roomSend = new T.Gain(spec.clap.room).connect(room);
    this.clapLevel.connect(this.roomSend);
    this.clapTone = new T.Filter({ frequency: spec.clap.tone, type: 'bandpass', Q: 0.9 });
    this.clapTone.chain(new T.Filter({ frequency: 350, type: 'highpass' }), this.clapLevel);
    // The snare body skips the clap's band-pass, which would take out its low tone.
    this.snareLevel = new T.Gain(0).connect(this.clapLevel);

    this.hatLevel = new T.Gain(1).connect(new T.Panner(0.15).connect(this.output));
    this.hatTone = new T.Filter({ frequency: spec.hat.brightness, type: 'highpass', rolloff: -24 }).connect(this.hatLevel);

    this.into = {
      kick: entry(this.drive),
      click: entry(new T.Filter({ frequency: 3500, type: 'highpass' }).connect(kickOut)),
      clap: entry(this.clapTone),
      snare: entry(this.snareLevel),
      hat: entry(this.hatTone),
    };
    this.tune(spec);
  }

  /** Retunes the kit for a style without rebuilding it. */
  tune(spec: KitSpec): void {
    this.spec = spec;
    const { kick, clap, hat } = spec;
    this.drive.setMap(softClip(kick.drive), 2048);
    // Make up what the curve takes off the peaks, so every style's kick lands at the same level.
    this.kickLevel.gain.value = (0.57 * kick.drive) / Math.tanh(kick.drive);
    this.clapTone.frequency.value = clap.tone;
    this.clapLevel.gain.value = dbToGain(clap.level);
    this.roomSend.gain.value = clap.room;
    this.snareLevel.gain.value = clap.snare === undefined ? 0 : dbToGain(clap.snare);
    this.hatTone.frequency.value = hat.brightness;
    this.hatLevel.gain.value = dbToGain(hat.level);
  }

  get pump(): KitSpec['pump'] {
    return this.spec.pump;
  }

  /** A pitched drum (Tone's MembraneSynth): falls from `pitch × octaves` to `pitch` over `drop` seconds. */
  private membrane(to: AudioNode, type: OscillatorType, pitch: number, octaves: number, drop: number, env: Adsr, time: number, length: number, peak: number): Sound {
    const hit = new Sound(time, time + length);
    const amp = hit.node(this.ctx.createGain());
    amp.connect(to);
    hit.envelope(amp.gain, env, peak);
    const osc = hit.source(this.ctx.createOscillator());
    osc.type = type;
    osc.frequency.setValueAtTime(pitch * octaves, time);
    osc.frequency.exponentialRampToValueAtTime(pitch, time + drop);
    osc.connect(amp);
    return hit.start();
  }

  private noiseHit(to: AudioNode, color: 'white' | 'pink', env: Adsr, time: number, length: number, peak: number): Sound {
    const hit = new Sound(time, time + length);
    const amp = hit.node(this.ctx.createGain());
    amp.connect(to);
    hit.envelope(amp.gain, env, peak);
    const buffer = this.noise[color];
    const src = hit.source(this.ctx.createBufferSource(), Math.random() * (buffer.duration - 0.5));
    src.buffer = buffer;
    src.loop = true;
    src.connect(amp);
    return hit.start();
  }

  /** Tone's MetalSynth: six square FM pairs at inharmonic ratios, through a high-pass that falls as it decays. */
  private metal(env: Adsr, time: number, length: number, peak: number): Sound {
    const { ctx } = this;
    const hit = new Sound(time, time + length);
    const volume = hit.node(ctx.createGain());
    volume.gain.value = dbToGain(-16);
    volume.connect(this.into.hat);
    const amp = hit.node(ctx.createGain());
    amp.connect(volume);
    hit.envelope(amp.gain, env, peak);
    const highpass = hit.node(ctx.createBiquadFilter());
    highpass.type = 'highpass';
    highpass.Q.value = 0;
    highpass.frequency.value = 7000;
    highpass.connect(amp);
    const sweep = hit.source(ctx.createConstantSource());
    const range = hit.node(ctx.createGain());
    range.gain.value = 7000 * (2 ** 1.5 - 1);
    sweep.connect(range).connect(highpass.frequency);
    hit.envelope(sweep.offset, env, peak);
    for (const ratio of METAL_RATIOS) {
      const f = 320 * ratio;
      const carrier = hit.source(ctx.createOscillator());
      carrier.type = 'square';
      carrier.frequency.value = f;
      const mod = hit.source(ctx.createOscillator());
      mod.type = 'square';
      mod.frequency.value = f * 5.1;
      const depth = hit.node(ctx.createGain());
      depth.gain.value = f * 32;
      mod.connect(depth).connect(carrier.frequency);
      carrier.connect(highpass);
    }
    return hit.start();
  }

  kick(time: number, velocity: number): void {
    const { pitch, sweep, pitchDecay, decay, click } = this.spec.kick;
    this.membrane(this.into.kick, 'sine', pitch, sweep, pitchDecay, adsr(0.001, decay, 0, 0.05), time, decay + 0.05, velocity);
    this.membrane(this.into.kick, 'sine', pitch * 2.2, 6, 0.008, adsr(0.0005, 0.045, 0, 0.02), time, 0.06, velocity * dbToGain(-10));
    this.noiseHit(this.into.click, 'white', adsr(0.0005, 0.004, 0, 0.004), time, 0.004, velocity * dbToGain(click));
  }

  clap(time: number, velocity: number): void {
    const { decay, snare } = this.spec.clap;
    FLAMS.forEach((offset, i) =>
      this.noiseHit(this.into.clap, 'white', adsr(0.0005, 0.009, 0, 0.005), time + offset, 0.006, velocity * (0.75 + i * 0.12)),
    );
    this.noiseHit(this.into.clap, 'pink', adsr(0.001, decay, 0, 0.05), time + 0.024, decay, velocity);
    if (snare !== undefined) this.membrane(this.into.snare, 'triangle', 185, 1.8, 0.02, adsr(0.001, 0.14, 0, 0.05), time, 0.19, velocity);
  }

  hat(time: number, velocity: number): void {
    // A closed hat chokes a ringing open one, as on a real kit.
    if (time - this.lastOpen > 0.004) {
      for (const s of this.open) s.release(time);
      this.open = [];
    }
    this.hatPair(this.spec.hat.decay, time, velocity);
  }

  openHat(time: number, velocity: number): void {
    this.lastOpen = time;
    this.open = this.hatPair(this.spec.hat.open, time, velocity);
  }

  private hatPair(decay: number, time: number, velocity: number): Sound[] {
    return [
      this.noiseHit(this.into.hat, 'white', adsr(0.0005, decay, 0, 0.02), time, decay, velocity),
      this.metal(adsr(0.0005, decay * 1.1, 0, 0.02), time, decay, velocity),
    ];
  }
}
