import { formatSeed } from './random';
import { STYLES } from './styles';
import { pitchClassName, prefersFlats } from './theory';
import { BEATS_PER_BAR, PPQ, STEP, STEPS_PER_BEAT, type CompositionSettings } from './types';

export function ticksToSeconds(ticks: number, bpm: number): number {
  return (ticks / PPQ) * (60 / bpm);
}

/** "bar.beat.sixteenth", all 1-based, like a DAW's position readout. */
export function formatPosition(ticks: number): string {
  const step = Math.floor(Math.max(0, ticks) / STEP);
  const bar = Math.floor(step / (STEPS_PER_BEAT * BEATS_PER_BAR)) + 1;
  const beat = (Math.floor(step / STEPS_PER_BEAT) % BEATS_PER_BAR) + 1;
  const sixteenth = (step % STEPS_PER_BEAT) + 1;
  return `${bar}.${beat}.${sixteenth}`;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const NAMED_LENGTHS: Record<number, string> = { 1: '1/16', 2: '1/8', 3: '3/16', 4: '1/4', 6: '3/8', 8: '1/2', 12: '3/4', 16: '1 bar' };

/** Musical name for a length in ticks, e.g. 240 → "1/8". */
export function lengthLabel(ticks: number): string {
  const steps = Math.round(ticks / STEP);
  if (NAMED_LENGTHS[steps]) return NAMED_LENGTHS[steps];
  if (steps % 16 === 0) return `${steps / 16} bars`;
  return `${steps}/16`;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-') || 'idea'
  );
}

/** Title, style, key, tempo and seed, so an export leads back to the idea that made it. The seed is written as the seed field shows it. */
export function midiFileName(title: string, settings: CompositionSettings): string {
  const key = pitchClassName(settings.key, prefersFlats(settings.key, settings.scale)).replace('#', 's');
  const scale = settings.scale.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return `${slugify(title)}_${STYLES[settings.style].short.toLowerCase()}_${key}-${scale}_${Math.round(settings.bpm)}bpm_seed-${formatSeed(settings.seed)}.mid`;
}
