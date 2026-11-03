import type * as ToneNS from 'tone';
import {
  buildRoll,
  drumPlays,
  filterLevel,
  loopTickAt,
  sectionAt,
  songLength,
  songNotes,
  songSpans,
  type SongSpan,
} from '../core/arrangement';
import { ATTACK_S, BASELINE, CUTOFF_HZ, NATIVE, RELEASE_S, RESONANCE_Q, sampleLane } from '../core/automation';
import { beatHits, type DrumVoice } from '../core/beat';
import { resolveTransition } from '../core/transition';
import { swingTick, swungSpan } from '../core/groove';
import { PPQ, TRACK_IDS, totalTicks, type AutomationParam, type Composition, type StyleId, type TrackId } from '../core/types';
import { DrumKit, KITS } from './drums';
import { Instrument } from './instruments';
import { PATCHES, resolvePatch, type PatchId } from './patches';

type Tone = typeof ToneNS;

/** What the renderer needs from playback: where the music is, nothing more. */
export interface PlaybackClock {
  /** Position inside the loop, which is what the roll shows. */
  getTicks(): number;
  /** Position in the song while playing the arrangement; the same as `getTicks` in loop mode. */
  getSongTicks(): number;
  isRunning(): boolean;
  /** Whether a part plays at the current position (song sections can leave parts out). */
  isAudible(track: TrackId): boolean;
}

export type PlayMode = 'loop' | 'song';

interface NoteEvent {
  time: string;
  kind: 'note';
  track: TrackId;
  pitch: number;
  ticks: number;
  velocity: number;
}
interface DrumEvent {
  time: string;
  kind: 'drum';
  voice: DrumVoice;
  velocity: number;
  roll?: true;
  fill?: true;
}

interface SectionEvent {
  time: string;
  index: number;
}

interface AutomationEvent {
  time: string;
  track: TrackId;
  param: AutomationParam;
  /** Normalised value at this event, and at the next one. */
  from: number;
  to: number;
  /** Ramp length in ticks. */
  ticks: number;
}

/** The parts of each track's chain that automation can move. */
interface TrackFx {
  filter: ToneNS.Filter;
  delaySend: ToneNS.Gain;
  reverbSend: ToneNS.Gain;
}

interface Graph {
  transport: ReturnType<Tone['getTransport']>;
  /** What each part plays. Swapped in place when the style or a chosen sound changes. */
  instruments: Partial<Record<TrackId, Instrument>>;
  channels: Record<TrackId, ToneNS.Channel>;
  fx: Record<TrackId, TrackFx>;
  kit: DrumKit;
  drumBus: ToneNS.Channel;
  /** Everything but the drums runs through this gain, which ducks on each kick. */
  pump: ToneNS.Gain;
  delay: ToneNS.PingPongDelay;
  /** Whether the kick ducks the music (only while the guide beat is on). */
  pumping: { on: boolean };
  notes: ToneNS.Part<NoteEvent>;
  beat: ToneNS.Part<DrumEvent>;
  automation: ToneNS.Part<AutomationEvent>;
  /** Song mode only: build claps, and one event per section for its filter move. */
  fills: ToneNS.Part<DrumEvent>;
  sections: ToneNS.Part<SectionEvent>;
  /** The arrangement being played, or null in loop mode. Read by the parts' callbacks. */
  song: { spans: SongSpan[] | null; laneCutoff: Set<TrackId> };
  /** Sets every part's cutoff for a section, `into` ticks after it starts. */
  shapeFilters(time: number, span: SongSpan, into: number): void;
}

/** What Tone's Param and Signal share, for the calls automation makes. */
interface Ramp {
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  cancelAndHoldAtTime(time: number): unknown;
}

const PARAMS: AutomationParam[] = ['cutoff', 'resonance', 'attack', 'release', 'delay', 'reverb'];

/** The signal behind a continuous parameter, or null for envelope times. */
function signalFor(fx: TrackFx, param: AutomationParam): { param: Ramp; scale: (v: number) => number } | null {
  switch (param) {
    case 'cutoff':
      return { param: fx.filter.frequency, scale: CUTOFF_HZ.to };
    case 'resonance':
      return { param: fx.filter.Q, scale: RESONANCE_Q.to };
    case 'delay':
      return { param: fx.delaySend.gain, scale: (v) => v };
    case 'reverb':
      return { param: fx.reverbSend.gain, scale: (v) => v };
    default:
      return null;
  }
}

/** Voices each part may need at once. Chords hold long releases across changes. */
const POLYPHONY: Record<TrackId, number> = { melody: 8, counter: 8, brass: 12, chords: 16, bass: 4 };
/** Where each part sits in the stereo field. */
const PAN: Record<TrackId, number> = { melody: 0.08, counter: -0.22, brass: 0.2, chords: 0, bass: 0 };

function buildGraph(T: Tone, style: StyleId): Graph {
  const transport = T.getTransport();
  transport.PPQ = PPQ;

  const limiter = new T.Limiter(-1).toDestination();
  const makeup = new T.Gain(T.dbToGain(3)).connect(limiter);
  const rumble = new T.Filter({ frequency: 24, type: 'highpass' }).connect(makeup);
  const glue = new T.Compressor({ threshold: -16, ratio: 2.5, attack: 0.02, release: 0.25 }).connect(rumble);
  const pump = new T.Gain(1).connect(glue);

  // Returns are filtered so the reverb and echoes never cloud the low end or fizz on top.
  const reverb = new T.Reverb({ decay: 3.2, preDelay: 0.03, wet: 1 });
  reverb.chain(new T.Filter({ frequency: 320, type: 'highpass' }), new T.Filter({ frequency: 8000, type: 'lowpass' }), new T.Gain(0.32), pump);
  const delay = new T.PingPongDelay({ delayTime: '8n.', feedback: 0.32, wet: 1 });
  delay.chain(new T.Filter({ frequency: 450, type: 'highpass' }), new T.Filter({ frequency: 5000, type: 'lowpass' }), new T.Gain(0.18), pump);

  // instrument -> filter -> channel -> pump; each channel feeds both effect returns.
  const volumes: Record<TrackId, number> = { melody: -8, counter: -9, brass: -11, chords: -11, bass: -12 };
  const fx = {} as Record<TrackId, TrackFx>;
  const channels = {} as Record<TrackId, ToneNS.Channel>;
  for (const t of TRACK_IDS) {
    const base = NATIVE[t];
    const ch = new T.Channel({ volume: volumes[t], pan: PAN[t] }).connect(pump);
    const reverbSend = new T.Gain(base.reverb).connect(reverb);
    const delaySend = new T.Gain(base.delay).connect(delay);
    ch.fan(reverbSend, delaySend);
    const filter = new T.Filter({ frequency: base.cutoff, Q: base.resonance, type: 'lowpass', rolloff: -12 }).connect(ch);
    channels[t] = ch;
    fx[t] = { filter, delaySend, reverbSend };
  }
  const instruments: Graph['instruments'] = {};

  const drumBus = new T.Channel({ volume: -1 }).connect(glue);
  const kit = new DrumKit(T, KITS[style]);
  kit.output.chain(new T.Compressor({ threshold: -14, ratio: 3, attack: 0.004, release: 0.12 }), drumBus);
  const pumping = { on: true };
  // Sidechain: dip the music as the kick lands, then let it swell back before the next one.
  const duck = (time: number) => {
    const { depth, recovery } = kit.pump;
    if (!pumping.on || depth <= 0) return;
    const beat = 60 / transport.bpm.value;
    pump.gain.cancelAndHoldAtTime(time);
    // A 15 ms dip rather than an instant one, so the bass doesn't click.
    pump.gain.linearRampToValueAtTime(1 - depth, time + 0.015);
    pump.gain.setTargetAtTime(1, time + 0.02, beat * recovery);
  };
  const drums: Record<DrumVoice, (time: number, velocity: number) => void> = {
    kick: (time, v) => {
      kit.kick(time, v);
      duck(time);
    },
    clap: (time, v) => kit.clap(time, v),
    hat: (time, v) => kit.hat(time, v),
    openHat: (time, v) => kit.openHat(time, v),
  };

  // Skip an event that is already late after a main-thread stall (Tone would clamp it to now and
  // stack it on other late notes), or that fires twice as the loop wraps (Tone can repeat the
  // event at the boundary, a hair apart, and a voice can't restart at the same instant).
  const fired = new WeakMap<object, number>();
  const skip = (time: number, ev: object) => {
    const last = fired.get(ev);
    if (time < T.immediate() - 0.02 || (last !== undefined && Math.abs(time - last) < 0.001)) return true;
    fired.set(ev, time);
    return false;
  };

  // In song mode the loop parts repeat across the song, and each event checks its section.
  const song: Graph['song'] = { spans: null, laneCutoff: new Set() };
  const spanAt = (time: number) => (song.spans ? sectionAt(song.spans, transport.getTicksAtTime(time)) : undefined);

  const notes = new T.Part<NoteEvent>((time, ev) => {
    if (skip(time, ev)) return;
    const span = spanAt(time);
    if (span && !span.section.parts[ev.track]) return;
    instruments[ev.track]?.play(ev.pitch, T.Ticks(ev.ticks).toSeconds(), time, ev.velocity);
  }, []).start(0);
  const beat = new T.Part<DrumEvent>((time, ev) => {
    if (skip(time, ev)) return;
    const span = spanAt(time);
    if (span && !drumPlays(span.section.drums, ev)) return;
    drums[ev.voice](time, ev.velocity);
  }, []).start(0);
  const fills = new T.Part<DrumEvent>((time, ev) => !skip(time, ev) && drums[ev.voice](time, ev.velocity), []).start(0);

  const shapeFilters: Graph['shapeFilters'] = (time, span, into) => {
    const length = span.end - span.start;
    const remaining = T.Ticks(Math.max(1, length - into)).toSeconds();
    for (const t of TRACK_IDS) {
      const move = span.section.filter;
      // In an open section a cutoff lane, if there is one, takes the filter back.
      if (move === 'open' && song.laneCutoff.has(t)) continue;
      const base = BASELINE[t].cutoff;
      const frequency = fx[t].filter.frequency;
      frequency.cancelAndHoldAtTime(time);
      frequency.linearRampToValueAtTime(CUTOFF_HZ.to(filterLevel(move, base, into / length)), time + 0.03);
      if (move === 'rise') frequency.exponentialRampToValueAtTime(CUTOFF_HZ.to(filterLevel(move, base, 1)), time + remaining);
    }
  };
  const sections = new T.Part<SectionEvent>((time, ev) => {
    const span = song.spans?.[ev.index];
    if (span) shapeFilters(time, span, 0);
  }, []).start(0);

  const automation = new T.Part<AutomationEvent>((time, ev) => {
    if (ev.param === 'cutoff' && (spanAt(time)?.section.filter ?? 'open') !== 'open') return;
    const signal = signalFor(fx[ev.track], ev.param);
    if (signal) {
      signal.param.setValueAtTime(signal.scale(ev.from), time);
      signal.param.linearRampToValueAtTime(signal.scale(ev.to), time + T.Ticks(ev.ticks).toSeconds());
    } else if (ev.param === 'attack' || ev.param === 'release') {
      // Envelope times aren't signals; they apply from the next note on.
      shapeEnvelope(instruments[ev.track], ev.track, ev.param, (ev.param === 'attack' ? ATTACK_S : RELEASE_S).to(ev.from));
    }
  }, []).start(0);

  return {
    transport,
    instruments,
    channels,
    fx,
    kit,
    drumBus,
    pump,
    delay,
    pumping,
    notes,
    beat,
    automation,
    fills,
    sections,
    song,
    shapeFilters,
  };
}

/** Applies an automated envelope time as an offset (attack) or a ratio (release) from the part's baseline. */
function shapeEnvelope(instrument: Instrument | undefined, track: TrackId, key: 'attack' | 'release', seconds: number) {
  instrument?.shape(key, key === 'attack' ? seconds - NATIVE[track].attack : seconds / NATIVE[track].release);
}

/**
 * Plays a Composition through Tone.js. Tone is loaded on first use so the
 * AudioContext is only created after a user gesture.
 */
export class AudioEngine implements PlaybackClock {
  private T: Tone | null = null;
  private graph: Graph | null = null;
  private starting: Promise<Graph> | null = null;
  private composition: Composition | null = null;
  private muted: Record<TrackId, boolean> = { melody: false, counter: false, brass: false, chords: false, bass: false };
  private loop = true;
  private beatOn = true;
  private voices: Partial<Record<TrackId, PatchId>> = {};
  private playMode: PlayMode = 'loop';
  /** The arrangement's sections while in song mode. */
  private spans: SongSpan[] | null = null;
  private endEvent: number | null = null;
  private pendingTicks = 0;
  private liveLanes: string | null = null;
  onEnded: (() => void) | null = null;

  preload(): void {
    void import('tone');
  }

  private ensureGraph(): Promise<Graph> {
    if (!this.starting) {
      this.starting = (async () => {
        const T = await import('tone');
        // A little headroom over the interactive defaults keeps playback steady while the 3D view
        // renders. getTicks() takes the added latency back out so the visuals stay in sync.
        T.setContext(new T.Context({ latencyHint: 'balanced', lookAhead: 0.1 }), true);
        await T.start();
        const graph = buildGraph(T, this.composition?.settings.style ?? 'house');
        this.T = T;
        this.graph = graph;
        graph.transport.ticks = this.pendingTicks;
        this.applyComposition();
        this.applyMutes();
        return graph;
      })();
    }
    return this.starting;
  }

  setComposition(composition: Composition): void {
    this.composition = composition;
    this.applyComposition();
  }

  /** Loop plays the pattern; song plays the arrangement, section by section. */
  setPlayMode(mode: PlayMode): void {
    if (mode === this.playMode) return;
    const at = this.getSongTicks();
    this.playMode = mode;
    // Filters and lanes start over from the new mode's state.
    this.liveLanes = null;
    this.applyComposition();
    const loopTicks = this.composition ? totalTicks(this.composition.settings.bars) : 1;
    this.seek(mode === 'loop' ? at % loopTicks : at);
  }

  setMutes(muted: Record<TrackId, boolean>): void {
    this.muted = muted;
    this.applyMutes();
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
    this.applyComposition();
  }

  setBeat(on: boolean): void {
    this.beatOn = on;
    this.applyMutes();
  }

  /** Sounds chosen per part; a part left out plays its style's patch. */
  setVoices(voices: Partial<Record<TrackId, PatchId>>): void {
    this.voices = voices;
    this.applySounds();
  }

  private applyMutes(): void {
    if (!this.graph) return;
    for (const t of TRACK_IDS) this.graph.channels[t].mute = this.muted[t];
    this.graph.drumBus.mute = !this.beatOn;
    this.graph.pumping.on = this.beatOn;
  }

  /** Builds any part whose patch changed and retunes the kit for the style. Old instruments ring out, then go. */
  private applySounds(): void {
    const { graph, T, composition } = this;
    if (!graph || !T || !composition) return;
    const { settings } = composition;
    for (const t of TRACK_IDS) {
      const id = resolvePatch(settings, t, this.voices[t]);
      const old = graph.instruments[t];
      if (old?.patch.id === id) continue;
      const next = new Instrument(T, PATCHES[id], POLYPHONY[t]);
      next.output.connect(graph.fx[t].filter);
      graph.instruments[t] = next;
      if (old) {
        old.releaseAll(T.immediate());
        setTimeout(() => old.dispose(), 4000);
      }
    }
    graph.kit.tune(KITS[settings.style]);
  }

  private applyComposition(): void {
    const { composition } = this;
    this.spans = composition && this.playMode === 'song' ? songSpans(composition.arrangement) : null;
    const { graph } = this;
    if (!graph || !composition) return;
    const { settings } = composition;
    const loopEnd = totalTicks(settings.bars);
    const end = this.spans ? songLength(this.spans) : loopEnd;
    graph.song.spans = this.spans;
    graph.transport.bpm.value = settings.bpm;
    graph.delay.delayTime.value = (60 / settings.bpm) * 0.75;
    this.applySounds();

    // A song's sections each play their own version of the loop, so its notes are laid out once.
    graph.notes.clear();
    for (const n of this.spans ? songNotes(composition) : composition.notes) {
      const span = swungSpan(n.start, n.duration, settings.swing, n.nudge);
      graph.notes.add({
        time: `${Math.round(span.start)}i`,
        kind: 'note',
        track: n.track,
        pitch: n.pitch,
        ticks: Math.max(1, Math.round(span.end - span.start)),
        velocity: n.velocity / 127,
      });
    }

    graph.beat.clear();
    for (const hit of beatHits(settings, resolveTransition(settings))) {
      const { voice, velocity, roll, fill } = hit;
      graph.beat.add({ time: `${Math.round(swingTick(hit.tick, settings.swing))}i`, kind: 'drum', voice, velocity, roll, fill });
    }

    this.applyAutomation(graph, composition, loopEnd);

    // In song mode the beat and automation repeat under the whole arrangement; the rest is laid out once.
    graph.notes.loop = false;
    for (const part of [graph.beat, graph.automation]) {
      part.loop = !!this.spans;
      part.loopEnd = `${loopEnd}i`;
    }
    graph.fills.clear();
    graph.sections.clear();
    for (const span of this.spans ?? []) {
      graph.sections.add({ time: `${span.start}i`, index: span.index });
      if (span.section.drums !== 'build') continue;
      for (const hit of buildRoll(span.section.bars)) {
        const tick = Math.round(swingTick(span.start + hit.tick, settings.swing));
        graph.fills.add({ time: `${tick}i`, kind: 'drum', voice: hit.voice, velocity: hit.velocity });
      }
    }
    graph.song.laneCutoff = new Set(composition.automation.filter((l) => l.enabled && l.param === 'cutoff').map((l) => l.track));

    graph.transport.setLoopPoints(0, `${end}i`);
    graph.transport.loop = this.loop;
    if (graph.transport.ticks >= end) graph.transport.ticks = graph.transport.ticks % end;
    this.primeSection();
    this.armEnd();
  }

  /** Puts the filters where the current section wants them, for playback that starts or jumps mid-section. */
  private primeSection(): void {
    const { graph, T, spans } = this;
    if (!graph || !T || !spans) return;
    const ticks = graph.transport.ticks;
    const span = sectionAt(spans, ticks);
    if (span) graph.shapeFilters(T.immediate() + 0.01, span, ticks - span.start);
  }

  /** Schedules enabled lanes and returns everything else to the native sound. */
  private applyAutomation(graph: Graph, composition: Composition, end: number): void {
    const { swing } = composition.settings;
    const lanes = composition.automation.filter((l) => l.enabled);
    const live = new Set(lanes.map((l) => `${l.track}:${l.param}`));
    const liveKey = [...live].sort().join();
    // Note edits rebuild the composition constantly; only touch the others when the set of lanes changes.
    const resetOthers = liveKey !== this.liveLanes;
    this.liveLanes = liveKey;
    const now = this.T!.immediate();
    for (const t of resetOthers ? TRACK_IDS : []) {
      for (const param of PARAMS) {
        if (live.has(`${t}:${param}`)) continue;
        const signal = signalFor(graph.fx[t], param);
        if (signal) {
          signal.param.cancelAndHoldAtTime(now);
          signal.param.linearRampToValueAtTime(NATIVE[t][param], now + 0.06);
        } else if (param === 'attack' || param === 'release') {
          graph.instruments[t]?.shape(param, param === 'attack' ? 0 : 1);
        }
      }
    }

    graph.automation.clear();
    for (const lane of lanes) {
      const samples = sampleLane(lane.points, end);
      samples.forEach((s, i) => {
        const next = samples[i + 1] ?? { tick: end, value: s.value };
        const at = Math.round(swingTick(s.tick, swing));
        const until = Math.round(swingTick(next.tick, swing));
        graph.automation.add({
          time: `${at}i`,
          track: lane.track,
          param: lane.param,
          from: s.value,
          to: next.value,
          ticks: Math.max(1, until - at),
        });
      });
    }
  }

  /** Without looping, stop at the end of the pattern. */
  private armEnd(): void {
    const { graph, T, composition } = this;
    if (!graph || !T || !composition) return;
    if (this.endEvent !== null) graph.transport.clear(this.endEvent);
    this.endEvent = null;
    if (this.loop) return;
    const end = this.spans ? songLength(this.spans) : totalTicks(composition.settings.bars);
    this.endEvent = graph.transport.scheduleOnce((time) => {
      graph.transport.stop(time);
      this.endEvent = null;
      T.getDraw().schedule(() => this.onEnded?.(), time);
    }, `${end}i`);
  }

  async play(): Promise<void> {
    const graph = await this.ensureGraph();
    if (graph.transport.state === 'started') return;
    this.armEnd();
    this.primeSection();
    graph.transport.start('+0.02');
  }

  pause(): void {
    if (!this.graph) return;
    this.graph.transport.pause();
    this.releaseAll();
  }

  stop(): void {
    this.pendingTicks = 0;
    if (!this.graph) return;
    this.graph.transport.stop();
    this.graph.transport.ticks = 0;
    this.releaseAll();
    this.armEnd();
  }

  /** Moves playback, in song ticks while playing the arrangement. */
  seek(ticks: number): void {
    const t = Math.max(0, Math.round(ticks));
    this.pendingTicks = t;
    if (!this.graph) return;
    this.graph.transport.ticks = t;
    this.primeSection();
  }

  /** Sounds one note right away, for auditioning edits. */
  async audition(track: TrackId, pitch: number, velocity = 0.8, seconds = 0.28): Promise<void> {
    const graph = await this.ensureGraph();
    const T = this.T!;
    graph.instruments[track]?.play(pitch, seconds, T.immediate() + 0.005, velocity);
  }

  private releaseAll(): void {
    if (!this.graph || !this.T) return;
    const now = this.T.immediate();
    for (const t of TRACK_IDS) this.graph.instruments[t]?.releaseAll(now);
    this.graph.pump.gain.cancelScheduledValues(now);
    this.graph.pump.gain.setValueAtTime(1, now);
  }

  getTicks(): number {
    const ticks = this.getSongTicks();
    if (!this.spans || !this.composition) return ticks;
    return loopTickAt(this.spans, totalTicks(this.composition.settings.bars), ticks);
  }

  isAudible(track: TrackId): boolean {
    if (!this.spans) return true;
    return sectionAt(this.spans, this.getSongTicks())?.section.parts[track] ?? true;
  }

  getSongTicks(): number {
    if (!this.graph || !this.T) return this.pendingTicks;
    const { transport } = this.graph;
    if (transport.state !== 'started') return transport.ticks;
    const raw = this.T.getContext().rawContext as AudioContext;
    const latency = raw.outputLatency || raw.baseLatency || 0;
    return Math.max(0, transport.getTicksAtTime(Math.max(0, this.T.immediate() - latency)));
  }

  isRunning(): boolean {
    return this.graph?.transport.state === 'started';
  }
}
