import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'vitest';
import { createSettings, generateComposition } from '../core/generator';
import { compositionToMidi, songToMidi } from '../core/midi';
import { firstBarOnsets, loopMetrics, type LoopMetrics } from '../core/score';
import { STYLE_IDS } from '../core/styles';
import type { BarCount, StyleId } from '../core/types';

/**
 * The evaluation harness: many seeds in every style, measured with `score.ts`, compared against
 * a saved baseline, plus a handful of MIDI files to listen to. `EVAL_LABEL=before npm run eval`
 * writes the baseline; a plain `npm run eval` writes `after` and the comparison.
 */

const LABEL = process.env.EVAL_LABEL ?? 'after';
const OUT = resolve('eval');
const SEEDS = Array.from({ length: 40 }, (_, i) => 1000 + i * 7919);
/** The loops written out as MIDI, the same in every run so before and after can be compared. */
const EXAMPLES = [11, 222, 3333, 44444, 555555, 6666666];

type Flat = Record<string, number>;

function flatten(m: LoopMetrics): Flat {
  const out: Flat = {};
  for (const [part, values] of Object.entries(m)) for (const [k, v] of Object.entries(values)) out[`${part}.${k}`] = v as number;
  return out;
}

function average(rows: readonly Flat[]): Flat {
  const out: Flat = {};
  for (const key of Object.keys(rows[0])) out[key] = rows.reduce((a, r) => a + r[key], 0) / rows.length;
  return out;
}

const jaccard = (a: Set<number>, b: Set<number>) => {
  const union = new Set([...a, ...b]).size;
  return union ? [...a].filter((x) => b.has(x)).length / union : 1;
};

function measure(style: StyleId) {
  const rows: Flat[] = [];
  const melodyBars = new Set<string>();
  const bassFirst: Set<number>[] = [];
  let ms = 0;
  let loops = 0;
  for (const bars of [4, 8] as BarCount[]) {
    for (const seed of SEEDS) {
      const settings = createSettings({ style, bars, seed, key: seed % 12 });
      const t0 = performance.now();
      const comp = generateComposition(settings);
      ms += performance.now() - t0;
      loops++;
      rows.push(flatten(loopMetrics(comp)));
      const first = comp.notes.filter((n) => n.track === 'melody' && n.start < 1920).map((n) => n.start);
      melodyBars.add(first.join(','));
      if (bars === 8) bassFirst.push(firstBarOnsets(comp.notes, 'bass'));
    }
  }
  const pairs: number[] = [];
  for (let i = 0; i < bassFirst.length; i++) for (let j = i + 1; j < bassFirst.length; j++) pairs.push(jaccard(bassFirst[i], bassFirst[j]));
  return {
    ...average(rows),
    'variety.melodyFirstBars': melodyBars.size / loops,
    'variety.bassSimilarity': pairs.reduce((a, x) => a + x, 0) / pairs.length,
    'time.msPerLoop': ms / loops,
  };
}

function report(before: Record<string, Flat> | null, after: Record<string, Flat>): string {
  const lines = [`# Melo evaluation: ${LABEL}`, '', `${SEEDS.length} seeds × 4 and 8 bars per style. Structural proxies only; listen before judging.`, ''];
  for (const style of STYLE_IDS) {
    lines.push(`## ${style}`, '', before ? '| metric | before | after | change |' : '| metric | value |', before ? '|---|---:|---:|---:|' : '|---|---:|');
    for (const [key, value] of Object.entries(after[style])) {
      const was = before?.[style]?.[key];
      lines.push(before ? `| ${key} | ${was?.toFixed(3) ?? '–'} | ${value.toFixed(3)} | ${was === undefined ? '' : (value - was >= 0 ? '+' : '') + (value - was).toFixed(3)} |` : `| ${key} | ${value.toFixed(3)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

it('measures the generator and writes the report and examples', { timeout: 600_000 }, () => {
  mkdirSync(resolve(OUT, 'midi', LABEL), { recursive: true });
  const results: Record<string, Flat> = {};
  for (const style of STYLE_IDS) results[style] = measure(style);
  writeFileSync(resolve(OUT, `metrics-${LABEL}.json`), JSON.stringify(results, null, 2));
  const baseline = resolve(OUT, 'metrics-before.json');
  const before = LABEL !== 'before' && existsSync(baseline) ? (JSON.parse(readFileSync(baseline, 'utf8')) as Record<string, Flat>) : null;
  writeFileSync(resolve(OUT, LABEL === 'before' ? 'report-before.md' : 'report.md'), report(before, results));

  for (const style of STYLE_IDS) {
    for (const seed of EXAMPLES) {
      const comp = generateComposition(createSettings({ style, bars: 8, seed, key: seed % 12 }));
      const name = `${style}-${seed}`;
      writeFileSync(resolve(OUT, 'midi', LABEL, `${name}.mid`), compositionToMidi(comp, { title: name }));
      if (seed === EXAMPLES[0] || seed === EXAMPLES[1]) writeFileSync(resolve(OUT, 'midi', LABEL, `${name}-song.mid`), songToMidi(comp, { title: name }));
    }
  }
  console.log(Object.entries(results).map(([s, r]) => `${s}: ${r['time.msPerLoop'].toFixed(2)} ms/loop`).join('\n'));
});
