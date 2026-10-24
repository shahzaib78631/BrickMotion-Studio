import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { modelFromPlan, planConstruction } from '../../src/anim/construction';
import type { ConstructionPlan } from '../../src/anim/construction/types';
import { importLDraw } from '../../src/io/ldrawImport';
import { PartLibrary } from '../../src/ldraw/library';
import { measurePart, type PartMetrics } from '../../src/ldraw/metrics';
import { shadowLookupFrom } from '../../src/ldraw/shadow';

const root = join(__dirname, '..', '..', 'public');
const fixture = join(__dirname, '..', 'fixtures', 'models', '10156-1.mpd');
const ready = existsSync(join(root, 'ldraw', 'parts', '3815.dat')) &&
  existsSync(join(root, 'data', 'ldcad-shadow.json')) && existsSync(fixture);

// The authored pose hangs both hands below the torso. Their wrist joints are
// anatomical connections whose withdrawal axis points downward, while a
// static-only profiled mate also exists in the opposite direction. The audit
// must pick the hard joint regardless of broad-phase pair order, and the
// subassembly bay must hold the group clear of the table so the hands can be
// withdrawn without an under-table sweep.
describe.skipIf(!ready)('posed minifig subassembly certification', () => {
  test('plans a minifig whose hands hang below the torso', async () => {
    const plan = importLDraw(readFileSync(fixture, 'utf8'), '10156-1.mpd');
    const name = Object.keys(plan.submodels ?? {}).find(key => key.toLowerCase() === '10156 - minifig');
    if (!name) throw new Error('fixture minifig submodel missing');
    const steps = plan.submodels![name].steps;
    const lib = new PartLibrary(async (part) => {
      for (const folder of ['parts', 'p', '']) {
        const file = join(root, 'ldraw', folder, part);
        if (existsSync(file)) return readFileSync(file, 'utf8');
      }
      return null;
    });
    lib.setShadow(shadowLookupFrom((JSON.parse(readFileSync(join(root, 'data', 'ldcad-shadow.json'), 'utf8')) as { files: Record<string, string> }).files));
    const measured = new Map<string, PartMetrics>();
    for (const step of steps) for (const item of step.pieces) {
      if (!('part' in item) || measured.has(item.part)) continue;
      measured.set(item.part, measurePart(await lib.loadPart(item.part), item.part));
    }
    const model = modelFromPlan({ ...plan, steps }, id => measured.get(id)!);
    const construction: ConstructionPlan = planConstruction(model, { algorithm: 'guided-v3', maxMilliseconds: 10_000 });
    expect(construction.operations.length).toBeGreaterThan(0);
    expect(construction.operations.every(op => op.check.method === 'continuous-triangle-sat')).toBe(true);
    // Hanging hands stay outside the upper-body fixture: the torso work bay
    // rests on the table, and each hand attaches only after the torso is placed.
    const upperOp = construction.operations.find(op =>
      op.kind === 'attach-subassembly' && op.id.startsWith('construct:$upper:'));
    expect(upperOp).toBeDefined();
    const start = upperOp!.rigidPath?.[0] ?? upperOp!.path[0];
    const startY = start.length === 16 ? start[13] : start[1];
    const bayBottom = Math.max(...upperOp!.keys.map(key => model.parts.get(key)!.bounds.max[1])) + startY;
    expect(bayBottom).toBeCloseTo(construction.ground, 3);
    const handOps = construction.operations.filter(op =>
      op.keys.some(key => model.parts.get(key)?.part?.toLowerCase() === '3820'));
    expect(handOps.length).toBeGreaterThan(0);
    const upperIndex = construction.operations.indexOf(upperOp!);
    expect(handOps.every(op => construction.operations.indexOf(op) > upperIndex)).toBe(true);
  }, 30_000);
});
