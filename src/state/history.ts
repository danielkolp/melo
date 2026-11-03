/** Snapshot undo/redo. Compositions are small immutable values, so snapshots are cheap. */

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** Coalescing: consecutive commits with the same key inside the window merge into one step. */
  lastKey: string | null;
  lastAt: number;
}

export const HISTORY_LIMIT = 200;
export const COALESCE_WINDOW_MS = 900;

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], lastKey: null, lastAt: 0 };
}

export interface CommitOptions {
  /** Merge with the previous commit if it had the same key and was recent. */
  coalesceKey?: string;
  now?: number;
}

export function commit<T>(history: History<T>, next: T, options: CommitOptions = {}): History<T> {
  if (next === history.present) return history;
  const now = options.now ?? Date.now();
  const key = options.coalesceKey ?? null;
  if (key !== null && key === history.lastKey && now - history.lastAt < COALESCE_WINDOW_MS) {
    return { ...history, present: next, future: [], lastAt: now };
  }
  const past = [...history.past, history.present].slice(-HISTORY_LIMIT);
  return { past, present: next, future: [], lastKey: key, lastAt: now };
}

/** Replace the present without recording a step (used mid-gesture). */
export function replacePresent<T>(history: History<T>, next: T): History<T> {
  return next === history.present ? history : { ...history, present: next };
}

/** Record a finished gesture: `base` is what the present was when it started. */
export function commitGesture<T>(history: History<T>, base: T): History<T> {
  if (base === history.present) return history;
  return {
    past: [...history.past, base].slice(-HISTORY_LIMIT),
    present: history.present,
    future: [],
    lastKey: null,
    lastAt: 0,
  };
}

export function undo<T>(history: History<T>): History<T> {
  if (!history.past.length) return history;
  return {
    past: history.past.slice(0, -1),
    present: history.past[history.past.length - 1],
    future: [history.present, ...history.future],
    lastKey: null,
    lastAt: 0,
  };
}

export function redo<T>(history: History<T>): History<T> {
  if (!history.future.length) return history;
  return {
    past: [...history.past, history.present],
    present: history.future[0],
    future: history.future.slice(1),
    lastKey: null,
    lastAt: 0,
  };
}
