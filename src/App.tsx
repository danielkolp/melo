import { useEffect, useMemo, useState } from 'react';
import { audition, clock, useAudioSync } from './audio/playback';
import { RollScene } from './scene/RollScene';
import { SceneBridgeContext, type SceneBridge } from './scene/context';
import { openMidiFile } from './lib/importMidi';
import { Header } from './ui/Header';
import { ImportDialog } from './ui/ImportDialog';
import { Sidebar } from './ui/Sidebar';
import { SongStrip } from './ui/SongStrip';
import { StageOverlay } from './ui/StageOverlay';
import { Toasts } from './ui/Toasts';
import { TransportBar } from './ui/TransportBar';
import { useShortcuts } from './ui/useShortcuts';
import { useStudio } from './state/useStudio';

export function App() {
  useAudioSync();
  useShortcuts();
  const bridge = useMemo<SceneBridge>(() => ({ clock, audition }), []);
  const song = useStudio((s) => s.playMode === 'song');
  const dropping = useFileDrop();

  return (
    <div className="flex min-h-dvh flex-col bg-panel lg:h-dvh">
      <Header />
      <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 flex-col lg:min-w-0 lg:flex-1">
          <section className="stage relative h-[64vh] min-h-[400px] overflow-hidden lg:h-auto lg:min-h-0 lg:flex-1" aria-label="Piano roll">
            <SceneBridgeContext.Provider value={bridge}>
              <RollScene />
            </SceneBridgeContext.Provider>
            <StageOverlay />
          </section>
          {song && <SongStrip />}
        </div>
        <Sidebar />
      </main>
      <TransportBar />
      <Toasts />
      <ImportDialog />
      {dropping && (
        <div className="pointer-events-none fixed inset-3 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-fg-faint bg-[color-mix(in_oklab,var(--color-panel)_82%,transparent)]">
          <p className="text-[15px] text-fg">Drop a MIDI file to import it</p>
        </div>
      )}
    </div>
  );
}

/** A file dropped anywhere on the window opens in the import dialog. True while one is being dragged over. */
function useFileDrop(): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const allow = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      const file = e.dataTransfer?.files[0];
      if (file) void openMidiFile(file);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', allow);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', allow);
      window.removeEventListener('drop', drop);
    };
  }, []);
  return over;
}
