/**
 * Select every piece (A) and turn the selection with the rotate gizmo: the model must
 * turn as one rigid body (police car: a 30° roof, two submodels, loose parts).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { beforeAll, expect, test } from 'vitest';
import { readProjectFile } from '../../src/io/projectFile';
import { assemble, type Assembly, type Metrics } from '../../src/model/assemble';
import { PartLibrary } from '../../src/ldraw/library';
import { measurePart, type PartMetrics } from '../../src/ldraw/metrics';
import { parseLDConfig } from '../../src/ldraw/colors';
import { aroundPivot, transformPlanItems } from '../../src/plan/gizmo';
import { modelSteps } from '../../src/plan/ops';
import { allPartIds } from '../../src/state/useModel';
import type { Plan } from '../../src/plan/types';

const ROOT = join(__dirname, '..', '..', 'public', 'ldraw');
const FILE = join(__dirname, '..', 'fixtures', 'models', 'police-car.brickmotion');
const haveLib = existsSync(join(ROOT, 'LDConfig.ldr'));

let plan: Plan;
let metrics: Metrics;
let colors: ReturnType<typeof parseLDConfig>;

beforeAll(async () => {
  if (!haveLib) return;
  const r = readProjectFile(readFileSync(FILE, 'utf8'));
  if (!r.ok) throw new Error(r.errors.join('; '));
  plan = r.plan;
  const lib = new PartLibrary(async (p) => {
    const f = join(ROOT, p);
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  });
  const map = new Map<string, PartMetrics>();
  for (const id of allPartIds(plan)) map.set(id, measurePart(await lib.loadPart(id), id));
  metrics = (p: string) => map.get(p) ?? measurePart(null, p);
  colors = parseLDConfig(readFileSync(join(ROOT, 'LDConfig.ldr'), 'utf8'));
}, 60_000);

const LDU_TO_WORLD = new THREE.Matrix4().makeScale(1 / 20, -1 / 20, -1 / 20);
const worldOf = (asm: Assembly) => new Map(asm.instances.map((i) => [i.key, LDU_TO_WORLD.clone().multiply(i.world)]));

test.skipIf(!haveLib).each([90, 180, -90])('select all, gizmo-rotate %i° about Y: the car turns as one piece', (deg) => {
  const before = assemble(plan, metrics, colors);
  const ids = modelSteps(plan, '').flatMap((s) => s.pieces.flatMap((i) => (i.id ? [i.id] : [])));
  // the gizmo pivot: the centre of the selection's world bounds
  const box = new THREE.Box3();
  for (const i of before.instances) {
    const b = i.worldBox;
    box.union(new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)).applyMatrix4(LDU_TO_WORLD));
  }
  const pivot = box.getCenter(new THREE.Vector3());
  const rot = new THREE.Matrix4().makeRotationY((deg * Math.PI) / 180);
  const delta = aroundPivot(rot, pivot);
  const after = assemble(transformPlanItems(plan, '', ids, before.nodes, delta), metrics, colors);

  const w0 = worldOf(before);
  const w1 = worldOf(after);
  expect(w1.size).toBe(w0.size);
  const bad: string[] = [];
  for (const [key, m0] of w0) {
    const want = delta.clone().multiply(m0);
    const got = w1.get(key);
    if (!got) { bad.push(`${key} missing`); continue; }
    const off = Math.max(...want.elements.map((v, i) => Math.abs(v - got.elements[i])));
    if (off > 0.05) bad.push(`${key} off by ${off.toFixed(3)}`);
  }
  expect(bad).toEqual([]);
});
