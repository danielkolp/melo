import { createStore } from 'zustand/vanilla';
import type { PatchId } from '../audio/patches';
import {
  cycleDrums,
  duplicateSection,
  insertSection,
  moveSection,
  nextTemplate,
  removeSection,
  toggleSectionPart,
  updateSection,
} from '../core/arrangement';
import { addNote, createNoteId, findNote, removeNote, updateNote, type NotePatch } from '../core/edit';
import { composeAround, loadHeld, loadTake } from '../core/importing';
import { newChords, recompose, rewriteBar, toggleBarLock, toggleLock } from '../core/locks';
import {
  createSettings,
  generateComposition,
  regenerateTrack,
  rerollAutomation,
  setLaneEnabled,
  trackSeedsFor,
} from '../core/generator';
import { deriveSeed, randomSeed } from '../core/random';
import { STYLES } from '../core/styles';
import {
  TRACK_IDS,
  type Composition,
  type CompositionSettings,
  type Arrangement,
  type ImportSource,
  type NoteEvent,
  type SectionKind,
  type SongSection,
  type StyleId,
  type TrackId,
} from '../core/types';
import type { Theme } from '../theme';
import { commit, commitGesture, createHistory, redo, replacePresent, undo, type History } from './history';

/** Isometric and Top are fixed, composed views; Explore hands the camera to the user. */
export type ViewMode = 'iso' | 'top' | 'explore';
export type SidebarTab = 'tracks' | 'composition' | 'sound';
/** Loop plays the pattern; Song plays the arrangement start to finish. */
export type PlayMode = 'loop' | 'song';
export type SectionPatch = Partial<Pick<SongSection, 'kind' | 'bars' | 'drums' | 'filter' | 'material'>>;

/** Settings that change the music itself; changing them regenerates from the current seeds. */
export type MusicalPatch = Partial<Pick<CompositionSettings, 'key' | 'scale' | 'bars' | 'density' | 'variation' | 'creativity' | 'phrase' | 'transition'>>;

/** A file waiting in the import dialog. */
export interface PendingImport {
  name: string;
  bytes: Uint8Array;
}

export interface Toast {
  id: number;
  message: string;
}

export interface StudioState {
  history: History<Composition>;
  title: string;
  selectedId: string | null;
  /** Part that double-clicking the grid draws into. */
  activeTrack: TrackId;
  muted: Record<TrackId, boolean>;
  isPlaying: boolean;
  loop: boolean;
  /** Playback-only drum guide in the style's groove. Not part of the composition. */
  beat: boolean;
  /** Sound chosen per part; a part left out plays its style's patch. Playback only, like the beat. */
  voices: Partial<Record<TrackId, PatchId>>;
  playMode: PlayMode;
  /** Section shown in the song timeline's inspector. */
  selectedSection: string | null;
  view: ViewMode;
  /** Bumped to ask the camera to return to its preset. */
  cameraNonce: number;
  theme: Theme;
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  dragging: boolean;
  gestureBase: Composition | null;
  toast: Toast | null;
  /** Automation lane drawn in the 3D view, or null for the first one. */
  focusedLane: string | null;
  /** The file shown in the import dialog, if it's open. */
  pendingImport: PendingImport | null;

  /** A new loop from a new seed. Locked parts and bars stay. */
  generate(seed?: number): void;
  regenerateTrack(track: TrackId, seed?: number): void;
  /** Locks a part against Generate and changes to the music, or unlocks it. */
  toggleLock(track: TrackId): void;
  /** Locks a bar's notes, in every part, or unlocks it. */
  toggleBarLock(bar: number): void;
  /** Writes one bar of one part again as a related alternative. */
  rewriteBar(track: TrackId, bar: number, seed?: number): void;
  /** A new progression under the loop. */
  newChords(seed?: number): void;
  changeMusic(patch: MusicalPatch, coalesceKey?: string): void;
  setStyle(style: StyleId): void;
  setTempo(bpm: number): void;
  setSwing(swing: number): void;
  toggleAutomation(id: string): void;
  rerollAutomation(seed?: number): void;
  focusLane(id: string | null): void;
  addNote(note: Omit<NoteEvent, 'id'>): string;
  updateNote(id: string, patch: NotePatch, coalesceKey?: string): void;
  /** Live update during a drag; recorded as one step by `endGesture`. */
  previewNote(id: string, patch: NotePatch): void;
  deleteNote(id: string): void;
  beginGesture(): void;
  endGesture(): void;
  undo(): void;
  redo(): void;
  select(id: string | null): void;
  setActiveTrack(track: TrackId): void;
  toggleMute(track: TrackId): void;
  setPlaying(playing: boolean): void;
  setLoop(loop: boolean): void;
  setBeat(beat: boolean): void;
  /** Picks a part's sound, or null to follow the style again. */
  setVoice(track: TrackId, patch: PatchId | null): void;
  setPlayMode(mode: PlayMode): void;
  selectSection(id: string | null): void;
  toggleSectionPart(id: string, track: TrackId): void;
  cycleSectionDrums(id: string): void;
  updateSection(id: string, patch: SectionPatch): void;
  moveSection(id: string, by: -1 | 1): void;
  duplicateSection(id: string): void;
  addSection(kind: SectionKind): void;
  removeSection(id: string): void;
  /** The style's next song structure. */
  suggestArrangement(): void;
  /** Holds uploaded parts in the loop and writes the rest around them. */
  importParts(source: ImportSource, settings: Partial<CompositionSettings>): void;
  /** Loads a take of an uploaded part: 0 the upload, 1–6 a variation card. */
  pickTake(track: TrackId, take: number): void;
  /** Deals new variation cards. */
  rerollTakes(seed?: number): void;
  setVariationAmount(amount: number): void;
  /** Lets go of the upload: the whole loop is generated again. */
  removeImport(): void;
  setView(view: ViewMode): void;
  resetCamera(): void;
  setTheme(theme: Theme): void;
  setSidebarOpen(open: boolean): void;
  setSidebarTab(tab: SidebarTab): void;
  setTitle(title: string): void;
  notify(message: string): void;
  /** Opens the import dialog on a file, or closes it. */
  setPendingImport(file: PendingImport | null): void;
}

export interface StudioInit {
  composition?: Composition;
  title?: string;
  muted?: Partial<Record<TrackId, boolean>>;
  loop?: boolean;
  beat?: boolean;
  voices?: Partial<Record<TrackId, PatchId>>;
  playMode?: PlayMode;
  theme?: Theme;
  sidebarOpen?: boolean;
  sidebarTab?: SidebarTab;
  /** Seed source; tests inject a deterministic one. */
  random?: () => number;
}

const NO_MUTES = Object.fromEntries(TRACK_IDS.map((t) => [t, false])) as Record<TrackId, boolean>;
export const MIN_BPM = 60;
export const MAX_BPM = 200;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function createStudioStore(init: StudioInit = {}) {
  const random = init.random ?? randomSeed;
  const initial = init.composition ?? generateComposition(createSettings({ seed: random() }));
  let toastId = 0;

  return createStore<StudioState>()((set, get) => {
    /** Commit a new composition and drop the selection if its note disappeared. */
    const apply = (next: Composition, coalesceKey?: string) => {
      const { history, selectedId } = get();
      const nextHistory = commit(history, next, { coalesceKey });
      set({
        history: nextHistory,
        selectedId: selectedId && findNote(nextHistory.present, selectedId) ? selectedId : null,
      });
    };
    const present = () => get().history.present;
    /** A new loop for `settings`, written around uploaded and locked parts and, with `keepEdited`, hand-edited ones. */
    const compose = (settings: CompositionSettings, keepEdited = false) => recompose(present(), settings, { keepEdited });
    /** Commits a change to the upload's variation settings; the loop keeps playing what it has. */
    const reshuffle = (patch: Partial<ImportSource>, coalesceKey?: string) => {
      const comp = present();
      if (!comp.source) return;
      // Cards are dealt again, so only the upload itself stays marked as picked.
      const picked = Object.fromEntries(Object.entries(comp.source.picked).filter(([, take]) => take === 0));
      apply({ ...comp, source: { ...comp.source, ...patch, picked } }, coalesceKey);
    };
    /** Commits an arrangement edit as its own undo step. */
    const arrange = (edit: (arrangement: Arrangement) => Arrangement) => {
      const comp = present();
      const next = edit(comp.arrangement);
      if (next !== comp.arrangement) apply({ ...comp, arrangement: next });
    };

    return {
      history: createHistory(initial),
      title: init.title ?? 'Untitled idea',
      selectedId: null,
      activeTrack: 'melody',
      muted: { ...NO_MUTES, ...init.muted },
      isPlaying: false,
      loop: init.loop ?? true,
      beat: init.beat ?? true,
      voices: init.voices ?? {},
      playMode: init.playMode ?? 'loop',
      selectedSection: null,
      view: 'iso',
      cameraNonce: 0,
      theme: init.theme ?? 'light',
      sidebarOpen: init.sidebarOpen ?? true,
      sidebarTab: init.sidebarTab ?? 'composition',
      dragging: false,
      gestureBase: null,
      toast: null,
      focusedLane: null,
      pendingImport: null,

      generate(seed = random()) {
        const comp = present();
        // A new seed brings new harmony too, unless something locked holds it.
        const { harmonySeed: _, ...current } = comp.settings;
        const settings = { ...current, seed, trackSeeds: trackSeedsFor(seed), automationSeed: deriveSeed(seed, 'automation') };
        apply(compose(settings));
      },

      regenerateTrack(track, seed = random()) {
        apply(regenerateTrack(present(), track, seed));
      },

      toggleLock(track) {
        apply(toggleLock(present(), track));
      },

      toggleBarLock(bar) {
        apply(toggleBarLock(present(), bar));
      },

      rewriteBar(track, bar, seed = random()) {
        const comp = present();
        const next = rewriteBar(comp, track, bar, seed);
        if (next !== comp) apply(next);
      },

      newChords(seed = random()) {
        const comp = present();
        const next = newChords(comp, seed);
        if (next !== comp) apply(next);
      },

      changeMusic(patch, coalesceKey) {
        const current = present().settings;
        const keys = (Object.keys(patch) as (keyof MusicalPatch)[]).filter((k) => patch[k] !== current[k]);
        if (!keys.length) return;
        // Moving key keeps hand edits, moved with it; anything else writes the unlocked parts again.
        apply(compose({ ...current, ...patch }, keys.every((k) => k === 'key' || k === 'scale')), coalesceKey);
      },

      setStyle(style) {
        const current = present().settings;
        if (current.style === style) return;
        const def = STYLES[style];
        apply(compose({ ...current, style, bpm: def.bpm, swing: def.swing }));
        set({ selectedSection: null });
      },

      setTempo(bpm) {
        const comp = present();
        const value = clamp(Math.round(bpm), MIN_BPM, MAX_BPM);
        if (value === comp.settings.bpm) return;
        apply({ ...comp, settings: { ...comp.settings, bpm: value } }, 'tempo');
      },

      setSwing(swing) {
        const comp = present();
        const value = clamp(Math.round(swing), 50, 75);
        if (value === comp.settings.swing) return;
        apply({ ...comp, settings: { ...comp.settings, swing: value } }, 'swing');
      },

      toggleAutomation(id) {
        const lane = present().automation.find((l) => l.id === id);
        if (lane) apply(setLaneEnabled(present(), id, !lane.enabled));
      },

      rerollAutomation(seed = random()) {
        apply(rerollAutomation(present(), seed));
        set({ focusedLane: null });
      },

      focusLane: (id) => set({ focusedLane: id }),

      addNote(note) {
        const id = createNoteId();
        apply(addNote(present(), { ...note, id }));
        set({ selectedId: id, activeTrack: note.track });
        return id;
      },

      updateNote(id, patch, coalesceKey) {
        apply(updateNote(present(), id, patch), coalesceKey);
      },

      previewNote(id, patch) {
        set({ history: replacePresent(get().history, updateNote(present(), id, patch)) });
      },

      deleteNote(id) {
        apply(removeNote(present(), id));
      },

      beginGesture() {
        set({ gestureBase: present(), dragging: true });
      },

      endGesture() {
        const { gestureBase, history } = get();
        set({ gestureBase: null, dragging: false, history: gestureBase ? commitGesture(history, gestureBase) : history });
      },

      undo() {
        const history = undo(get().history);
        const { selectedId } = get();
        set({ history, selectedId: selectedId && findNote(history.present, selectedId) ? selectedId : null });
      },

      redo() {
        const history = redo(get().history);
        const { selectedId } = get();
        set({ history, selectedId: selectedId && findNote(history.present, selectedId) ? selectedId : null });
      },

      select(id) {
        const note = id ? findNote(present(), id) : undefined;
        set(note ? { selectedId: note.id, activeTrack: note.track } : { selectedId: null });
      },

      setActiveTrack: (track) => set({ activeTrack: track }),
      toggleMute: (track) => set({ muted: { ...get().muted, [track]: !get().muted[track] } }),
      setPlaying: (isPlaying) => set({ isPlaying }),
      setLoop: (loop) => set({ loop }),
      setBeat: (beat) => set({ beat }),
      setPlayMode: (playMode) => set({ playMode }),
      selectSection: (selectedSection) => set({ selectedSection }),
      toggleSectionPart: (id, track) => arrange((a) => toggleSectionPart(a, id, track)),
      cycleSectionDrums: (id) => arrange((a) => cycleDrums(a, id)),
      updateSection: (id, patch) => arrange((a) => updateSection(a, id, patch)),
      moveSection: (id, by) => arrange((a) => moveSection(a, id, by)),
      duplicateSection(id) {
        arrange((a) => duplicateSection(a, id));
        const sections = present().arrangement.sections;
        const i = sections.findIndex((s) => s.id === id);
        if (i >= 0 && sections[i + 1]) set({ selectedSection: sections[i + 1].id });
      },
      addSection(kind) {
        const before = new Set(present().arrangement.sections.map((s) => s.id));
        arrange((a) => insertSection(a, kind, get().selectedSection, present().settings.bars));
        const added = present().arrangement.sections.find((s) => !before.has(s.id));
        if (added) set({ selectedSection: added.id });
      },
      removeSection(id) {
        arrange((a) => removeSection(a, id));
        if (get().selectedSection === id) set({ selectedSection: null });
      },
      suggestArrangement() {
        arrange((a) => nextTemplate(a, present().settings.bars));
        set({ selectedSection: null });
      },

      importParts(source, patch) {
        const comp = present();
        // The upload brings its own harmony.
        const { harmonySeed: _, ...current } = comp.settings;
        const settings = { ...current, ...patch };
        apply(composeAround(settings, source, loadHeld(source, settings), comp.automation, comp.arrangement));
        set({ sidebarTab: 'tracks', sidebarOpen: true, selectedSection: null, activeTrack: source.parts[0].track });
      },
      pickTake(track, take) {
        const comp = present();
        if (comp.source?.picked[track] === take) return;
        apply(loadTake(comp, track, take));
      },
      rerollTakes: (seed = random()) => reshuffle({ variationSeed: seed }),
      setVariationAmount(amount) {
        const value = clamp(amount, 0, 1);
        if (value !== present().source?.amount) reshuffle({ amount: value }, 'variation-amount');
      },
      removeImport() {
        const comp = present();
        if (!comp.source) return;
        apply(generateComposition(comp.settings, comp.automation, comp.arrangement));
      },

      setVoice(track, patch) {
        const voices = { ...get().voices };
        if (patch) voices[track] = patch;
        else delete voices[track];
        set({ voices });
      },
      setView: (view) => set({ view, cameraNonce: get().cameraNonce + 1 }),
      resetCamera: () => set({ cameraNonce: get().cameraNonce + 1 }),
      setTheme: (theme) => set({ theme }),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      setSidebarTab: (sidebarTab) => set({ sidebarTab, sidebarOpen: true }),
      setTitle: (title) => set({ title }),
      notify: (message) => set({ toast: { id: ++toastId, message } }),
      setPendingImport: (pendingImport) => set({ pendingImport }),
    };
  });
}

export type StudioStore = ReturnType<typeof createStudioStore>;
