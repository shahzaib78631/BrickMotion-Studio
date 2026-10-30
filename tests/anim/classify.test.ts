/**
 * Named mechanisms from loops, joint kinds and higher pairs (spec section E).
 * The 42000 expectations follow Kinebrick's 42000 analysis
 * (erik-larsen/kinebrick, CC BY-SA 4.0), used only as an oracle.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Assembly, Metrics } from '../../src/model/assemble';
import type { MechanicalJoint } from '../../src/anim/construction/mechanicalConstraintGraph';
import { screwJoint, type ConnectorFreedom, type V3 } from '../../src/anim/motion/mobility/screw';
import type { Recognition } from '../../src/anim/motion/mobility/recognise';
import type { HigherPair } from '../../src/anim/motion/pairs/higherPairs';
import { fundamentalLoops } from '../../src/anim/motion/classify/loops';
import { classify, type NamedMechanism } from '../../src/anim/motion/classify/patterns';
import { inspectMechanisms } from '../../src/anim/motion/v4/mechanismLab';
import { loadRealModel, partDataInstalled } from '../diagnostics/loadRealModel';

const S = 20;
const pin = (x: number, y: number, axis: V3 = [0, 0, 1], z = 0): ConnectorFreedom => ({ centre: [x * S, y * S, z * S], axis, turns: true, slides: false });
const slide = (x: number, y: number, axis: V3): ConnectorFreedom => ({ centre: [x * S, y * S, 0], axis, turns: false, slides: true });
const ball = (x: number, y: number): ConnectorFreedom => ({ centre: [x * S, y * S, 0], axis: [0, 0, 1], ball: true, turns: true, slides: false });
type Spec = [number, number, ConnectorFreedom, boolean?];
/** A recognition of single-part bodies b0..b(n-1); a joint flagged true is a designed slide. */
function rec(n: number, specs: Spec[]): Recognition {
  const bodies = [...Array(n).keys()].map(i => [`b${i}`]);
  return {
    bodies, bodyOf: new Map(bodies.map((b, i) => [b[0], i])), rounds: 1, idle: [], mobility: {} as never,
    joints: specs.map(([a, b, c, designed]) => ({ a, b, joint: screwJoint([c]),
      connectors: designed ? [{ id: `slide:b${a}:b${b}`, male: `b${a}`, female: `b${b}`, designedSlide: true } as MechanicalJoint] : [] })),
  };
}
const pair = (kind: HigherPair['kind'], a: number, b: number, teethA = 0, teethB = 0): HigherPair =>
  ({ id: `${kind}:b${a}:b${b}`, kind, a: `b${a}`, b: `b${b}`, partA: '', partB: '', featureA: 0, featureB: 0, teethA, teethB, ratio: teethA / teethB });
const noAsm = { instances: [] } as unknown as Assembly;
const kinds = (m: NamedMechanism[]) => m.map(x => x.kind).sort();

describe('fundamental loops', () => {
  it('one loop per joint beyond a spanning tree, cutting at higher pairs first', () => {
    // Two gears on one frame: the mesh closes the loop, so it is the cut.
    const loops = fundamentalLoops(3, [{ a: 0, b: 1 }, { a: 0, b: 2 }], [{ id: 'g', a: 1, b: 2 }]);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ pairs: ['g'], joints: [0, 1] });
    expect([...loops[0].bodies].sort()).toEqual([0, 1, 2]);
  });
});

describe('synthetic patterns', () => {
  it('four-bar', () => {
    const r = rec(4, [[0, 1, pin(0, 0)], [1, 2, pin(1, 3)], [2, 3, pin(5, 4)], [3, 0, pin(6, 0)]]);
    const m = classify(r, [], [], noAsm);
    expect(kinds(m)).toEqual(['four-bar']);
    expect([...m[0].bodies].sort()).toEqual([0, 1, 2, 3]);
  });
  it('parallelogram: opposite links equal', () => {
    const r = rec(4, [[0, 1, pin(0, 0)], [1, 2, pin(0, 3)], [2, 3, pin(5, 3)], [3, 0, pin(5, 0)]]);
    expect(kinds(classify(r, [], [], noAsm))).toEqual(['parallelogram']);
  });
  it('slider-crank: the crank drives, the slider is the output', () => {
    const r = rec(4, [[0, 1, pin(0, 0)], [1, 2, pin(1, 2)], [2, 3, pin(6, 0)], [3, 0, slide(6, 0, [1, 0, 0])]]);
    const m = classify(r, [], [], noAsm);
    expect(kinds(m)).toEqual(['slider-crank']);
    expect(m[0]).toMatchObject({ drivers: [1], outputs: [3] });
  });
  it('V2 engine: two slider-cranks on one crank are one piston engine', () => {
    const r = rec(6, [[0, 1, pin(0, 0)], [1, 2, pin(0, 1)], [1, 3, pin(0, 1)],
      [2, 4, ball(3, 4)], [3, 5, ball(-3, 4)], [4, 0, slide(3, 4, [0.6, 0.8, 0]), true], [5, 0, slide(-3, 4, [-0.6, 0.8, 0]), true]]);
    const m = classify(r, [], [], noAsm);
    expect(kinds(m)).toEqual(['piston-engine']);
    expect(m[0]).toMatchObject({ drivers: [1] });
    expect([...m[0].outputs].sort()).toEqual([4, 5]);
  });
  it('Watt six-bar: the two ternary links are joined', () => {
    // T1=0 (frame), T2=1; binaries 2,3 on T1 and 4,5 on T2; 2-4 and 3-5.
    const r = rec(6, [[0, 1, pin(0, 0)], [0, 2, pin(-3, 1)], [0, 3, pin(3, 1)], [1, 4, pin(-2, 4)], [1, 5, pin(2, 4)], [2, 4, pin(-4, 5)], [3, 5, pin(4, 6)]]);
    expect(kinds(classify(r, [], [], noAsm))).toEqual(['watt-six-bar']);
  });
  it('Stephenson six-bar: the ternary links are apart', () => {
    // T1=0, T2=1 joined through 2, through 3, and through the chain 4-5.
    const r = rec(6, [[0, 2, pin(0, 0)], [2, 1, pin(1, 4)], [0, 3, pin(5, 0)], [3, 1, pin(6, 5)], [0, 4, pin(9, 1)], [4, 5, pin(11, 3)], [5, 1, pin(8, 6)]]);
    expect(kinds(classify(r, [], [], noAsm))).toEqual(['stephenson-six-bar']);
  });
  it('three-gear train: the ratio is the product', () => {
    const r = rec(4, [[0, 1, pin(0, 0)], [0, 2, pin(1, 0)], [0, 3, pin(3, 0)]]);
    const m = classify(r, [pair('spur', 1, 2, 8, 24), pair('spur', 2, 3, 24, 40)], [], noAsm);
    expect(kinds(m)).toEqual(['gear-train']);
    expect(m[0]).toMatchObject({ drivers: [1], outputs: [3], pairs: ['spur:b1:b2', 'spur:b2:b3'] });
    expect(m[0].ratio).toBeCloseTo(0.2, 9);
  });
  it('differential: a carrier holding a spider that meshes two coaxial side gears', () => {
    // Carrier 1 turns on the frame about x; side gears 2, 3 turn on it about x; spider 4 about y; pinion 5 drives the carrier.
    const r = rec(6, [[0, 1, pin(0, 0, [1, 0, 0])], [1, 2, pin(1, 0, [1, 0, 0])], [1, 3, pin(-1, 0, [1, 0, 0])], [1, 4, pin(0, 1, [0, 1, 0])], [0, 5, pin(0, 0, [0, 0, 1], 2)]]);
    const m = classify(r, [pair('bevel', 4, 2, 12, 12), pair('bevel', 4, 3, 12, 12), pair('bevel', 5, 1, 20, 28)], [], noAsm);
    const d = m.find(x => x.kind === 'differential');
    expect(d?.parts).toMatchObject({ carrier: ['b1'], sides: ['b2', 'b3'], spiders: ['b4'] });
    // The spider meshes are the differential's, not also a gear train's.
    for (const g of m.filter(x => x.kind === 'gear-train')) expect(g.pairs.some(p => p.startsWith('bevel:b4'))).toBe(false);
  });
  it('worm drive', () => {
    const r = rec(3, [[0, 1, pin(0, 0, [1, 0, 0])], [0, 2, pin(0, 1)]]);
    expect(kinds(classify(r, [pair('worm', 1, 2, 1, 24)], [], noAsm))).toEqual(['worm-drive']);
  });
  it('linear actuator from a screw', () => {
    const r = rec(3, [[0, 1, pin(0, 0)], [1, 2, slide(0, 0, [1, 0, 0]), true]]);
    const m = classify(r, [], [{ body: 'b1', axis: [1, 0, 0], centre: [0, 0, 0], leadLduPerTurn: 3, stroke: [0, 60], input: 'b0', piston: 'b2' }], noAsm);
    expect(kinds(m)).toEqual(['linear-actuator']);
  });
});

const SAMPLES = join(__dirname, '..', '..', 'samples');
const M42000 = join(SAMPLES, '42000-1.mpd'), M5590 = join(SAMPLES, '5590_-_whirl_n_wheel_super_truck.mpd');
function finder(asm: Assembly) {
  return (part: string, x: number, y: number, z: number) => {
    const i = asm.instances.find(i => i.part.replace(/\.dat$/, '') === part && Math.hypot(i.world.elements[12] - x, i.world.elements[13] - y, i.world.elements[14] - z) < 3);
    if (!i) throw new Error(`no ${part} at ${x},${y},${z}`);
    return i.key;
  };
}
async function named(file: string) {
  const { asm, metrics } = await loadRealModel(file);
  const r = inspectMechanisms(asm, metrics);
  return { asm, metrics, rec: r.graph.recognition!, mechanisms: classify(r.graph.recognition!, r.higherPairs, [], asm, metrics as Metrics) };
}

describe.skipIf(!partDataInstalled() || !existsSync(M5590))('5590 named mechanisms', () => {
  it('rack steering on a four-bar, which it absorbs', async () => {
    const { asm, rec: r, mechanisms } = await named(M5590);
    const at = finder(asm);
    const steering = mechanisms.filter(m => m.kind === 'rack-steering');
    expect(steering).toHaveLength(1);
    expect(steering[0].name).toMatch(/four-bar/);
    expect(steering[0].parts?.rack).toContain(at('3743', 14, -50, -53));
    const hubs = steering[0].parts!.hubs.map(k => r.bodyOf.get(k));
    expect(new Set(hubs)).toEqual(new Set([r.bodyOf.get(at('4261', -70, -24, -90)), r.bodyOf.get(at('4261', 70, -24, -90))]));
    const inside = new Set(steering[0].bodies);
    expect(mechanisms.filter(m => (m.kind === 'four-bar' || m.kind === 'parallelogram') && m.bodies.every(b => inside.has(b)))).toEqual([]);
    // The crane's turntable; wheel bearings and gears on their axles are not turntables.
    const tables = mechanisms.filter(m => m.kind === 'turntable');
    expect(tables.map(t => t.parts!.top.map(k => asm.instances.find(i => i.key === k)!.part.replace(/\.dat$/, '')))).toEqual([['3404']]);
  }, 120_000);
});

describe.skipIf(!partDataInstalled() || !existsSync(M42000))('42000 named mechanisms', () => {
  let asm: Assembly, r: Recognition, mechanisms: NamedMechanism[], at: ReturnType<typeof finder>;
  beforeAll(async () => { ({ asm, rec: r, mechanisms } = await named(M42000)); at = finder(asm); }, 120_000);

  it('V8 is one piston engine (8 slider-cranks on the 2853 crankshaft)', () => {
    const engines = mechanisms.filter(m => m.kind === 'piston-engine');
    expect(engines).toHaveLength(1);
    expect(engines[0].outputs).toHaveLength(8);
    expect(engines[0].drivers).toEqual([r.bodyOf.get(at('2853', 0, -100, 470))]);
    expect(mechanisms.filter(m => m.kind === 'slider-crank')).toEqual([]);
  });
  it('differential at 62821', () => {
    const d = mechanisms.filter(m => m.kind === 'differential');
    expect(d).toHaveLength(1);
    expect(d[0].parts?.carrier).toContain(at('62821', 0, -60, 640));
    expect(new Set(d[0].parts!.sides.map(k => r.bodyOf.get(k)))).toEqual(new Set([r.bodyOf.get(at('6589', 17, -60, 640)), r.bodyOf.get(at('6589', -17, -60, 640))]));
  });
  it('two suspensions per axle', () => {
    const struts = mechanisms.filter(m => m.kind === 'suspension').map(m => m.parts!.slide.map(k => asm.instances.find(i => i.key === k)!.world.elements[14]));
    const axle = (z: number) => (z < 0 ? 'front' : 'rear');
    const count = { front: 0, rear: 0 };
    for (const zs of struts) count[axle(zs[0])]++;
    expect(count).toEqual({ front: 2, rear: 2 });
  });
  it('rear suspensions reach their wheels', () => {
    for (const m of mechanisms.filter(m => m.kind === 'suspension' && asm.instances.find(i => i.key === m.parts!.slide[0])!.world.elements[14] > 0))
      expect(m.parts?.wheels?.length, m.name).toBeGreaterThan(0);
  });
  it('rack steering with both front hubs', () => {
    const s = mechanisms.filter(m => m.kind === 'rack-steering');
    expect(s).toHaveLength(1);
    expect(s[0].parts?.rack).toContain(at('87761', 0, -80, -320));
    expect(new Set(s[0].parts!.hubs.map(k => r.bodyOf.get(k)))).toEqual(new Set([r.bodyOf.get(at('11949', -220, -60, -280)), r.bodyOf.get(at('11949', 220, -60, -280))]));
  });
});
