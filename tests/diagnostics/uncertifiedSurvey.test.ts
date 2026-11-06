/**
 * Survey (LEGACY planner): plans every .mpd in a folder and writes one line per model with
 * its uncertified pieces, tagged [nosnap] (no LDCad snaps) and [nomate] (no LDCad connector
 * joins it to any neighbour). Skipped unless OUT is set.
 *
 *   OUT=survey.tsv [DIR=~/Downloads/] [ONLY='a.mpd|b'] npx vitest run tests/diagnostics/uncertifiedSurvey.test.ts
 */
import { it } from 'vitest';
import { readdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { loadRealModel } from './loadRealModel';
import { buildTimeline } from '../../src/anim/timeline';
import { mateAxes, worldSnaps } from '../../src/anim/snapMates';
const OUT = process.env.OUT!;
const DIR = process.env.DIR ?? '/Users/mac/Downloads/';
it.skipIf(!OUT)('survey', async () => {
  const dir = DIR.endsWith('/') ? DIR : DIR + '/';
  const only = process.env.ONLY?.split('|');
  const files = readdirSync(dir).filter(f => f.endsWith('.mpd') && !/5590|31039|helicopter|42000|42115/i.test(f) && (!only || only.some(o => f.includes(o))));
  writeFileSync(OUT, '');
  for (const f of files) {
    try {
      const { asm, metrics } = await loadRealModel(dir + f);
      const t0 = Date.now();
      const tl = buildTimeline(asm, metrics, { targetSeconds: 15, heroOrbit: true });
      const bad = tl.units.filter(u => u.uncertified);
      const byKey = new Map(asm.instances.map(i => [i.key, i]));
      const detail = bad.flatMap(u => u.keys).map(k => {
        const i = byKey.get(k)!; const m = metrics(i.part);
        const own = worldSnaps(m.snaps, i.world.elements);
        const mated = asm.instances.some(o => o !== i && mateAxes(own, worldSnaps(metrics(o.part).snaps, o.world.elements)).length);
        return `${i.part}${m.snaps?.length ? '' : '[nosnap]'}${mated ? '' : '[nomate]'}`;
      });
      appendFileSync(OUT, `${f}\tpieces ${asm.instances.length}\tuncert ${detail.length}\t${((Date.now() - t0) / 1000).toFixed(0)}s\t${detail.join(' ')}\n`);
    } catch (e) { appendFileSync(OUT, `${f}\tERR ${String(e).slice(0, 120)}\n`); }
  }
}, 3600000);
