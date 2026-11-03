import { createContext, useContext } from 'react';
import type { TrackId } from '../core/types';
import { useStudio } from '../state/useStudio';
import { SCENE_THEMES, type SceneTheme } from '../theme';

/**
 * What the scene needs from the outside world. Keeps rendering independent of
 * the audio engine: the scene only knows "where is playback" and "make a sound".
 */
export interface SceneBridge {
  clock: { getTicks(): number; isRunning(): boolean; isAudible?(track: TrackId): boolean };
  audition(track: TrackId, pitch: number, velocity: number): void;
}

const silent: SceneBridge = {
  clock: { getTicks: () => 0, isRunning: () => false },
  audition: () => {},
};

export const SceneBridgeContext = createContext<SceneBridge>(silent);

export function useSceneBridge(): SceneBridge {
  return useContext(SceneBridgeContext);
}

/** Hover preview of where a double-click would add a note. Mutated per frame, never rendered by React. */
export const ghost = { visible: false, x: 0, z: 0, width: 0.2 };

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function setCursor(cursor: string): void {
  document.body.style.cursor = cursor;
}

/** Colours and lighting for the current theme. */
export function useSceneTheme(): SceneTheme {
  return useStudio((s) => SCENE_THEMES[s.theme]);
}
