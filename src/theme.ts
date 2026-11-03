import type { TrackId } from './core/types';

export type Theme = 'light' | 'dark';

/** Presentation tokens shared by the DOM UI and the 3D scene. Keep in step with index.css. */
export const TRACK_PALETTES: Record<Theme, Record<TrackId, string>> = {
  light: { melody: '#ee6335', counter: '#14a585', brass: '#c9970f', chords: '#9877ee', bass: '#3c6cf0' },
  dark: { melody: '#ff7448', counter: '#2ec4a0', brass: '#efbf3f', chords: '#b79bff', bass: '#4d7bff' },
};

/** CSS references for DOM elements; these follow the theme on their own. */
export const TRACK_COLORS: Record<TrackId, string> = {
  melody: 'var(--color-melody)',
  counter: 'var(--color-counter)',
  brass: 'var(--color-brass)',
  chords: 'var(--color-chords)',
  bass: 'var(--color-bass)',
};

export const TRACK_LABELS: Record<TrackId, string> = {
  melody: 'Melody',
  counter: 'Counter',
  brass: 'Brass',
  chords: 'Chords',
  bass: 'Bass',
};

export interface SceneTheme {
  tracks: Record<TrackId, string>;
  /** Top surface of the table and its sides. */
  table: string;
  tableSide: string;
  /** The recessed bed the keys sit in. */
  keyBed: string;
  whiteKey: string;
  blackKey: string;
  /** Printed text and grid lines. */
  ink: string;
  /** Darker lane shading for black-key rows. */
  shade: string;
  /** Strength multipliers for grid lines and lane shading. */
  grid: { lines: number; shade: number };
  /** Colour notes fade towards when their part is muted. */
  muted: string;
  /** How strongly notes light up while sounding. */
  glow: number;
  light: { ambient: number; hemiSky: string; hemiGround: string; hemi: number; key: number; fill: number; env: number };
  contactShadow: number;
}

export const SCENE_THEMES: Record<Theme, SceneTheme> = {
  light: {
    tracks: TRACK_PALETTES.light,
    table: '#f3f1ec',
    tableSide: '#dedad3',
    keyBed: '#d6d1c9',
    whiteKey: '#fbfaf7',
    blackKey: '#2a2a2d',
    ink: '#2b2925',
    shade: '#5a554c',
    grid: { lines: 1, shade: 0.55 },
    muted: '#c9c5bd',
    glow: 0.32,
    light: { ambient: 0.55, hemiSky: '#ffffff', hemiGround: '#d9d4cb', hemi: 0.75, key: 1.9, fill: 0.35, env: 0.55 },
    contactShadow: 0.24,
  },
  dark: {
    tracks: TRACK_PALETTES.dark,
    table: '#28282c',
    tableSide: '#1d1d20',
    keyBed: '#151517',
    whiteKey: '#dcd6cc',
    blackKey: '#151518',
    ink: '#ece8e1',
    shade: '#000000',
    grid: { lines: 1.3, shade: 1 },
    muted: '#3a3a41',
    glow: 0.45,
    light: { ambient: 0.25, hemiSky: '#fff4e8', hemiGround: '#141417', hemi: 0.5, key: 2.1, fill: 0.35, env: 1 },
    contactShadow: 0.6,
  },
};
