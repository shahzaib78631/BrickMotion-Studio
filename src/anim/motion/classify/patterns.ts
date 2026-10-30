/**
 * Named mechanisms (spec section E): patterns over bodies, joint kinds, loops
 * and higher pairs. Topology decides; geometry only breaks ties (link
 * lengths, which way an axis points). No part numbers.
 *
 * Whole functions absorb their pieces: a piston engine its slider-cranks,
 * steering its four-bar and the gears that turn its pinion, a differential its
 * spider meshes, a six-bar the four-bars inside it.
 */
import * as THREE from 'three';
import type { Assembly, Metrics } from '../../../model/assemble';
import type { Recognition } from '../mobility/recognise';
import type { ScrewJoint } from '../mobility/screw';
import type { HigherPair } from '../pairs/higherPairs';
import type { Screw } from '../parts/actuators';
import { isTyre } from '../parts/libraryConnectors';
import { partFunctions } from '../parts/partFunctions';
import { worldFeatures } from '../gears/gearTable';
import { blocks, jointsAround, shortestLoop, type Cycle } from './loops';

export type MechanismKind = 'gearbox' | 'gear-train' | 'differential' | 'worm-drive' | 'four-bar' | 'parallelogram' | 'slider-crank' | 'piston-engine'
  | 'watt-six-bar' | 'stephenson-six-bar' | 'rack-steering' | 'steering' | 'suspension' | 'turntable' | 'linear-actuator' | 'vehicle';
export type NamedMechanism = {
  kind: MechanismKind; name: string;
  /** Body indices of the recognition, joint indices, and higher pair ids. */
  bodies: number[]; joints: number[]; pairs: string[];
  /** Bodies that drive it, and bodies it moves. */
  drivers: number[]; outputs: number[];
  /** Part keys by role (crank, pistons, rack, hubs, wheels, carrier, sides...). */
  parts?: Record<string, string[]>;
  /** Gear train: turns of the output per turn of the driver. */
  ratio?: number;
};

type V3 = [number, number, number];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
/** Axes within 4 degrees are parallel. */
const PARALLEL = Math.cos((4 * Math.PI) / 180);
/** Opposite links of a parallelogram agree within 1 LDU. */
const PARALLELOGRAM = 1;
/** A kingpin is within 30 degrees of vertical (LDraw -Y is up). */
const KINGPIN = Math.cos((30 * Math.PI) / 180);
/** A turntable turns on a connector at least this wide (LDU radius); pin and axle fits reach 8.2. */
const TURNTABLE_RADIUS = 10;
/** A wheel sits on a joint's axis line: within 2 LDU of it and 80 LDU along it. */
const ON_AXIS = 2, ALONG_AXIS = 80;
/** How far (joints) to look from a rack for its hubs, and from a strut for its wheel. */
const HUB_REACH = 4, WHEEL_REACH = 8;
/** Longest loop matched as a strut (a pin joiner between strut and frame adds one joint). */
const STRUT_LOOP = 6;

const sameLine = (a: ScrewJoint, b: ScrewJoint, slop = 2) => {
  if (!a.axis || !b.axis || !a.point || !b.point || Math.abs(dot(a.axis, b.axis)) < PARALLEL) return false;
  const d = sub(b.point, a.point), t = dot(d, a.axis);
  return len(sub(d, a.axis.map(x => x * t))) <= slop;
};

export function classify(rec: Recognition, pairs: readonly HigherPair[], screws: readonly Screw[], asm: Assembly, metrics?: Metrics): NamedMechanism[] {
  const n = rec.bodies.length, J = rec.joints;
  const instance = new Map(asm.instances.map(i => [i.key, i]));
  const bare = (key: string) => (instance.get(key)?.part ?? key).replace(/\.dat$/, '');
  const label = (b: number) => bare(rec.bodies[b][0]);
  // The ground is the biggest body.
  const ground = rec.bodies.reduce((best, b, i) => (b.length > rec.bodies[best].length ? i : best), 0);
  const around = jointsAround(n, J);
  const kind = (e: number) => J[e].joint.kind;
  const other = (e: number, x: number) => (J[e].a === x ? J[e].b : J[e].a);
  const designed = (e: number) => kind(e) === 'prismatic' && J[e].connectors.some(c => c.designedSlide);
  const pairBodies = pairs.flatMap(p => {
    const a = rec.bodyOf.get(p.a), b = rec.bodyOf.get(p.b);
    return a === undefined || b === undefined || a === b ? [] : [{ p, a, b }];
  });

  // --- Small loops, each at its shortest, deduplicated.
  const loops: Cycle[] = [];
  const seen = new Set<string>();
  for (let e = 0; e < J.length; e++) {
    const c = shortestLoop(J, around, e, STRUT_LOOP);
    if (!c) continue;
    const k = [...c.joints].sort((x, y) => x - y).join(',');
    if (!seen.has(k)) { seen.add(k); loops.push(c); }
  }
  /** The loop's ground: the global ground if it is in the loop, else its biggest body. */
  const loopGround = (c: Cycle) => (c.bodies.includes(ground) ? ground : c.bodies.reduce((g, b) => (rec.bodies[b].length > rec.bodies[g].length ? b : g)));
  const partsOf = (bodies: readonly number[]) => bodies.flatMap(b => rec.bodies[b]);
  const out: NamedMechanism[] = [];

  // --- Wheels: tyres (from metrics), and the bodies that carry them.
  const tyres = metrics ? asm.instances.filter(i => isTyre(i.part, metrics)) : [];
  const tyreAxis = new Map(tyres.map(t => {
    const s = partFunctions(t.part)!.seats.find(x => x.gender === 'F')!;
    return [t.key, { axis: new THREE.Vector3(...s.axis).transformDirection(t.world).toArray() as V3, centre: new THREE.Vector3(...s.centre).applyMatrix4(t.world).toArray() as V3 }];
  }));
  const tyreBodies = new Map<number, string[]>();
  for (const t of tyres) { const b = rec.bodyOf.get(t.key); if (b !== undefined) (tyreBodies.get(b) ?? tyreBodies.set(b, []).get(b)!).push(t.key); }
  /**
   * Tyres a body carries: in it, up to `reach` joints away (2: hub, axle, wheel), or on the line of one
   * of its turning joints. Joints `skip` passes are not followed.
   */
  const wheelsOf = (b: number, skip: (e: number) => boolean = () => false, reach = 2): string[] => {
    if (b === ground) return [];
    const found = new Set(tyreBodies.get(b) ?? []);
    for (const e of around[b]) {
      if (skip(e)) continue;
      const x = other(e, b);
      if (x === ground) continue;
      for (const k of tyreBodies.get(x) ?? []) found.add(k);
      if (reach > 1) for (const f of around[x]) { const y = other(f, x); if (y !== ground && y !== b) for (const k of tyreBodies.get(y) ?? []) found.add(k); }
    }
    // A wheel with no connector of its own (a rim the connector data misses) on a turning joint's line.
    for (const e of around[b]) {
      const j = J[e].joint;
      if (skip(e) || j.kind !== 'revolute' || !j.axis || !j.point) continue;
      for (const [key, t] of tyreAxis) {
        if (Math.abs(dot(j.axis, t.axis)) < PARALLEL) continue;
        const d = sub(t.centre, j.point), along = dot(d, j.axis);
        if (Math.abs(along) <= ALONG_AXIS && len(sub(d, j.axis.map(x => x * along))) <= ON_AXIS) found.add(key);
      }
    }
    return [...found].sort();
  };
  const steers = (e: number) => kind(e) === 'revolute' && Math.abs(J[e].joint.axis?.[1] ?? 0) >= KINGPIN;
  const kingpin = (b: number) => around[b].some(steers);
  /** A hub turns on a kingpin and carries a wheel itself: the arm it turns on reaches the same wheel only through the kingpin. */
  const isHub = (b: number) => b !== ground && kingpin(b) && wheelsOf(b, steers).length > 0;

  // --- Four-bars and parallelograms: four revolutes on parallel axes.
  const fourBars: NamedMechanism[] = [];
  for (const c of loops) {
    if (c.joints.length !== 4 || !c.joints.every(e => kind(e) === 'revolute')) continue;
    const axis = J[c.joints[0]].joint.axis!;
    if (!c.joints.every(e => Math.abs(dot(J[e].joint.axis!, axis)) >= PARALLEL)) continue;
    // Link i runs between joint i-1 and joint i, measured across the axis.
    const span = (e: number, f: number) => { const d = sub(J[f].joint.point!, J[e].joint.point!); return len(sub(d, axis.map(x => x * dot(d, axis)))); };
    const links = c.joints.map((e, i) => span(c.joints[(i + 3) % 4], e));
    const parallelogram = Math.abs(links[0] - links[2]) <= PARALLELOGRAM && Math.abs(links[1] - links[3]) <= PARALLELOGRAM;
    const g = loopGround(c), gi = c.bodies.indexOf(g);
    const cranks = [c.bodies[(gi + 1) % 4], c.bodies[(gi + 3) % 4]];
    fourBars.push({ kind: parallelogram ? 'parallelogram' : 'four-bar', name: `${parallelogram ? 'Parallelogram' : 'Four-bar'} — ${cranks.map(label).join(' / ')} on ${label(g)}`,
      bodies: c.bodies, joints: c.joints, pairs: [], drivers: [cranks[0]], outputs: [c.bodies[(gi + 2) % 4], cranks[1]],
      parts: { frame: rec.bodies[g], cranks: partsOf(cranks), coupler: rec.bodies[c.bodies[(gi + 2) % 4]] } });
  }

  // --- Slider-cranks (slide on the ground) and struts (slide between two moving links).
  const actuated = new Set(screws.flatMap(s => [s.body, s.piston].flatMap(k => (k && rec.bodyOf.has(k) ? [rec.bodyOf.get(k)!] : []))));
  const sliderCranks: { c: Cycle; ground: number; crank: number; slider: number }[] = [];
  const struts = new Map<number, Cycle>();
  for (const c of loops) {
    const slides = c.joints.filter(e => kind(e) === 'prismatic');
    if (slides.length !== 1) continue;
    const s = slides[0], g = loopGround(c);
    if (J[s].a === g || J[s].b === g) {
      if (c.joints.length !== 4 || !c.joints.every(e => e === s || kind(e) === 'revolute' || kind(e) === 'spherical')) continue;
      const slider = other(s, g), gi = c.bodies.indexOf(g);
      const crank = [c.bodies[(gi + 1) % 4], c.bodies[(gi + 3) % 4]].find(b => b !== slider)!;
      sliderCranks.push({ c, ground: g, crank, slider });
    } else if (designed(s) && !actuated.has(J[s].a) && !actuated.has(J[s].b)) {
      // Keep each strut's shortest loop.
      if (!struts.has(s) || struts.get(s)!.joints.length > c.joints.length) struts.set(s, c);
    }
  }
  const byCrank = new Map<string, typeof sliderCranks>();
  for (const sc of sliderCranks) { const k = `${sc.ground}|${sc.crank}`; (byCrank.get(k) ?? byCrank.set(k, []).get(k)!).push(sc); }
  for (const group of byCrank.values()) {
    const { crank } = group[0];
    const bodies = [...new Set(group.flatMap(g => g.c.bodies))], joints = [...new Set(group.flatMap(g => g.c.joints))].sort((x, y) => x - y);
    const sliders = [...new Set(group.map(g => g.slider))].sort((x, y) => x - y);
    if (sliders.length >= 2) out.push({ kind: 'piston-engine', name: `Piston engine — ${sliders.length} pistons on ${label(crank)}`,
      bodies, joints, pairs: [], drivers: [crank], outputs: sliders, parts: { crank: rec.bodies[crank], pistons: partsOf(sliders) } });
    else out.push({ kind: 'slider-crank', name: `Slider-crank — ${label(crank)} drives ${label(sliders[0])}`,
      bodies, joints, pairs: [], drivers: [crank], outputs: sliders, parts: { crank: rec.bodies[crank], slider: rec.bodies[sliders[0]] } });
  }

  // --- Suspension: a strut, and the wheel its loop reaches.
  for (const [s, c] of struts) {
    const strut = [J[s].a, J[s].b], others = new Set([...struts.keys()].filter(t => t !== s).flatMap(t => [J[t].a, J[t].b]));
    // The wheel's own body or the one it turns on (an upright), not an arm two joints from the tyre.
    const path = nearest(c.bodies.filter(b => b !== ground && !strut.includes(b)), b => wheelsOf(b, undefined, 1).length > 0, WHEEL_REACH, new Set([ground, ...others]));
    const wheelBody = path?.[path.length - 1];
    const bodies = [...new Set([...c.bodies, ...(path ?? [])])];
    out.push({ kind: 'suspension', name: `Suspension — ${label(J[s].a)} in ${label(J[s].b)}${wheelBody === undefined ? ' (no wheel reached)' : ` for ${bare(wheelsOf(wheelBody)[0])}`}`,
      bodies, joints: c.joints, pairs: [], drivers: [wheelBody ?? c.bodies.find(b => b !== ground && !strut.includes(b)) ?? strut[0]], outputs: strut,
      parts: { slide: partsOf(strut), ...(wheelBody === undefined ? {} : { wheels: wheelsOf(wheelBody) }) } });
  }

  /** Breadth first from `from` to the nearest body passing `test`, through bodies not in `stop`; the path, or null. */
  function nearest(from: readonly number[], test: (b: number) => boolean, reach: number, stop: ReadonlySet<number>): number[] | null {
    const via = new Map<number, number>(from.map(b => [b, -1])), depth = new Map(from.map(b => [b, 0]));
    const queue = [...from];
    while (queue.length) {
      const x = queue.shift()!;
      if (test(x)) { const p = [x]; for (let y = via.get(x)!; y !== -1; y = via.get(y)!) p.unshift(y); return p; }
      if (depth.get(x)! >= reach) continue;
      for (const e of around[x]) { const y = other(e, x); if (!via.has(y) && !stop.has(y)) { via.set(y, x); depth.set(y, depth.get(x)! + 1); queue.push(y); } }
    }
    return null;
  }

  // --- Differentials: a spider meshing two coaxial side gears that turn on one carrier.
  const bevels = pairBodies.filter(x => x.p.kind === 'bevel');
  const spiderPairs = new Set<string>();
  const differentials = new Map<string, { carrier: number; sides: [number, number]; spiders: Set<number>; pairs: Set<string> }>();
  for (let spider = 0; spider < n; spider++) {
    const meshes = bevels.filter(x => x.a === spider || x.b === spider);
    for (let i = 0; i < meshes.length; i++) for (let k = i + 1; k < meshes.length; k++) {
      const s1 = meshes[i].a === spider ? meshes[i].b : meshes[i].a, s2 = meshes[k].a === spider ? meshes[k].b : meshes[k].a;
      if (s1 === s2) continue;
      const turnsOn = (s: number) => new Map(around[s].filter(e => kind(e) === 'revolute').map(e => [other(e, s), e]));
      const on1 = turnsOn(s1), on2 = turnsOn(s2);
      // The carrier turns: with the frame as carrier it is only a reversing bevel set (a steering column).
      const common = [...on1.keys()].filter(c => c !== spider && c !== ground && on2.has(c) && sameLine(J[on1.get(c)!].joint, J[on2.get(c)!].joint));
      if (!common.length) continue;
      // The carrier holds the spider, or is driven by another gear (the ring), and is not the frame.
      const score = (c: number) => (around[c].some(e => other(e, c) === spider) ? 2 : 0)
        + (pairBodies.some(x => (x.a === c || x.b === c) && ![s1, s2, spider].includes(x.a === c ? x.b : x.a)) ? 1 : 0);
      const carrier = common.sort((x, y) => score(y) - score(x) || x - y)[0];
      const sides: [number, number] = s1 < s2 ? [s1, s2] : [s2, s1], key = `${carrier}|${sides}`;
      const d = differentials.get(key) ?? differentials.set(key, { carrier, sides, spiders: new Set(), pairs: new Set() }).get(key)!;
      d.spiders.add(spider); d.pairs.add(meshes[i].p.id); d.pairs.add(meshes[k].p.id);
      spiderPairs.add(meshes[i].p.id); spiderPairs.add(meshes[k].p.id);
    }
  }
  for (const d of differentials.values()) {
    const spiders = [...d.spiders].sort((x, y) => x - y);
    out.push({ kind: 'differential', name: `Differential — ${label(d.carrier)} carrier, ${spiders.length} spider${spiders.length > 1 ? 's' : ''}`,
      bodies: [d.carrier, ...d.sides, ...spiders], joints: [], pairs: [...d.pairs].sort(), drivers: [d.carrier], outputs: [...d.sides],
      parts: { carrier: rec.bodies[d.carrier], sides: partsOf(d.sides), spiders: partsOf(spiders) } });
  }

  // --- Worm drives.
  for (const x of pairBodies.filter(x => x.p.kind === 'worm'))
    out.push({ kind: 'worm-drive', name: `Worm drive — ${bare(x.p.a)} turns ${bare(x.p.b)}`, bodies: [x.a, x.b], joints: [], pairs: [x.p.id],
      drivers: [x.a], outputs: [x.b], ratio: (x.p.teethA ?? 1) / (x.p.teethB ?? 1), parts: { worm: [x.p.a], wheel: [x.p.b] } });

  // --- Rack steering: a rack moved by its pinion, carried on a slide, a four-bar or tie rods, turning hubs on kingpins.
  const steered = new Set<number>(), absorbedTrains = new Set<number>();
  const trains = gearTrains(pairBodies.filter(x => (x.p.kind === 'spur' || x.p.kind === 'bevel' || x.p.kind === 'crown' || x.p.kind === 'clutch') && !spiderPairs.has(x.p.id)));
  for (const x of pairBodies.filter(x => x.p.kind === 'rack')) {
    const P = x.a, R = x.b;
    if (R === ground || steered.has(R)) continue;
    const rack = instance.get(x.p.b), feature = rack ? worldFeatures(x.p.b, rack.part, rack.world)[x.p.featureB] : undefined;
    const slide = around[R].find(e => kind(e) === 'prismatic' && (!feature || Math.abs(dot(J[e].joint.axis!, feature.axis)) >= PARALLEL));
    const fourBar = fourBars.find(f => f.bodies.includes(R) && f.parts!.frame[0] !== rec.bodies[R][0]);
    const hubs: number[] = [], paths: number[][] = [];
    for (const h of reachable(R, HUB_REACH, new Set([ground, P]))) if (isHub(h.body)) { hubs.push(h.body); paths.push(h.path); }
    if (!hubs.length || (!slide && !fourBar && hubs.length < 2)) continue;
    const train = trains.findIndex(t => t.bodies.includes(P));
    if (train >= 0) absorbedTrains.add(train);
    const upstream = train >= 0 ? trains[train] : null;
    const driver = upstream ? upstream.farthestFrom(P) : P;
    const bodies = [...new Set([P, R, ...(fourBar?.bodies ?? []), ...(slide !== undefined ? [other(slide, R)] : []), ...paths.flat(), ...(upstream?.bodies ?? [])])];
    for (const b of bodies) steered.add(b);
    const carriage = fourBar ? 'on a four-bar tie rod' : slide !== undefined ? 'on a slide' : 'on tie rods';
    out.push({ kind: 'rack-steering', name: `Rack steering — ${bare(x.p.a)} → ${bare(x.p.b)} ${carriage}, ${hubs.length} hubs`,
      bodies, joints: [...(fourBar?.joints ?? []), ...(slide !== undefined ? [slide] : [])], pairs: [x.p.id, ...(upstream?.pairs ?? [])].sort(),
      drivers: [driver], outputs: hubs, parts: { pinion: [x.p.a], rack: rec.bodies[R], hubs: partsOf(hubs), wheels: [...new Set(hubs.flatMap(b => wheelsOf(b)))] } });
  }

  /** Bodies within `reach` joints of `from`, not through `stop`, with their paths. */
  function reachable(from: number, reach: number, stop: ReadonlySet<number>): { body: number; path: number[] }[] {
    const via = new Map<number, number>([[from, -1]]), depth = new Map([[from, 0]]), out: { body: number; path: number[] }[] = [];
    const queue = [from];
    while (queue.length) {
      const x = queue.shift()!;
      if (x !== from) { const p = [x]; for (let y = via.get(x)!; y !== -1; y = via.get(y)!) p.unshift(y); out.push({ body: x, path: p }); }
      if (depth.get(x)! >= reach) continue;
      for (const e of around[x]) { const y = other(e, x); if (!via.has(y) && !stop.has(y)) { via.set(y, x); depth.set(y, depth.get(x)! + 1); queue.push(y); } }
    }
    return out;
  }

  // --- Steering without a rack: two or more hubs on kingpins joined by one chain.
  const hubs = [...Array(n).keys()].filter(b => !steered.has(b) && isHub(b));
  const grouped = new Set<number>();
  for (const h of hubs) {
    if (grouped.has(h)) continue;
    const linked = reachable(h, HUB_REACH, new Set([ground])).filter(x => hubs.includes(x.body));
    if (!linked.length) continue;
    const members = [h, ...linked.map(x => x.body)];
    members.forEach(b => grouped.add(b));
    const bodies = [...new Set([h, ...linked.flatMap(x => x.path)])];
    out.push({ kind: 'steering', name: `Steering — ${members.length} hubs on kingpins`, bodies, joints: [], pairs: [], drivers: [h], outputs: members.slice(1),
      parts: { hubs: partsOf(members), wheels: [...new Set(members.flatMap(b => wheelsOf(b)))] } });
  }

  // --- Gear trains not absorbed by steering.
  trains.forEach((t, i) => {
    if (absorbedTrains.has(i)) return;
    const driver = t.end(), output = t.farthestFrom(driver);
    out.push({ kind: 'gear-train', name: `Gear train — ${label(driver)} → ${label(output)}, ${t.pairs.length} mesh${t.pairs.length > 1 ? 'es' : ''}`,
      bodies: t.bodies, joints: [], pairs: t.pairs, drivers: [driver], outputs: [output], ratio: t.ratio(driver, output) });
  });

  // --- Six-bars: a block of six bodies and seven revolutes.
  for (const block of blocks(n, J)) {
    if (block.length !== 7 || !block.every(e => kind(e) === 'revolute')) continue;
    const degree = new Map<number, number>();
    for (const e of block) for (const b of [J[e].a, J[e].b]) degree.set(b, (degree.get(b) ?? 0) + 1);
    if (degree.size !== 6) continue;
    const ternary = [...degree].filter(([, d]) => d === 3).map(([b]) => b);
    if (ternary.length !== 2) continue;
    const watt = block.some(e => ternary.includes(J[e].a) && ternary.includes(J[e].b));
    out.push({ kind: watt ? 'watt-six-bar' : 'stephenson-six-bar', name: `${watt ? 'Watt' : 'Stephenson'} six-bar — ${ternary.map(label).join(' / ')}`,
      bodies: [...degree.keys()], joints: [...block].sort((x, y) => x - y), pairs: [], drivers: [], outputs: [], parts: { ternary: partsOf(ternary) } });
  }

  // --- Turntables: a revolute on a wide connector between two bodies.
  for (let e = 0; e < J.length; e++) {
    if (kind(e) !== 'revolute' || !J[e].connectors.some(c => (c.region?.radius ?? 0) >= TURNTABLE_RADIUS)) continue;
    const [a, b] = [J[e].a, J[e].b];
    // A wheel on its bearing, or a gear or differential case on its axle, is not a turntable.
    if ([a, b].some(x => wheelsOf(x).length || pairBodies.some(p => p.a === x || p.b === x))) continue;
    const top = a === ground ? b : b === ground ? a : rec.bodies[a].length < rec.bodies[b].length ? a : b;
    out.push({ kind: 'turntable', name: `Turntable — ${label(top)} turns on ${label(other(e, top))}`, bodies: [a, b], joints: [e], pairs: [],
      drivers: [top], outputs: [top], parts: { top: rec.bodies[top] } });
  }

  // --- Linear actuators.
  for (const s of screws) {
    const body = rec.bodyOf.get(s.body), input = s.input ? rec.bodyOf.get(s.input) : undefined, piston = s.piston ? rec.bodyOf.get(s.piston) : undefined;
    if (body === undefined) continue;
    out.push({ kind: 'linear-actuator', name: `Linear actuator — ${bare(s.body)}`, bodies: [...new Set([body, input, piston].filter((b): b is number => b !== undefined))],
      joints: [], pairs: pairs.filter(p => p.kind === 'screw' && p.b === s.piston).map(p => p.id),
      drivers: input === undefined ? [] : [input], outputs: piston === undefined ? [] : [piston],
      parts: { actuator: [s.body], ...(s.input ? { input: [s.input] } : {}), ...(s.piston ? { piston: [s.piston] } : {}) } });
  }

  // --- Four-bars: absorbed by a whole function holding two of their moving
  // links (a suspension's wishbones), repeated so linked four-bars chain in;
  // the rest stand alone, once per set of bodies.
  const wholes = out.filter(m => m.kind !== 'gear-train' && m.kind !== 'worm-drive' && m.kind !== 'turntable' && m.kind !== 'linear-actuator');
  const left = new Set(fourBars);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of left) {
      const frame = rec.bodyOf.get(f.parts!.frame[0])!, moving = f.bodies.filter(b => b !== frame);
      const w = wholes.find(m => moving.filter(b => m.bodies.includes(b)).length >= 2);
      if (!w) continue;
      for (const b of f.bodies) if (!w.bodies.includes(b)) w.bodies.push(b);
      for (const e of f.joints) if (!w.joints.includes(e)) w.joints.push(e);
      left.delete(f); grew = true;
    }
  }
  const once = new Set<string>();
  for (const f of left) { const k = [...f.bodies].sort((x, y) => x - y).join(','); if (!once.has(k)) { once.add(k); out.push(f); } }
  return out;

  /** Connected groups of gear meshes over bodies, with how to read a ratio along them. */
  function gearTrains(edges: typeof pairBodies) {
    const adj = new Map<number, { to: number; ratio: number; id: string }[]>();
    for (const x of edges) {
      const r = x.p.ratio ?? (x.p.teethA ?? 1) / (x.p.teethB ?? 1);
      (adj.get(x.a) ?? adj.set(x.a, []).get(x.a)!).push({ to: x.b, ratio: r, id: x.p.id });
      (adj.get(x.b) ?? adj.set(x.b, []).get(x.b)!).push({ to: x.a, ratio: 1 / r, id: x.p.id });
    }
    const done = new Set<number>(), groups: { bodies: number[]; pairs: string[]; end: () => number; farthestFrom: (b: number) => number; ratio: (a: number, b: number) => number }[] = [];
    const walk = (from: number) => {
      const turns = new Map([[from, 1]]), order = [from];
      for (let i = 0; i < order.length; i++) for (const e of adj.get(order[i]) ?? []) if (!turns.has(e.to)) { turns.set(e.to, turns.get(order[i])! * e.ratio); order.push(e.to); }
      return { turns, order };
    };
    for (const start of [...adj.keys()].sort((x, y) => x - y)) {
      if (done.has(start)) continue;
      const { order } = walk(start);
      order.forEach(b => done.add(b));
      const bodies = [...order].sort((x, y) => x - y);
      const ids = [...new Set(bodies.flatMap(b => (adj.get(b) ?? []).map(e => e.id)))].sort();
      groups.push({
        bodies, pairs: ids,
        end: () => bodies.find(b => (adj.get(b) ?? []).length === 1) ?? bodies[0],
        farthestFrom: b => { const o = walk(b).order; return o[o.length - 1]; },
        ratio: (a, b) => walk(a).turns.get(b) ?? 1,
      });
    }
    return groups;
  }
}
