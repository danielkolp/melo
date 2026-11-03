import type * as ToneNS from 'tone';
import type { Insert, Layer, Patch } from './patches';
import { Sound, dbToGain, drawEnvelope, holdAt, type Adsr } from './voice';

type Tone = typeof ToneNS;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * A tanh curve with unity gain for quiet signals: louder ones round off
 * gradually instead of squaring off, which is what Tone's Distortion does.
 */
export function softClip(drive: number): (x: number) => number {
  const k = Math.max(0.01, drive);
  return (x) => Math.tanh(k * x) / k;
}

interface InsertNodes {
  input: AudioNode;
  output: AudioNode;
  nodes: AudioNode[];
  lfo?: OscillatorNode;
}

/**
 * The patch inserts, as plain Web Audio nodes with Tone's parameter mappings. Tone's own
 * modulation effects cost the audio thread 10–25 times more than this.
 */
function createInsert(ctx: BaseAudioContext, insert: Insert): InsertNodes {
  const gain = (value: number) => {
    const g = ctx.createGain();
    g.gain.value = value;
    return g;
  };
  const lfo = (frequency: number) => {
    const o = ctx.createOscillator();
    o.frequency.value = frequency;
    o.start();
    return o;
  };
  switch (insert.type) {
    case 'chorus': {
      // Two delay lines swept in opposite directions, one per side, mixed with equal power.
      const input = gain(1);
      const output = gain(1);
      const dry = gain(Math.cos((insert.wet * Math.PI) / 2));
      const wet = gain(Math.sin((insert.wet * Math.PI) / 2));
      // A mono patch reaches both sides.
      input.channelCount = 2;
      input.channelCountMode = 'explicit';
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      const center = insert.delayTime / 1000;
      const swing = Math.min(center * insert.depth, center);
      const osc = lfo(insert.frequency);
      const sides = [swing, -swing].map((amount, i) => {
        const delay = ctx.createDelay(0.05);
        delay.delayTime.value = center;
        const depth = gain(amount);
        osc.connect(depth).connect(delay.delayTime);
        split.connect(delay, i).connect(merge, 0, i);
        return [delay, depth];
      });
      input.connect(dry).connect(output);
      input.connect(split);
      merge.connect(wet).connect(output);
      return { input, output, lfo: osc, nodes: [input, output, dry, wet, split, merge, ...sides.flat()] };
    }
    case 'drive': {
      // Saturation blended in parallel with the clean signal.
      const input = gain(1);
      const output = gain(1);
      const shaper = ctx.createWaveShaper();
      const clip = softClip(1 + insert.amount * 6);
      shaper.curve = Float32Array.from({ length: 2048 }, (_, i) => clip((i / 2047) * 2 - 1));
      input.connect(gain(1 - insert.wet)).connect(output);
      input.connect(shaper).connect(gain(insert.wet)).connect(output);
      return { input, output, nodes: [input, output, shaper] };
    }
    case 'autopan': {
      // Panned as mono, like Tone's Panner.
      const panner = ctx.createStereoPanner();
      panner.channelCount = 1;
      panner.channelCountMode = 'explicit';
      const osc = lfo(insert.frequency);
      osc.connect(gain(insert.depth)).connect(panner.pan);
      return { input: panner, output: panner, lfo: osc, nodes: [panner] };
    }
    case 'vibrato': {
      // A delay swinging around 2.5 ms, as Tone's Vibrato does.
      const delay = ctx.createDelay(0.01);
      delay.delayTime.value = 0.0025;
      const osc = lfo(insert.frequency);
      osc.connect(gain(0.0025 * insert.depth)).connect(delay.delayTime);
      return { input: delay, output: delay, lfo: osc, nodes: [delay] };
    }
    case 'highpass': {
      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = insert.frequency;
      return { input: filter, output: filter, nodes: [filter] };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Oscillators. Tone's basic waves at phase 0 are the browser's own; anything else is a
// PeriodicWave built from the same coefficients Tone uses.

type Basic = 'sine' | 'square' | 'sawtooth' | 'triangle';

interface OscSpec {
  type?: string;
  count?: number;
  spread?: number;
  width?: number;
  partials?: number[];
}

function basicPartial(type: Basic, n: number): number {
  const pi = 2 / (n * Math.PI);
  switch (type) {
    case 'sine':
      return n === 1 ? 1 : 0;
    case 'square':
      return n & 1 ? 2 * pi : 0;
    case 'sawtooth':
      return pi * (n & 1 ? 1 : -1);
    case 'triangle':
      return n & 1 ? 2 * pi * pi * (((n - 1) >> 1) & 1 ? -1 : 1) : 0;
  }
}

class Waves {
  private cache = new Map<string, PeriodicWave>();
  constructor(private readonly ctx: BaseAudioContext) {}

  private make(key: string, build: () => [Float32Array, Float32Array], normalize = true): PeriodicWave {
    let wave = this.cache.get(key);
    if (!wave) {
      const [real, imag] = build();
      wave = this.ctx.createPeriodicWave(real, imag, { disableNormalization: !normalize });
      this.cache.set(key, wave);
    }
    return wave;
  }

  /** Sets an oscillator's wave: a basic shape (at a phase, in radians), a pulse or custom partials. */
  apply(osc: OscillatorNode, spec: OscSpec, base: string, phase = 0): void {
    if (base === 'custom') {
      const partials = spec.partials ?? [1];
      osc.setPeriodicWave(
        this.make(`custom:${partials.join(',')}`, () => {
          const imag = new Float32Array(partials.length + 1);
          partials.forEach((b, i) => (imag[i + 1] = b));
          return [new Float32Array(partials.length + 1), imag];
        }),
      );
    } else if (base === 'pulse') {
      // Tone's pulse is high wherever a triangle is above -width, swinging ±1.
      const duty = (1 + (spec.width ?? 0.2)) / 2;
      osc.setPeriodicWave(
        this.make(
          `pulse:${duty}`,
          () => {
            const size = 1024;
            const real = new Float32Array(size);
            const imag = new Float32Array(size);
            for (let n = 1; n < size; n++) {
              real[n] = (2 * Math.sin(2 * Math.PI * n * duty)) / (Math.PI * n);
              imag[n] = (2 * (1 - Math.cos(2 * Math.PI * n * duty))) / (Math.PI * n);
            }
            return [real, imag];
          },
          false,
        ),
      );
    } else if (phase === 0) {
      osc.type = base as Basic;
    } else {
      osc.setPeriodicWave(
        this.make(`${base}:${phase.toFixed(4)}`, () => {
          const size = 2048;
          const real = new Float32Array(size);
          const imag = new Float32Array(size);
          for (let n = 1; n < size; n++) {
            const b = basicPartial(base as Basic, n);
            real[n] = -b * Math.sin(phase * n);
            imag[n] = b * Math.cos(phase * n);
          }
          return [real, imag];
        }),
      );
    }
  }
}

interface FilterSpec {
  type?: BiquadFilterType;
  Q?: number;
  rolloff?: number;
}

interface FilterEnvSpec extends Adsr {
  baseFrequency: number;
  octaves: number;
  exponent?: number;
}

/** A note on a monophonic layer also carries the pitch its oscillators follow. */
interface Voice extends Sound {
  pitch?: AudioParam;
  frequency?: number;
}

interface LiveLayer {
  spec: Layer;
  /** Gain for the layer's level, into the patch mix. */
  out: GainNode;
  /** Envelope times after automation has moved them. */
  adsr: Adsr;
  base: Adsr;
  voices: Voice[];
}

const ENVELOPE_DEFAULTS: Record<Layer['kind'], Adsr> = {
  synth: { attack: 0.005, decay: 0.1, sustain: 0.3, release: 1 },
  mono: { attack: 0.005, decay: 0.1, sustain: 0.9, release: 1 },
  fm: { attack: 0.01, decay: 0.01, sustain: 1, release: 0.5 },
};

/** A patch made playable: its layers, mixed through its inserts into one output. */
export class Instrument {
  readonly output: ToneNS.Gain;
  private readonly ctx: BaseAudioContext;
  private readonly waves: Waves;
  private readonly layers: LiveLayer[];
  private readonly inserts: InsertNodes[] = [];
  private shaped = { attack: 0, release: 1 };
  /** x^2 over 0..1, for filter envelopes (Tone curves them with an exponent of 2). */
  private readonly curves = new Map<number, Float32Array<ArrayBuffer>>();

  constructor(
    T: Tone,
    readonly patch: Patch,
    private readonly polyphony: number,
  ) {
    this.ctx = T.getContext().rawContext as unknown as BaseAudioContext;
    this.waves = new Waves(this.ctx);
    this.output = new T.Gain(T.dbToGain(patch.level));
    const mix = this.ctx.createGain();
    let tail: AudioNode = mix;
    for (const spec of patch.inserts) {
      const insert = createInsert(this.ctx, spec);
      tail.connect(insert.input);
      tail = insert.output;
      this.inserts.push(insert);
    }
    tail.connect(this.output.input as unknown as AudioNode);

    this.layers = patch.layers.map((spec) => {
      const out = this.ctx.createGain();
      out.gain.value = dbToGain(spec.level);
      out.connect(mix);
      const base = { ...ENVELOPE_DEFAULTS[spec.kind], ...((spec.options.envelope ?? {}) as Partial<Adsr>) };
      return { spec, out, base, adsr: { ...base }, voices: [] };
    });
  }

  play(midi: number, seconds: number, time: number, velocity: number): void {
    const now = this.ctx.currentTime;
    for (const layer of this.layers) {
      const { spec } = layer;
      const frequency = 440 * 2 ** ((midi + 12 * (spec.octave ?? 0) - 69) / 12);
      const duration = spec.hold ? Math.min(seconds, spec.hold) : seconds;
      const level = 1 - (spec.velocity ?? 0.75) + (spec.velocity ?? 0.75) * velocity;
      layer.voices = layer.voices.filter((v) => v.end > now);

      if (spec.glide !== undefined) {
        const last = layer.voices[layer.voices.length - 1];
        // Legato: the last note is held right up to (or past) this one, so it slides there.
        if (last?.pitch && spec.glide && time <= last.off + 0.005 && time > last.time) {
          this.slide(layer, last, frequency, time, time + duration, level);
          continue;
        }
        for (const v of layer.voices) v.cut(time);
      } else {
        const sounding = layer.voices.filter((v) => v.end > time);
        if (sounding.length >= this.polyphony) sounding.reduce((a, b) => (a.off <= b.off ? a : b)).cut(time);
      }
      layer.voices.push(this.voice(layer, frequency, time, time + duration, level));
    }
  }

  /** Builds and starts one note on a layer. */
  private voice(layer: LiveLayer, frequency: number, time: number, off: number, level: number): Voice {
    const { ctx } = this;
    const { spec, adsr } = layer;
    const options = spec.options as {
      oscillator?: OscSpec;
      modulation?: OscSpec;
      filter?: FilterSpec;
      filterEnvelope?: FilterEnvSpec;
      modulationEnvelope?: Partial<Adsr>;
      harmonicity?: number;
      modulationIndex?: number;
    };
    const voice: Voice = new Sound(time, off);

    const amp = voice.node(ctx.createGain());
    amp.connect(layer.out);
    const fm = spec.kind === 'fm';
    // FMSynth's carrier and modulator both sit 10 dB down.
    voice.envelope(amp.gain, adsr, fm ? level * dbToGain(-10) : level);

    // What the oscillators feed: the amp, or a filter in front of it.
    let into: AudioNode = amp;
    if (spec.kind === 'mono') {
      const filter = { type: 'lowpass' as BiquadFilterType, Q: 1, rolloff: -12, ...options.filter };
      const fe = { attack: 0.6, decay: 0.2, sustain: 0.5, release: 2, baseFrequency: 200, octaves: 3, exponent: 2, ...options.filterEnvelope };
      const stages = Array.from({ length: Math.max(1, Math.round(-filter.rolloff / 12)) }, () => {
        const f = voice.node(ctx.createBiquadFilter());
        f.type = filter.type;
        f.Q.value = filter.Q;
        f.frequency.value = fe.baseFrequency;
        return f;
      });
      for (let i = 1; i < stages.length; i++) stages[i - 1].connect(stages[i]);
      stages[stages.length - 1].connect(amp);
      into = stages[0];
      // The filter sweeps from its base up `octaves`, along the envelope raised to `exponent`.
      const sweep = voice.source(ctx.createConstantSource());
      const shape = voice.node(ctx.createWaveShaper());
      shape.curve = this.curve(fe.exponent);
      const range = voice.node(ctx.createGain());
      range.gain.value = fe.baseFrequency * (2 ** fe.octaves - 1);
      sweep.connect(shape).connect(range);
      for (const f of stages) range.connect(f.frequency);
      voice.envelope(sweep.offset, fe, 1);
    }

    // Monophonic layers steer every oscillator from one pitch source, so it can slide.
    let steer: ConstantSourceNode | null = null;
    if (spec.glide !== undefined) {
      steer = voice.source(ctx.createConstantSource());
      steer.offset.value = frequency;
      if (spec.punch) {
        steer.offset.setValueAtTime(frequency * 2 ** (spec.punch.semitones / 12), time);
        steer.offset.exponentialRampToValueAtTime(frequency, time + spec.punch.time);
      }
      voice.pitch = steer.offset;
      voice.frequency = frequency;
    }

    const osc = options.oscillator ?? {};
    const type = osc.type ?? 'sine';
    const fat = type.startsWith('fat');
    const count = fat ? Math.max(1, osc.count ?? 3) : 1;
    const spread = osc.spread ?? 20;
    const carriers: OscillatorNode[] = [];
    // Tone starts a fat oscillator's copies at spread-out phases, each a little quieter.
    if (fat) {
      const quieter = voice.node(ctx.createGain());
      quieter.gain.value = dbToGain(-6 - count * 1.1);
      quieter.connect(into);
      into = quieter;
    }
    for (let i = 0; i < count; i++) {
      const o = voice.source(ctx.createOscillator());
      this.waves.apply(o, osc, fat ? type.slice(3) : type, fat ? (i / count) * 2 * Math.PI : 0);
      if (count > 1) o.detune.value = -spread / 2 + (spread / (count - 1)) * i;
      if (steer) {
        o.frequency.value = 0;
        steer.connect(o.frequency);
      } else o.frequency.value = frequency;
      o.connect(into);
      carriers.push(o);
    }

    if (fm) {
      // The modulator swings the carrier's frequency by up to frequency × index.
      const mod = voice.source(ctx.createOscillator());
      const modSpec = options.modulation ?? { type: 'square' };
      this.waves.apply(mod, modSpec, modSpec.type ?? 'square');
      mod.frequency.value = frequency * (options.harmonicity ?? 3);
      const depth = voice.node(ctx.createGain());
      mod.connect(depth);
      for (const c of carriers) depth.connect(c.frequency);
      voice.envelope(
        depth.gain,
        { attack: 0.5, decay: 0, sustain: 1, release: 0.5, ...options.modulationEnvelope },
        frequency * (options.modulationIndex ?? 10) * level * dbToGain(-10),
      );
    }
    return voice.start();
  }

  /** Carries a held mono voice into the next note: re-attacks from where it is and glides the pitch. */
  private slide(layer: LiveLayer, voice: Voice, frequency: number, time: number, off: number, level: number): void {
    for (const env of voice.envs) {
      env.from = voice.levelAt(env, time);
      holdAt(env.param, time);
    }
    voice.amp.peak = level;
    voice.amp.adsr = layer.adsr;
    voice.time = time;
    voice.off = off;
    for (const env of voice.envs) drawEnvelope(env, time, off);
    const pitch = voice.pitch!;
    holdAt(pitch, time);
    pitch.setValueAtTime(voice.frequency!, time);
    pitch.exponentialRampToValueAtTime(frequency, time + (layer.spec.glide ?? 0));
    voice.frequency = frequency;
    voice.end = voice.silentAt();
    voice.stopAt(voice.end);
  }

  private curve(exponent: number): Float32Array<ArrayBuffer> {
    let curve = this.curves.get(exponent);
    if (!curve) {
      curve = new Float32Array(1025);
      for (let i = 0; i < curve.length; i++) curve[i] = Math.max(0, (i / 512 - 1)) ** exponent;
      this.curves.set(exponent, curve);
    }
    return curve;
  }

  /**
   * Moves the amp envelopes, from the next note on. Attack is added to each
   * layer's own (so a pad stays slower than its pluck); release scales it.
   */
  shape(key: 'attack' | 'release', amount: number): void {
    const prev = this.shaped[key];
    const close = key === 'attack' ? Math.abs(prev - amount) <= 0.002 + Math.abs(prev) * 0.03 : Math.abs(amount / prev - 1) <= 0.03;
    if (close) return;
    this.shaped[key] = amount;
    for (const layer of this.layers) {
      layer.adsr = {
        ...layer.adsr,
        [key]: key === 'attack' ? clamp(layer.base.attack + amount, 0.001, 2) : clamp(layer.base.release * amount, 0.01, 5),
      };
    }
  }

  releaseAll(time: number): void {
    for (const layer of this.layers) for (const v of layer.voices) v.release(time);
  }

  dispose(): void {
    const now = this.ctx.currentTime;
    for (const layer of this.layers) for (const v of layer.voices) v.cut(now);
    // Let the cut voices fade before taking the chain down.
    setTimeout(() => {
      for (const layer of this.layers) layer.out.disconnect();
      for (const { lfo, nodes } of this.inserts) {
        lfo?.stop();
        for (const n of nodes) n.disconnect();
      }
      this.output.dispose();
    }, 50);
  }
}
