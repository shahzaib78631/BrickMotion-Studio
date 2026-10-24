import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type * as THREE from 'three';
import { applyAssemblySpotTransform, buildTimeline, poseAt, spotTransform } from '../../src/anim/timeline';
import type { Timeline } from '../../src/anim/timeline';
import { readProjectFile } from '../../src/io/projectFile';
import { parseLDConfig, type ColorDef } from '../../src/ldraw/colors';
import type { Box } from '../../src/ldraw/flatten';
import { PartLibrary } from '../../src/ldraw/library';
import { measurePart, type PartMetrics } from '../../src/ldraw/metrics';
import { shadowLookupFrom } from '../../src/ldraw/shadow';
import { assemble, transformBox, unionBox, type Assembly, type Metrics } from '../../src/model/assemble';
import { centre2 } from '../../src/plan/assemblySpots';
import { setSubmodelBuildSpot } from '../../src/plan/pieceActions';
import type { Plan } from '../../src/plan/types';
import { allPartIds } from '../../src/state/useModel';

// Same fixture and library as policeCarConstruction.test.ts. The main spot is one rigid
// transform applied to the planned timeline; a submodel build spot moves that submodel's
// build while its final place stays put. Both planners are exercised.
const root = join(__dirname, '..', '..', 'public');
const ready = existsSync(join(root, 'ldraw', 'LDConfig.ldr')) && existsSync(join(root, 'data', 'ldcad-shadow.json'));

const SPOT = { x: 10, z: -5, angle: 90 };
const SUB_SPOT = { x: 24, z: -14, angle: 0 };
const underside1 = 'police car - underside 1';

const expectMat = (a: THREE.Matrix4, b: THREE.Matrix4, eps = 1e-2) =>
  a.elements.forEach((v, i) => expect(v).toBeCloseTo(b.elements[i], -Math.log10(eps)));
const boxOf = (list: Assembly['instances'], pose: (key: string) => THREE.Matrix4 | null, metrics: Metrics): Box | null => {
  let b: Box | null = null;
  for (const inst of list) {
    const m = pose(inst.key);
    if (m) b = unionBox(b, transformBox(metrics(inst.part).body, m));
  }
  return b;
};

type Loaded = { plan: Plan; metrics: Metrics; colors: Map<number, ColorDef>; subId: string };
let loaded: Promise<Loaded> | null = null;
function load(): Promise<Loaded> {
  loaded ??= (async () => {
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
    const colors = parseLDConfig(readFileSync(join(root, 'ldraw', 'LDConfig.ldr'), 'utf8'));
    const subId = file.plan.steps.flatMap((s) => s.pieces).find((i) => 'submodel' in i && i.submodel === underside1)?.id;
    if (!subId) throw new Error('fixture has no underside 1');
    return { plan: file.plan, metrics, colors, subId };
  })();
  return loaded;
}

function plan(l: Loaded, planner: 'legacy' | 'construction-v2', p: Plan = l.plan): { tl: Timeline; asm: Assembly } {
  const asm = assemble(p, l.metrics, l.colors);
  return { tl: buildTimeline(asm, l.metrics, { targetSeconds: 15, heroOrbit: true, planner } as never), asm };
}

test.skipIf(!ready)('main spot moves every piece and the camera framing', async () => {
  const l = await load();
  for (const planner of ['legacy', 'construction-v2'] as const) {
    const { tl } = plan(l, planner);
    const S = spotTransform(SPOT, tl.modelBox);
    const moved = applyAssemblySpotTransform(tl, SPOT);
    for (const [key, tr] of tl.tracks) expectMat(moved.tracks.get(key)!.final, S.clone().multiply(tr.final));
    expect(centre2(moved.modelBox)[0]).toBeCloseTo(SPOT.x * 20, 1);
    expect(centre2(moved.modelBox)[1]).toBeCloseTo(SPOT.z * 20, 1);
  }
}, 240000);

test.skipIf(!ready)('a submodel build spot builds that submodel there and keeps its final place', async () => {
  const l = await load();
  for (const planner of ['legacy', 'construction-v2'] as const) {
    const p = setSubmodelBuildSpot(l.plan, '', l.subId, SUB_SPOT);
    const { tl, asm } = plan(l, planner, p);
    const sb = tl.subBuilds.find((s) => s.key === l.subId);
    expect(sb, `${planner} planned the submodel`).toBeDefined();
    const pieces = asm.instances.filter((i) => i.model === underside1);
    const built = boxOf(pieces, poseAt(tl, sb!.attachStart - 1e-3), l.metrics);
    expect(built, `${planner} built the submodel`).not.toBeNull();
    expect(centre2(built!)[0]).toBeCloseTo(SUB_SPOT.x * 20, 0);
    expect(centre2(built!)[1]).toBeCloseTo(SUB_SPOT.z * 20, 0);
    // the submodel still lands exactly where it belongs on the model
    const end = poseAt(tl, tl.duration);
    for (const inst of pieces) expectMat(end(inst.key)!, inst.world, 1e-2);
  }
}, 240000);
