import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { buildTimeline } from '../../src/anim/timeline';
import { readProjectFile } from '../../src/io/projectFile';
import { parseLDConfig } from '../../src/ldraw/colors';
import { PartLibrary } from '../../src/ldraw/library';
import { measurePart, type PartMetrics } from '../../src/ldraw/metrics';
import { shadowLookupFrom } from '../../src/ldraw/shadow';
import { assemble, type Metrics } from '../../src/model/assemble';
import { allPartIds } from '../../src/state/useModel';

// A classic police car on a 30°-turned base. It needs: a seat sunk into the
// car base, 1x1 plates clipped sideways onto headlight bricks, door hinge tubes,
// a clip-on roof hinge (4213/4315) and tyres on 122c01 wheel holders.
// Needs the local LDraw library and LDCad shadow data (`npm run setup`).
const root = join(__dirname, '..', '..', 'public');
const ready = existsSync(join(root, 'ldraw', 'LDConfig.ldr')) && existsSync(join(root, 'data', 'ldcad-shadow.json'));

test.skipIf(!ready)('Construction V2 plans the police car', async () => {
  const file = readProjectFile(readFileSync(join(__dirname, '..', 'fixtures', 'models', 'police-car.brickmotion'), 'utf8'));
  if (!file.ok) throw new Error('fixture did not load');
  const lib = new PartLibrary(async (p) => {
    const f = join(root, 'ldraw', p);
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  });
  lib.setShadow(shadowLookupFrom((JSON.parse(readFileSync(join(root, 'data', 'ldcad-shadow.json'), 'utf8')) as { files: Record<string, string> }).files));
  const measured = new Map<string, PartMetrics>();
  for (const id of allPartIds(file.plan)) measured.set(id, measurePart(await lib.loadPart(id), id));
  const metrics: Metrics = (p) => measured.get(p) ?? measurePart(null, p);
  const asm = assemble(file.plan, metrics, parseLDConfig(readFileSync(join(root, 'ldraw', 'LDConfig.ldr'), 'utf8')));

  const tl = buildTimeline(asm, metrics, { targetSeconds: 15, heroOrbit: true, planner: 'construction-v2' } as never);
  expect(tl.units.length).toBeGreaterThan(0);
  // every piece arrives in the animation, and none on an uncertified route
  const keys = new Set(tl.units.flatMap((u) => u.keys));
  type N = { children?: N[] };
  const leaves = (ns: N[]): number => ns.reduce((n, x) => n + (x.children?.length ? leaves(x.children) : 1), 0);
  expect(keys.size).toBe(leaves(asm.nodes as N[]));
  expect(tl.units.filter((u) => u.uncertified)).toEqual([]);
}, 120000);
