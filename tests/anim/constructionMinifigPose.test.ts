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

    // Generated bays are reported to the editor and accept saved overrides.
    const bays = construction.workBays ?? [];
    expect(bays.map(bay => bay.kind).sort()).toEqual(['head', 'lower', 'upper']);
    const upperBay = bays.find(bay => bay.kind === 'upper')!;
    expect(upperBay.placed).toBe(false);
    expect([upperBay.spot.x, upperBay.spot.z, upperBay.spot.angle].every(Number.isFinite)).toBe(true);
    expect(upperBay.parts).toContain('973p1u');

    const override = { x: upperBay.spot.x + 12, z: upperBay.spot.z + 8, angle: 15 };
    const moved = planConstruction(model, {
      algorithm: 'guided-v3', maxMilliseconds: 10_000,
      workBaySpots: { [upperBay.key]: override },
    });
    const movedBay = moved.workBays!.find(bay => bay.key === upperBay.key)!;
    expect(movedBay.placed).toBe(true);
    expect(movedBay.spot).toEqual(override);
    const movedOp = moved.operations.find(op => op.id === `construct:${upperBay.id}`)!;
    expect(movedOp).toBeDefined();
    const movedStart = movedOp.rigidPath?.[0] ?? movedOp.path[0];
    const bounds = movedOp.keys.map(key => model.parts.get(key)!.bounds);
    const centreX = (Math.min(...bounds.map(box => box.min[0])) + Math.max(...bounds.map(box => box.max[0]))) / 2;
    const centreZ = (Math.min(...bounds.map(box => box.min[2])) + Math.max(...bounds.map(box => box.max[2]))) / 2;
    // The bay can be yawed: apply the full pose to the box centre, not just its
    // translation column.
    const pose = movedStart.length === 16 ? movedStart : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...movedStart, 1];
    expect((pose[0] * centreX + pose[8] * centreZ + pose[12]) / 20).toBeCloseTo(override.x, 3);
    expect((pose[2] * centreX + pose[10] * centreZ + pose[14]) / 20).toBeCloseTo(override.z, 3);
    expect(() => planConstruction(model, {
      algorithm: 'guided-v3', maxMilliseconds: 10_000,
      workBaySpots: { [upperBay.key]: { x: NaN, z: 0, angle: 0 } },
    })).toThrowError(/invalid-input/);
  }, 30_000);
});
