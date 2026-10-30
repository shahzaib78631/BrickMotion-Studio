/**
 * Designed slides, seats and linear actuators, measured from LDraw geometry.
 * The 42000 expectations (shock rods slide, pistons slide in their cylinders,
 * tyres sit on rims, three linear actuators) follow Kinebrick's 42000
 * analysis (erik-larsen/kinebrick, CC BY-SA 4.0), used only as an oracle.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Assembly, Metrics } from '../../src/model/assemble';
import { measurePartFunctions } from '../../src/anim/motion/parts/partFunctions';
import { libraryConnectors } from '../../src/anim/motion/parts/libraryConnectors';
import { findLinearActuators, ACTUATOR_LEAD } from '../../src/anim/motion/parts/actuators';
import { connectorFreedom } from '../../src/anim/motion/mobility/recognise';
import { inspectMechanisms } from '../../src/anim/motion/v4/mechanismLab';
import type { MechanicalJoint } from '../../src/anim/construction/mechanicalConstraintGraph';
import { PartLibrary } from '../../src/ldraw/library';
import { readFileSync } from 'node:fs';
import { loadRealModel, partDataInstalled } from '../diagnostics/loadRealModel';

const LDRAW = join(__dirname, '..', '..', 'public', 'ldraw');
const installed = existsSync(join(LDRAW, 'parts', '4255.dat'));
const lib = new PartLibrary(async p => { const f = join(LDRAW, p); return existsSync(f) ? readFileSync(f, 'utf8') : null; });
const functions = async (id: string) => measurePartFunctions(await lib.loadPart(`${id}.dat`));
const parallel = (a: readonly number[], b: readonly number[]) => Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / Math.hypot(...a) / Math.hypot(...b) >= Math.cos(4 * Math.PI / 180);

describe.skipIf(!installed)('bores, rods and seats from part geometry', () => {
  it('a shock absorber cylinder has a bore; its rod is a rod', async () => {
    const [bore] = (await functions('4255')).bores;
    expect(bore).toBeDefined();
    expect(parallel(bore.axis, [0, 1, 0])).toBe(true);
    expect(bore.radius).toBeCloseTo(6, 1);
    expect(bore.travel[1] - bore.travel[0]).toBeGreaterThanOrEqual(40);
    const rod = (await functions('4254')).rods.find(r => parallel(r.axis, [0, 1, 0]));
    expect(rod, 'rod along y').toBeDefined();
    // The shaft from y = -72 to -15 fits in a radius 6 bore (its stopper, -80 to -72, is wider).
    expect(rod!.segments.some(([from, to, r]) => from <= -70 && to >= -20 && r <= 6.5)).toBe(true);
  });

  it('an engine cylinder has a radius 12 bore; the piston fits it', async () => {
    const [bore] = (await functions('32061')).bores;
    expect(bore?.radius).toBeCloseTo(12, 1);
    expect(bore.travel[1] - bore.travel[0]).toBeGreaterThanOrEqual(40);
    // The piston fits within radius 12 all the way from y = -16 to 8.
    const rod = (await functions('2851')).rods.find(r => parallel(r.axis, [0, 1, 0]))!;
    const inside = rod.segments.filter(([from, to]) => from >= -16 && to <= 8);
    expect(inside.reduce((n, [from, to]) => n + to - from, 0)).toBe(24);
    expect(Math.max(...inside.map(s => s[2]))).toBeCloseTo(12, 1);
    expect(inside.every(s => s[2] <= 12.5)).toBe(true);
  });

  // A pin joiner (62462) does have a 40 LDU bore: its pins are held by their
  // LDCad connectors, which keep any designed slide off (see the 42000 tests).
  it('pin holes, axles and rims are not bores', async () => {
    for (const id of ['3673', '32054', '3713', '32523', '6538', '2780', '3706', '4274', '6536', '44772']) {
      expect((await functions(id)).bores, id).toEqual([]);
    }
  });

  it('a tyre has an inner seat that matches its rim\'s outer seat', async () => {
    const tyre = (await functions('44771')).seats.filter(s => s.gender === 'F');
    const rim = (await functions('44772')).seats.filter(s => s.gender === 'M');
    expect(tyre.some(t => rim.some(r => Math.abs(t.radius - r.radius) <= 1))).toBe(true);
  });
});

describe('designed slides are the only axial slides', () => {
  const j = (extra: Partial<MechanicalJoint>): MechanicalJoint => ({ id: 'j', male: 'a', female: 'b', type: 'pin-hole', axis: [0, 0, 1], centre: [0, 0, 0], engagement: 20, motion: 'sliding', rotates: true, ...extra });
  it('axle in a round hole still does not slide', () => {
    expect(connectorFreedom(j({}))!.slides).toBe(false);
    expect(connectorFreedom(j({ type: 'axle-hole', rotates: false }))!.slides).toBe(false);
  });
  it('a designed slide slides without turning', () => {
    const f = connectorFreedom(j({ type: 'cylindrical', rotates: false, designedSlide: true }))!;
    expect([f.slides, f.turns]).toEqual([true, false]);
  });
});

const MODEL = join(__dirname, '..', '..', 'samples', '42000-1.mpd');
describe.skipIf(!partDataInstalled() || !existsSync(MODEL))('42000: slides, seats and actuators', () => {
  let asm: Assembly, metrics: Metrics, connectors: MechanicalJoint[];
  const at = (part: string, x: number, y: number, z: number) => {
    const i = asm.instances.find(i => i.part.replace(/\.dat$/, '') === part && Math.hypot(i.world.elements[12] - x, i.world.elements[13] - y, i.world.elements[14] - z) < 6);
    if (!i) throw new Error(`no ${part} at ${x},${y},${z}`);
    return i.key;
  };
  const between = (a: string, b: string) => connectors.filter(c => (c.male === a && c.female === b) || (c.male === b && c.female === a));
  beforeAll(async () => {
    ({ asm, metrics } = await loadRealModel(MODEL));
    connectors = libraryConnectors(asm, metrics);
  }, 120_000);

  it('shock absorbers slide', () => {
    for (const [x, z, dz] of [[20, 620, -100], [-20, 620, -100], [-20, -160, -100], [20, -160, -100]]) {
      const rod = at('4254', x, -120, z), cyl = at('4255', x, -120, z + dz);
      const [c] = between(rod, cyl);
      expect(c, `${rod} in ${cyl}`).toBeDefined();
      expect([c.motion, c.designedSlide, c.male]).toEqual(['sliding', true, rod]);
      expect(parallel(c.axis, [0, 0, 1])).toBe(true);
      // Built position inside the travel.
      expect(c.travel![0]).toBeLessThanOrEqual(0);
      expect(c.travel![1]).toBeGreaterThanOrEqual(0);
    }
  });

  it('pistons slide in their cylinders', () => {
    const pistons = asm.instances.filter(i => i.part.replace(/\.dat$/, '') === '2851');
    expect(pistons).toHaveLength(8);
    for (const p of pistons) {
      const slides = connectors.filter(c => c.male === p.key && c.designedSlide);
      expect(slides, p.key).toHaveLength(1);
      const host = asm.instances.find(i => i.key === slides[0].female)!;
      expect(host.part.replace(/\.dat$/, '')).toBe('32061');
      // The V8's two banks lean at (±0.8, -0.6, 0).
      expect(parallel(slides[0].axis, [0.8, 0.6, 0]) || parallel(slides[0].axis, [0.8, -0.6, 0])).toBe(true);
    }
  });

  it('tyres sit on rims', () => {
    for (const [x, z] of [[-270, -280], [270, -280], [270, 640], [-270, 640]]) {
      const tyre = at('44771', x, -60, z), rim = at('44772', x + Math.sign(x) * 2, -60, z);
      const [c] = between(tyre, rim);
      expect(c, `${tyre} on ${rim}`).toBeDefined();
      expect([c.motion, c.male, c.female]).toEqual(['fixed', rim, tyre]);
    }
  });

  it('in the recognised mechanism, rods slide in cylinders and tyres ride with rims', () => {
    const { graph } = inspectMechanisms(asm, metrics);
    const r = graph.recognition!;
    const rod = at('4254', 20, -120, 620), cyl = at('4255', 20, -120, 520);
    expect(r.bodyOf.get(rod)).not.toBe(r.bodyOf.get(cyl));
    const joint = r.joints.find(j => [j.a, j.b].sort().join() === [r.bodyOf.get(rod)!, r.bodyOf.get(cyl)!].sort().join());
    expect(joint?.joint.kind).toBe('prismatic');
    expect(r.bodyOf.get(at('44771', -270, -60, -280))).toBe(r.bodyOf.get(at('44772', -272, -60, -280)));
  }, 120_000);

  it('linear actuators: input axle turns, piston slides', () => {
    const found = findLinearActuators(asm, connectors);
    expect(found.map(s => s.body).sort()).toEqual([at('92693c01', 0, 0, 600), at('92693c01', 100, -40, 270), at('92693c01', -100, -40, 270)].sort());
    for (const s of found) {
      expect(s.leadLduPerTurn).toBeCloseTo(60 / 19.9, 6);
      expect(ACTUATOR_LEAD['92693c01']).toBeCloseTo(60 / 19.9, 6);
      // Stroke from the contracted (-f1) and extended (-f2) LDraw shortcuts: the piston moves 60 LDU.
      expect(s.stroke[1] - s.stroke[0]).toBeCloseTo(60, 6);
      const input = between(s.input!, s.body), piston = between(s.piston!, s.body);
      expect(input.map(c => c.motion)).toEqual(['revolute']);
      expect(piston.map(c => [c.motion, c.designedSlide])).toEqual([['sliding', true]]);
    }
  });
});
