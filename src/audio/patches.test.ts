import { describe, expect, it } from 'vitest';
import { createSettings } from '../core/generator';
import { STYLE_IDS } from '../core/styles';
import { TRACK_IDS } from '../core/types';
import { createStudioStore } from '../state/store';
import { PATCHES, PATCH_IDS, STYLE_SOUNDS, autoPatch, patchesFor, resolvePatch } from './patches';

describe('patch library', () => {
  it('gives every style a full palette of patches voiced for their parts', () => {
    for (const style of STYLE_IDS) {
      for (const track of TRACK_IDS) {
        const id = STYLE_SOUNDS[style][track];
        expect(PATCHES[id].parts).toContain(track);
      }
    }
  });

  it('keeps every patch playable and its levels sensible', () => {
    for (const id of PATCH_IDS) {
      const patch = PATCHES[id];
      expect(patch.id).toBe(id);
      expect(patch.layers.length).toBeGreaterThan(0);
      expect(Math.abs(patch.level)).toBeLessThanOrEqual(12);
      for (const layer of patch.layers) {
        expect(layer.options.envelope).toBeDefined();
        expect(layer.level).toBeLessThanOrEqual(0);
        if (layer.velocity !== undefined) expect(layer.velocity).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('only offers bass patches to the bass, and every part has a choice', () => {
    for (const track of TRACK_IDS) expect(patchesFor(track).length).toBeGreaterThan(1);
    for (const p of patchesFor('bass')) expect(p.parts).toEqual(['bass']);
    expect(patchesFor('melody').some((p) => p.parts.includes('bass'))).toBe(false);
  });

  it('follows the style unless a part has a fitting choice', () => {
    const deep = createSettings({ style: 'deepHouse' });
    expect(resolvePatch(deep, 'chords')).toBe(STYLE_SOUNDS.deepHouse.chords);
    expect(resolvePatch(deep, 'chords', 'organ')).toBe('organ');
    expect(resolvePatch(createSettings({ style: 'ukg' }), 'melody', 'sub')).toBe(STYLE_SOUNDS.ukg.melody);
  });

  it('gives the brass one of its style’s brass sounds, picked by its seed', () => {
    for (const style of STYLE_IDS) {
      const picks = new Set(Array.from({ length: 40 }, (_, seed) => autoPatch(createSettings({ style, seed }), 'brass')));
      expect(picks.size, style).toBeGreaterThan(1);
      for (const id of picks) expect(['brass', 'horns', 'trumpet']).toContain(id);
      const settings = createSettings({ style, seed: 9 });
      expect(autoPatch(settings, 'brass')).toBe(autoPatch(settings, 'brass'));
      expect(resolvePatch(settings, 'brass', 'strings')).toBe('strings');
    }
    // Brass sounds are on offer for the melody too.
    expect(patchesFor('melody').map((p) => p.id)).toEqual(expect.arrayContaining(['brass', 'horns', 'trumpet']));
  });
});

describe('chosen sounds', () => {
  it('sets and clears a part’s sound without touching the composition or history', () => {
    const store = createStudioStore({ random: () => 7 });
    const before = store.getState().history;
    store.getState().setVoice('chords', 'keys');
    expect(store.getState().voices).toEqual({ chords: 'keys' });
    store.getState().setVoice('chords', null);
    expect(store.getState().voices).toEqual({});
    expect(store.getState().history).toBe(before);
  });
});
