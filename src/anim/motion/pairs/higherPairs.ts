/**
 * Higher pairs: parts that drive each other through teeth or a screw rather
 * than a shared connector (gear meshes, bevels, rack and pinion, worm, linear
 * actuator screw). Found from measured toothed features placed in the model;
 * each pair can be re-checked at any pose, so a rack that runs off its pinion
 * or a gear slid out of mesh is seen at the frame it lets go.
 */
import * as THREE from 'three';
import type { Assembly } from '../../../model/assemble';
import { bevelMesh, MESH_TOLERANCE, rackMesh, spurMesh, type MeshVerdict, type WorldGear } from '../gears/gearGeometry';
import { worldFeatures, type WorldFeature } from '../gears/gearTable';
import type { SpatialMechanic } from '../kinematics/laws';
import type { Screw } from '../parts/actuators';

type V3 = [number, number, number];
export type HigherPairKind = 'spur' | 'bevel' | 'crown' | 'rack' | 'worm' | 'screw' | 'clutch';
export type HigherPair = {
  id: string; kind: HigherPairKind;
  /** Driving and driven part keys and parts; features index worldFeatures of each. */
  a: string; b: string; partA: string; partB: string; featureA: number; featureB: number;
  teethA?: number; teethB?: number;
  /** Turns of b per turn of a (gears), unsigned. */
  ratio?: number;
  /** b turns the other way about its own axis (gears), or the rack moves against its direction. */
  reversed?: boolean;
  /** Rack and pinion: the pinion's pitch radius (LDU travel per radian). */
  pitchRadius?: number;
  /** Screw: LDU of travel per turn. */
  lead?: number;
  errorLdu?: number;
};

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: readonly number[]): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
/** Worm axis square to the wheel's shaft: within 4 degrees. */
const SQUARE = Math.sin((4 * Math.PI) / 180);

/** The ways a feature can mesh: as a spur, as each bevel side, as a rack or a worm. */
function faces(f: WorldFeature): WorldGear[] {
  const base = { key: f.key, teeth: f.teeth, radius: f.pitchRadius, width: f.width, centre: f.centre, axis: f.axis };
  switch (f.kind) {
    case 'spur': case 'clutch': case 'crown': return [{ ...base, kind: 'spur' }];
    case 'bevel': return [{ ...base, kind: 'bevel', facing: f.facing, tip: f.tip }];
    case 'double-bevel':
      // Meshes side by side as a spur, and on either face as a bevel.
      return [{ ...base, kind: 'spur' }, ...(f.tips ?? []).map(tip => ({ ...base, kind: 'bevel' as const, tip, facing: unit(sub(tip, f.centre)) }))];
    case 'rack': return [{ key: f.key, kind: 'rack', teeth: f.teeth, width: f.width, length: f.length!, centre: f.centre, direction: f.axis, face: f.face! }];
    default: return [];
  }
}

/** A worm driving a wheel: shafts square to each other, a pitch radius apart along their common normal. */
function wormMesh(worm: WorldFeature, wheel: WorldGear): MeshVerdict {
  if (wheel.kind !== 'spur') return { meshes: false, reason: 'not a worm wheel' };
  if (Math.abs(dot(worm.axis, wheel.axis)) > SQUARE) return { meshes: false, reason: 'shafts are not square' };
  const n = unit([worm.axis[1] * wheel.axis[2] - worm.axis[2] * wheel.axis[1], worm.axis[2] * wheel.axis[0] - worm.axis[0] * wheel.axis[2], worm.axis[0] * wheel.axis[1] - worm.axis[1] * wheel.axis[0]]);
  const d = sub(wheel.centre, worm.centre), error = Math.abs(Math.abs(dot(d, n)) - (worm.pitchRadius + wheel.radius));
  if (error > MESH_TOLERANCE) return { meshes: false, errorLdu: error, reason: `pitch circles ${error.toFixed(1)} LDU from touching` };
  // The wheel's mid-plane must cross the worm's thread.
  if (Math.abs(dot(d, worm.axis)) > (worm.length ?? worm.width) / 2) return { meshes: false, errorLdu: error, reason: 'wheel is past the end of the worm' };
  if (Math.abs(dot(d, wheel.axis)) > wheel.width / 2 + worm.pitchRadius) return { meshes: false, errorLdu: error, reason: 'worm is beside the wheel, not in it' };
  return { meshes: true, errorLdu: error, sign: 1 };
}

type Found = { kind: HigherPairKind; verdict: MeshVerdict; swap?: boolean };
/** How feature x meshes with feature y, if at all. */
function meshOf(x: WorldFeature, y: WorldFeature): Found | null {
  if (x.kind === 'worm' || y.kind === 'worm') {
    const [worm, other] = x.kind === 'worm' ? [x, y] : [y, x];
    if (other.kind === 'worm') return null;
    for (const g of faces(other)) { const v = wormMesh(worm, g); if (v.meshes) return { kind: 'worm', verdict: v, swap: worm === y }; }
    return null;
  }
  for (const gx of faces(x)) for (const gy of faces(y)) {
    if (gx.kind === 'rack' && gy.kind === 'rack') continue;
    if (gx.kind === 'rack' || gy.kind === 'rack') {
      const swap = gx.kind === 'rack', v = swap ? rackMesh(gy, gx) : rackMesh(gx, gy);
      if (v.meshes) return { kind: 'rack', verdict: v, swap };
      continue;
    }
    const v = gx.kind === 'spur' && gy.kind === 'spur' ? spurMesh(gx, gy) : gx.kind === 'bevel' && gy.kind === 'bevel' ? bevelMesh(gx, gy) : null;
    if (v?.meshes) return { kind: gx.kind === 'spur' ? 'spur' : 'bevel', verdict: v };
  }
  return null;
}

const reach = (f: WorldFeature) => (f.kind === 'rack' ? (f.length ?? 0) / 2 : f.kind === 'worm' ? Math.max(f.pitchRadius, (f.length ?? f.width) / 2) : f.pitchRadius) + f.width + 10;

/**
 * Meshing pairs between placed parts. With `bodyOf`, parts of one rigid body
 * are not paired (gears fixed on one axle). With `screws` (linear actuators
 * whose input and piston were found), each adds a screw pair.
 */
export function findHigherPairs(asm: Assembly, bodyOf?: ReadonlyMap<string, number>, screws: readonly Screw[] = []): HigherPair[] {
  const placed = asm.instances.flatMap(i => worldFeatures(i.key, i.part, i.world).map((f, n) => ({ f, n, part: i.part })));
  const out: HigherPair[] = [];
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    const p = placed[i], q = placed[j];
    if (p.f.key === q.f.key) continue;
    if (bodyOf && bodyOf.get(p.f.key) !== undefined && bodyOf.get(p.f.key) === bodyOf.get(q.f.key)) continue;
    if (len(sub(p.f.centre, q.f.centre)) > reach(p.f) + reach(q.f)) continue;
    const m = meshOf(p.f, q.f);
    if (!m) continue;
    const [x, y] = m.swap ? [q, p] : [p, q];
    const pair: HigherPair = {
      id: `${m.kind}:${x.f.key}#${x.n}:${y.f.key}#${y.n}`, kind: m.kind, a: x.f.key, b: y.f.key, partA: x.part, partB: y.part,
      featureA: x.n, featureB: y.n, teethA: x.f.teeth, teethB: y.f.teeth, errorLdu: m.verdict.errorLdu,
    };
    if (m.kind === 'rack') Object.assign(pair, { pitchRadius: x.f.pitchRadius, reversed: m.verdict.sign === -1 });
    else Object.assign(pair, { ratio: x.f.teeth / y.f.teeth, reversed: m.verdict.sign === -1 });
    // One pair per two parts: the first way they mesh (a double bevel next to
    // a spur meshes once, not on every face).
    if (!out.some(o => (o.a === pair.a && o.b === pair.b) || (o.a === pair.b && o.b === pair.a))) out.push(pair);
  }
  for (const s of screws) {
    if (!s.input || !s.piston) continue;
    const input = asm.instances.find(i => i.key === s.input), piston = asm.instances.find(i => i.key === s.piston);
    out.push({ id: `screw:${s.input}:${s.piston}`, kind: 'screw', a: s.input, b: s.piston, partA: input?.part ?? '', partB: piston?.part ?? '', featureA: -1, featureB: -1, lead: s.leadLduPerTurn });
  }
  return out;
}

/** Whether a pair still meshes with its parts at these poses (world matrices). */
export function engaged(pair: HigherPair, poseA: THREE.Matrix4, poseB: THREE.Matrix4): { ok: boolean; errorLdu: number; reason?: string } {
  if (pair.kind === 'screw') return { ok: true, errorLdu: 0 };
  const fa = worldFeatures(pair.a, pair.partA, poseA)[pair.featureA], fb = worldFeatures(pair.b, pair.partB, poseB)[pair.featureB];
  if (!fa || !fb) return { ok: false, errorLdu: Infinity, reason: 'teeth not found' };
  let best: MeshVerdict | null = null;
  if (pair.kind === 'worm') best = wormMesh(fa.kind === 'worm' ? fa : fb, faces(fa.kind === 'worm' ? fb : fa)[0]);
  else for (const ga of faces(fa)) for (const gb of faces(fb)) {
    const v = pair.kind === 'rack' ? (ga.kind === 'rack' ? rackMesh(gb, ga) : gb.kind === 'rack' ? rackMesh(ga, gb) : null)
      : pair.kind === 'spur' && ga.kind === 'spur' && gb.kind === 'spur' ? spurMesh(ga, gb)
        : pair.kind === 'bevel' && ga.kind === 'bevel' && gb.kind === 'bevel' ? bevelMesh(ga, gb) : null;
    if (v && (!best || (v.meshes && !best.meshes))) best = v;
  }
  if (!best) return { ok: false, errorLdu: Infinity, reason: 'teeth no longer face each other' };
  return { ok: best.meshes, errorLdu: best.errorLdu ?? 0, ...(best.reason ? { reason: best.reason } : {}) };
}

/** The transmission laws the pairs impose (gear ratios, rack travel, screw lead). */
export function pairLaws(pairs: readonly HigherPair[]): SpatialMechanic[] {
  return pairs.flatMap((p): SpatialMechanic[] => {
    switch (p.kind) {
      case 'spur': case 'clutch': case 'crown':
        return [{ id: p.id, kind: 'gear', input: p.a, output: p.b, inputTeeth: p.teethA!, outputTeeth: p.teethB! }];
      case 'bevel': return [{ id: p.id, kind: 'bevel-gear', input: p.a, output: p.b, inputTeeth: p.teethA!, outputTeeth: p.teethB!, ...(p.reversed ? { reversed: true } : {}) }];
      case 'rack': return [{ id: p.id, kind: 'rack-pinion', rotary: p.a, linear: p.b, pitchRadiusLdu: p.pitchRadius!, ...(p.reversed ? { reversed: true } : {}) }];
      case 'worm': return [{ id: p.id, kind: 'worm', input: p.a, output: p.b, starts: p.teethA!, wheelTeeth: p.teethB! }];
      case 'screw': return [{ id: p.id, kind: 'screw', rotary: p.a, linear: p.b, leadLduPerTurn: p.lead! }];
    }
  });
}
