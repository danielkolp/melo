import { Keyboard, Moon, PanelRightClose, PanelRightOpen, Sun, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { openMidiFile } from '../lib/importMidi';
import { studio, useStudio } from '../state/useStudio';
import { IconButton, Kbd } from './controls';
import { SHORTCUTS } from './useShortcuts';

function Wordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <svg width="22" height="18" viewBox="0 0 22 18" aria-hidden>
        <rect x="0" y="12" width="9" height="5" rx="1.5" fill="var(--color-bass)" />
        <rect x="6" y="6" width="9" height="5" rx="1.5" fill="var(--color-counter)" />
        <rect x="12" y="0" width="10" height="5" rx="1.5" fill="var(--color-melody)" />
      </svg>
      <span className="text-[17px] font-semibold tracking-[-0.03em] text-fg">melo</span>
    </div>
  );
}

function ShortcutsButton() {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !panel.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <div ref={panel} className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-[12.5px] text-fg-dim transition-colors hover:bg-tint hover:text-fg"
      >
        <Keyboard size={15} strokeWidth={1.7} />
        <span className="hidden sm:inline">Shortcuts</span>
      </button>
      {open && (
        <div className="absolute top-full right-0 z-40 mt-2 w-[360px] max-w-[calc(100vw-32px)] rounded-xl bg-raised p-4 shadow-[0_12px_40px_rgba(0,0,0,0.16)] ring-1 ring-line">
          <h2 className="eyebrow mb-3">Keyboard</h2>
          <dl className="space-y-2">
            {SHORTCUTS.map(([keys, action]) => (
              <div key={keys} className="flex items-baseline justify-between gap-4">
                <dt className="shrink-0">
                  <Kbd>{keys}</Kbd>
                </dt>
                <dd className="text-right text-[12.5px] text-fg-dim">{action}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

/** Opens a file picker for a .mid file; the import dialog takes it from there. */
function ImportButton() {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        title="Import a MIDI file: keep your part and get variations of it"
        className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-[12.5px] text-fg-dim transition-colors hover:bg-tint hover:text-fg"
      >
        <Upload size={15} strokeWidth={1.7} />
        <span className="hidden sm:inline">Import MIDI</span>
      </button>
      <input
        ref={input}
        type="file"
        accept=".mid,.midi,audio/midi,audio/x-midi"
        className="hidden"
        aria-label="MIDI file to import"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void openMidiFile(file);
        }}
      />
    </>
  );
}

export function Header() {
  const theme = useStudio((s) => s.theme);
  const panelOpen = useStudio((s) => s.sidebarOpen);
  const dark = theme === 'dark';

  return (
    <header className="relative z-30 flex h-12 shrink-0 items-center justify-between border-b border-line bg-panel px-4 md:px-5">
      <Wordmark />
      <div className="flex items-center gap-1">
        <span className="readout mr-2 hidden text-[10px] text-fg-faint md:inline">Saved in this browser</span>
        <ImportButton />
        <ShortcutsButton />
        <IconButton
          size="sm"
          className="h-8 w-8"
          label={dark ? 'Light theme' : 'Dark theme'}
          aria-pressed={dark}
          onClick={() => studio.getState().setTheme(dark ? 'light' : 'dark')}
        >
          {dark ? <Sun size={15} strokeWidth={1.7} /> : <Moon size={15} strokeWidth={1.7} />}
        </IconButton>
        <IconButton
          size="sm"
          className="h-8 w-8"
          label={panelOpen ? 'Hide panel (\\)' : 'Show panel (\\)'}
          aria-pressed={panelOpen}
          onClick={() => studio.getState().setSidebarOpen(!panelOpen)}
        >
          {panelOpen ? <PanelRightClose size={16} strokeWidth={1.6} /> : <PanelRightOpen size={16} strokeWidth={1.6} />}
        </IconButton>
      </div>
    </header>
  );
}
