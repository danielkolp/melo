import { PATCHES, type PatchId } from '../audio/patches';
import { readComposition } from '../core/validate';
import { TRACK_IDS, type Composition, type TrackId } from '../core/types';
import type { Theme } from '../theme';
import type { PlayMode, SidebarTab, StudioInit, StudioStore } from './store';

const KEY = 'melo-lab/session/v1';
/** A viewer preference that outlives sessions. */
export const THEME_KEY = 'melo-lab/theme';
/** Panel layout, remembered for this tab only. */
const UI_KEY = 'melo-lab/ui';
const TABS: SidebarTab[] = ['tracks', 'composition', 'sound'];

interface SavedSession {
  composition: Composition;
  title: string;
  muted: Record<TrackId, boolean>;
  loop: boolean;
  beat: boolean;
  voices?: Partial<Record<TrackId, PatchId>>;
  playMode?: PlayMode;
}

function storage(kind: 'local' | 'session' = 'local'): Storage | null {
  try {
    if (kind === 'session') return typeof sessionStorage === 'undefined' ? null : sessionStorage;
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function read<T>(kind: 'local' | 'session', key: string): T | null {
  try {
    const raw = storage(kind)?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(kind: 'local' | 'session', key: string, value: unknown): void {
  try {
    storage(kind)?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the preference simply isn't remembered.
  }
}

/** Theme and panel layout from earlier visits. Light unless the viewer chose dark. */
export function loadPreferences(): Pick<StudioInit, 'theme' | 'sidebarOpen' | 'sidebarTab'> {
  const theme = read<Theme>('local', THEME_KEY);
  const ui = read<{ open?: unknown; tab?: unknown }>('session', UI_KEY);
  return {
    theme: theme === 'dark' ? 'dark' : 'light',
    sidebarOpen: typeof ui?.open === 'boolean' ? ui.open : undefined,
    sidebarTab: TABS.includes(ui?.tab as SidebarTab) ? (ui!.tab as SidebarTab) : undefined,
  };
}

/** Keeps preferences saved and the document's theme attribute in step. */
export function persistPreferences(store: StudioStore): () => void {
  const apply = (theme: Theme) => {
    if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme;
  };
  apply(store.getState().theme);
  return store.subscribe((s, prev) => {
    if (s.theme !== prev.theme) {
      apply(s.theme);
      write('local', THEME_KEY, s.theme);
    }
    if (s.sidebarOpen !== prev.sidebarOpen || s.sidebarTab !== prev.sidebarTab) {
      write('session', UI_KEY, { open: s.sidebarOpen, tab: s.sidebarTab });
    }
  });
}

/** The last session's idea, or null if there is none or it no longer parses. */
export function loadSession(): StudioInit | null {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<SavedSession>;
    const composition = readComposition(data.composition);
    if (!composition) return null;
    const muted = Object.fromEntries(TRACK_IDS.map((t) => [t, data.muted?.[t] === true])) as Record<TrackId, boolean>;
    const voices: Partial<Record<TrackId, PatchId>> = {};
    for (const t of TRACK_IDS) {
      const id = data.voices?.[t];
      if (typeof id === 'string' && PATCHES[id as PatchId]?.parts.includes(t)) voices[t] = id as PatchId;
    }
    return {
      composition,
      title: typeof data.title === 'string' ? data.title : undefined,
      muted,
      loop: typeof data.loop === 'boolean' ? data.loop : undefined,
      beat: typeof data.beat === 'boolean' ? data.beat : undefined,
      voices,
      playMode: data.playMode === 'song' ? 'song' : undefined,
    };
  } catch {
    return null;
  }
}

/** Saves the current idea shortly after each change. Returns an unsubscribe function. */
export function persistSession(store: StudioStore): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    const s = store.getState();
    const session: SavedSession = {
      composition: s.history.present,
      title: s.title,
      muted: s.muted,
      loop: s.loop,
      beat: s.beat,
      voices: s.voices,
      playMode: s.playMode,
    };
    try {
      storage()?.setItem(KEY, JSON.stringify(session));
    } catch {
      // Storage full or blocked: the session simply isn't remembered.
    }
  };
  const unsubscribe = store.subscribe((s, prev) => {
    if (s.history.present === prev.history.present && s.title === prev.title && s.muted === prev.muted && s.loop === prev.loop && s.beat === prev.beat && s.voices === prev.voices && s.playMode === prev.playMode) return;
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  });
  timer = setTimeout(save, 400);
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
