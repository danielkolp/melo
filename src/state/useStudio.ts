import { useStore } from 'zustand';
import type { Composition } from '../core/types';
import { loadPreferences, loadSession, persistPreferences, persistSession } from './persistence';
import { createStudioStore, type StudioState } from './store';

/** The app's single store instance, restored from the last session when possible. */
export const studio = createStudioStore({ ...loadSession(), ...loadPreferences() });
persistSession(studio);
persistPreferences(studio);

export function useStudio<T>(selector: (state: StudioState) => T): T {
  return useStore(studio, selector);
}

export function useComposition(): Composition {
  return useStudio((s) => s.history.present);
}
