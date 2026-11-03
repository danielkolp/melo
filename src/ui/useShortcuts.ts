import { useEffect } from 'react';
import { stopPlayback, togglePlayback } from '../audio/playback';
import { findNote } from '../core/edit';
import { PPQ, STEP, TRACK_IDS } from '../core/types';
import { studio } from '../state/useStudio';

export const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'],
  ['Enter', 'Stop and return to start'],
  ['G', 'Generate a new idea'],
  ['1 – 4', 'Choose the part to draw into'],
  ['Double-click', 'Add a note on the grid'],
  ['Drag note', 'Move it · drag its right end to resize'],
  ['↑ ↓', 'Selected note up / down a semitone (Shift: octave)'],
  ['← →', 'Move selected note a sixteenth (Shift: a beat)'],
  ['Alt ← →', 'Shorten / lengthen selected note'],
  ['Delete', 'Delete selected note'],
  ['Esc', 'Deselect'],
  ['Ctrl Z / Ctrl Shift Z', 'Undo / redo'],
  ['L · B', 'Toggle loop · guide beat'],
  ['S', 'Song mode: play and arrange the full track'],
  ['V', 'Switch between Isometric and Top'],
  ['E', 'Explore: orbit the roll freely'],
  ['F', 'Reframe the view'],
  ['Scroll', 'Zoom towards the pointer'],
  ['\\', 'Show / hide the panel'],
];

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
}

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = studio.getState();
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'z') {
        if (isTyping(e.target)) return;
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        if (isTyping(e.target)) return;
        e.preventDefault();
        s.redo();
        return;
      }
      if (isTyping(e.target) || mod) return;
      // Let buttons and sliders handle their own keys.
      const focusedControl = e.target instanceof HTMLElement && e.target.closest('button, [role="slider"], input');

      const note = s.selectedId ? findNote(s.history.present, s.selectedId) : undefined;
      if (note && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const key = `nudge:${note.id}`;
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          const pitch = note.pitch + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
          s.updateNote(note.id, { pitch }, key);
        } else {
          const dir = e.key === 'ArrowRight' ? 1 : -1;
          if (e.altKey) s.updateNote(note.id, { duration: Math.max(STEP, note.duration + dir * STEP) }, key);
          else s.updateNote(note.id, { start: note.start + dir * (e.shiftKey ? PPQ : STEP) }, key);
        }
        return;
      }

      switch (e.key) {
        case ' ':
          if (focusedControl) return;
          e.preventDefault();
          void togglePlayback();
          break;
        case 'Enter':
          if (focusedControl) return;
          stopPlayback();
          break;
        case 'Delete':
        case 'Backspace':
          if (note) {
            e.preventDefault();
            s.deleteNote(note.id);
          }
          break;
        case 'Escape':
          s.select(null);
          break;
        case 'g':
        case 'G':
          s.generate();
          break;
        case 'l':
        case 'L':
          s.setLoop(!s.loop);
          break;
        case 'b':
        case 'B':
          s.setBeat(!s.beat);
          break;
        case 's':
        case 'S':
          s.setPlayMode(s.playMode === 'song' ? 'loop' : 'song');
          break;
        case 'v':
        case 'V':
          s.setView(s.view === 'top' ? 'iso' : 'top');
          break;
        case 'e':
        case 'E':
          s.setView(s.view === 'explore' ? 'iso' : 'explore');
          break;
        case '\\':
          s.setSidebarOpen(!s.sidebarOpen);
          break;
        case 'f':
        case 'F':
          s.resetCamera();
          break;
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
          s.setActiveTrack(TRACK_IDS[Number(e.key) - 1]);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
