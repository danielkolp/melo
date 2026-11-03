import { useEffect } from 'react';
import type { TrackId } from '../core/types';
import { studio } from '../state/useStudio';
import { AudioEngine, type PlaybackClock } from './engine';

/** The one audio engine. UI calls the functions below rather than the engine directly. */
const engine = new AudioEngine();
engine.onEnded = () => studio.getState().setPlaying(false);

export const clock: PlaybackClock = engine;

export async function togglePlayback(): Promise<void> {
  const { isPlaying, setPlaying } = studio.getState();
  if (isPlaying) {
    engine.pause();
    setPlaying(false);
    return;
  }
  setPlaying(true);
  try {
    await engine.play();
  } catch (error) {
    setPlaying(false);
    studio.getState().notify('Audio could not start. Check that this tab is allowed to play sound.');
    console.error(error);
  }
}

export function stopPlayback(): void {
  engine.stop();
  studio.getState().setPlaying(false);
}

export function seek(ticks: number): void {
  engine.seek(ticks);
}

export function audition(track: TrackId, pitch: number, velocity = 0.8): void {
  if (studio.getState().isPlaying) return;
  engine.audition(track, pitch, velocity).catch(() => {});
}

/** Plays a short taste of a part's sound: its first chord or note. */
export function previewSound(track: TrackId): void {
  const s = studio.getState();
  if (s.isPlaying) return;
  const notes = s.history.present.notes.filter((n) => n.track === track);
  const first = Math.min(...notes.map((n) => n.start));
  for (const n of notes.filter((n) => n.start === first)) engine.audition(track, n.pitch, n.velocity / 127, 0.6).catch(() => {});
}

/** Keeps the engine in step with the store. Mount once. */
export function useAudioSync(): void {
  useEffect(() => {
    const push = () => {
      const s = studio.getState();
      engine.setComposition(s.history.present);
      engine.setMutes(s.muted);
      engine.setLoop(s.loop);
      engine.setBeat(s.beat);
      engine.setVoices(s.voices);
      engine.setPlayMode(s.playMode);
    };
    push();
    const idle = window.setTimeout(() => engine.preload(), 1200);
    const unsubscribe = studio.subscribe((s, prev) => {
      if (s.history.present !== prev.history.present) engine.setComposition(s.history.present);
      if (s.muted !== prev.muted) engine.setMutes(s.muted);
      if (s.loop !== prev.loop) engine.setLoop(s.loop);
      if (s.beat !== prev.beat) engine.setBeat(s.beat);
      if (s.voices !== prev.voices) engine.setVoices(s.voices);
      if (s.playMode !== prev.playMode) engine.setPlayMode(s.playMode);
    });
    return () => {
      window.clearTimeout(idle);
      unsubscribe();
    };
  }, []);
}
