/**
 * Native Web Audio voices. Each sound builds its own small graph when it starts and lets it go
 * when it ends, so a silent instrument or drum costs the audio thread nothing. (Tone's synths keep
 * every voice's signals running whether or not they sound, which overloaded the audio thread.)
 *
 * Envelopes are drawn the way Tone draws them, so patches sound as they did: a linear attack,
 * then exponential decay and release, each finished with a short linear ramp.
 */

export interface Adsr {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

const LN_200 = Math.log(200);
/** The time constant Tone gives an exponential segment of this length. */
export const approach = (seconds: number) => Math.log(seconds + 1) / LN_200;

export const dbToGain = (db: number) => 10 ** (db / 20);

/** An envelope running on one param of a sound. */
export interface Env {
  param: AudioParam;
  adsr: Adsr;
  /** Level it started from, and its peak. */
  from: number;
  peak: number;
}

/** The envelope's level `t` seconds after its attack began, while held. */
function heldLevel({ adsr, from, peak }: Env, t: number): number {
  if (t < adsr.attack) return from + ((peak - from) * Math.max(0, t)) / adsr.attack;
  if (adsr.decay <= 0 || adsr.sustain >= 1) return peak;
  const target = peak * adsr.sustain;
  const d = t - adsr.attack;
  return d >= adsr.decay ? target : target + (peak - target) * Math.exp(-d / approach(adsr.decay));
}

function drawRelease(param: AudioParam, adsr: Adsr, off: number, level: number): void {
  const tc = approach(adsr.release);
  param.setValueAtTime(level, off);
  param.setTargetAtTime(0, off, tc);
  param.setValueAtTime(level * Math.exp((-0.9 * adsr.release) / tc), off + 0.9 * adsr.release);
  param.linearRampToValueAtTime(0, off + adsr.release);
}

/** Draws an envelope from `time`, released at `off`. */
export function drawEnvelope(env: Env, time: number, off: number): void {
  const { param, adsr, from, peak } = env;
  const held = off - time;
  param.setValueAtTime(from, time);
  if (held < adsr.attack) {
    param.linearRampToValueAtTime(heldLevel(env, held), off);
  } else {
    if (adsr.attack > 0) param.linearRampToValueAtTime(peak, time + adsr.attack);
    else param.setValueAtTime(peak, time);
    if (adsr.decay > 0 && adsr.sustain < 1) {
      const start = time + adsr.attack;
      const target = peak * adsr.sustain;
      param.setTargetAtTime(target, start, approach(adsr.decay));
      if (held >= adsr.attack + adsr.decay) {
        param.setValueAtTime(heldLevel(env, adsr.attack + 0.9 * adsr.decay), start + 0.9 * adsr.decay);
        param.linearRampToValueAtTime(target, start + adsr.decay);
      }
    }
  }
  drawRelease(param, adsr, off, heldLevel(env, held));
}

/** Clears what's scheduled from `time` on, holding the value it had reached. */
export function holdAt(param: AudioParam, time: number): void {
  if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(time);
  else param.cancelScheduledValues(time);
}

/** A short fade for sounds cut off by a new one or by stopping. */
const FADE = 0.008;

/** One note or hit in flight: its envelopes, and the nodes it starts, stops and lets go. */
export class Sound {
  readonly envs: Env[] = [];
  readonly sources: AudioScheduledSourceNode[] = [];
  readonly nodes: AudioNode[] = [];
  /** Where in its buffer each source starts (noise starts at a random point). */
  private readonly offsets: number[] = [];
  /** When it has gone silent. */
  end = 0;

  constructor(
    public time: number,
    /** When the release starts. */
    public off: number,
  ) {}

  node<N extends AudioNode>(n: N): N {
    this.nodes.push(n);
    return n;
  }

  source<N extends AudioScheduledSourceNode>(n: N, offset = 0): N {
    this.sources.push(n);
    this.offsets.push(offset);
    return this.node(n);
  }

  /** Adds an envelope on `param`. The first one is the amp, which decides when the sound is silent. */
  envelope(param: AudioParam, adsr: Adsr, peak: number): Env {
    param.value = 0;
    const env = { param, adsr, from: 0, peak };
    this.envs.push(env);
    return env;
  }

  get amp(): Env {
    return this.envs[0];
  }

  /** Draws the envelopes and starts the sources; the graph is let go once it ends. */
  start(): this {
    for (const env of this.envs) drawEnvelope(env, this.time, this.off);
    this.end = this.silentAt();
    this.sources.forEach((s, i) => (this.offsets[i] ? (s as AudioBufferSourceNode).start(this.time, this.offsets[i]) : s.start(this.time)));
    this.stopAt(this.end);
    this.sources[0].onended = () => {
      for (const n of this.nodes) n.disconnect();
    };
    return this;
  }

  /** The end of its release, or of its decay if it doesn't sustain. */
  silentAt(): number {
    const { attack, decay, sustain, release } = this.amp.adsr;
    const released = this.off + release;
    return sustain === 0 ? Math.min(released, this.time + attack + decay + 0.02) : released;
  }

  stopAt(at: number): void {
    for (const s of this.sources) s.stop(at + 0.01);
  }

  /** Its level on one envelope at `at`: held, or partway through the release. */
  levelAt(env: Env, at: number): number {
    if (at <= this.time) return env.from;
    if (at <= this.off) return heldLevel(env, at - this.time);
    return heldLevel(env, this.off - this.time) * Math.exp(-(at - this.off) / approach(env.adsr.release));
  }

  /** Fades out quickly from `at`: stolen, cut off by a new mono note, or stopped. */
  cut(at: number): void {
    if (this.end <= at) return;
    const amp = this.amp;
    if (at <= this.time) {
      // Not started yet: never let it sound.
      amp.param.cancelScheduledValues(0);
      amp.param.value = 0;
    } else {
      const level = this.levelAt(amp, at);
      holdAt(amp.param, at);
      amp.param.setValueAtTime(level, at);
      amp.param.linearRampToValueAtTime(0, at + FADE);
    }
    this.off = Math.min(this.off, at);
    this.end = at + FADE;
    this.stopAt(this.end);
  }

  /** Releases from `at` with its own release, as if its note ended there. */
  release(at: number): void {
    if (at >= this.off) return;
    if (at <= this.time) return this.cut(at);
    for (const env of this.envs) {
      const level = this.levelAt(env, at);
      holdAt(env.param, at);
      drawRelease(env.param, env.adsr, at, level);
    }
    this.off = at;
    this.end = this.silentAt();
    this.stopAt(this.end);
  }
}
