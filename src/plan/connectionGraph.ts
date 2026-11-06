import type { Assembly, Instance, Metrics } from '../model/assemble';
import type { Vec3 } from '../ldraw/parse';
import { partConnectors, worldConnectors, type ConnectorType } from './connectors';
import type { Warning } from '../model/validate';

/** One end of a mated connection: the piece and its connector. */
export type ConnectionEnd = { key: string; itemId: string; part: string; model: string };
export type MatedConnection = {
  a: ConnectionEnd;
  b: ConnectionEnd;
  /** which end is the male connector (stud, pin shaft, bar) */
  maleKey: string;
  type: ConnectorType;
  /** the joined point, world LDU */
  pos: Vec3;
  /** the male connector's axis: from the piece towards its mate */
  axis: Vec3;
  /** a clip or friction grip: one piece is held rather than seated */
  grip?: boolean;
  /** a finger hinge's knuckle run (both run ends share this key) */
  joint?: string;
};

const CELL = 4; // LDU grid for candidate pairs
const MATE_DIST = 2.5; // LDU the joined points may be apart
const ANTI = -0.98; // how opposite the axes must be

/**
 * Every mated connector pair in the assembly: studs in sockets, pin shafts in pin holes,
 * bars in bar holes and clips, finger-hinge knuckle runs joined. This is the same
 * connection model BrickLink Studio builds from its per-part connectivity data, derived
 * here from the measured geometry and the shadow library instead of hand-authored files.
 */
export function modelConnections(asm: Assembly, metrics: Metrics): MatedConnection[] {
  type Entry = {
    inst: Instance;
    pos: Vec3;
    axis: Vec3;
    type: ConnectorType;
    gender: 'M' | 'F';
    grip?: boolean;
    joint?: string;
  };
  const entries: Entry[] = [];
  for (const inst of asm.instances) {
    if (inst.placeholder) continue;
    const m = metrics(inst.part);
    if (!m) continue;
    for (const c of worldConnectors(partConnectors(m), inst.world.elements)) {
      entries.push({ inst, pos: c.pos, axis: c.axis, type: c.type, gender: c.gender, grip: c.grip, joint: c.joint });
    }
  }
  const cells = new Map<string, number[]>();
  entries.forEach((e, i) => {
    const k = `${Math.round(e.pos[0] / CELL)},${Math.round(e.pos[1] / CELL)},${Math.round(e.pos[2] / CELL)}`;
    let list = cells.get(k);
    if (!list) cells.set(k, (list = []));
    list.push(i);
  });
  const endOf = (i: Instance): ConnectionEnd => ({ key: i.key, itemId: i.itemId, part: i.part, model: i.model });
  const seen = new Set<string>();
  const out: MatedConnection[] = [];
  for (const [key, ids] of cells) {
    const [cx, cy, cz] = key.split(',').map(Number);
    // mates are within MATE_DIST < CELL, so the neighbourhood of one end's cell holds the other
    const candidates = new Set<number>();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const id of cells.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) candidates.add(id);
    }
    const list = [...candidates];
    for (let p = 0; p < list.length; p++) for (let q = p + 1; q < list.length; q++) {
      const A = entries[list[p]], B = entries[list[q]];
      if (A.inst.key === B.inst.key || A.type !== B.type || A.gender === B.gender) continue;
      const dot = A.axis[0] * B.axis[0] + A.axis[1] * B.axis[1] + A.axis[2] * B.axis[2];
      if (dot > ANTI) continue;
      if (A.joint && B.joint && A.joint !== B.joint) continue;
      if (Math.hypot(A.pos[0] - B.pos[0], A.pos[1] - B.pos[1], A.pos[2] - B.pos[2]) > MATE_DIST) continue;
      const pair = `${Math.min(list[p], list[q])}:${Math.max(list[p], list[q])}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      const male = A.gender === 'M' ? A : B;
      out.push({
        a: endOf(A.inst), b: endOf(B.inst), maleKey: male.inst.key,
        type: A.type, pos: [...male.pos] as Vec3, axis: [...male.axis] as Vec3,
        ...(A.grip || B.grip ? { grip: true } : {}),
        ...(A.joint ? { joint: A.joint } : {}),
      });
    }
  }
  return out;
}

/** The connections one piece participates in. */
export function connectionsOf(conns: readonly MatedConnection[], key: string): MatedConnection[] {
  return conns.filter((c) => c.a.key === key || c.b.key === key);
}

/**
 * Studio-style stability review: a piece held by a single stud or clip can spin or fall
 * when the build plays. A pin holds firmly and a hinge is meant to swivel, so those are
 * not flagged, and neither is a piece with only one socket (a 1x1 tile or plate): one
 * stud is all it can ever take, so it is built right.
 */
/**
 * How many studs a part can sit on: its stud sockets, one per column (a round 1x1 tile
 * has a socket at its mouth and another deeper on the same axis; that is still one stud).
 */
function socketsOf(metrics: Metrics, part: string): number {
  const m = metrics(part);
  if (!m) return 0;
  const columns: { pos: Vec3; axis: Vec3 }[] = [];
  for (const c of partConnectors(m)) {
    if (c.type !== 'stud' || c.gender !== 'F') continue;
    const same = columns.some((k) => {
      const d = [c.pos[0] - k.pos[0], c.pos[1] - k.pos[1], c.pos[2] - k.pos[2]];
      const along = d[0] * k.axis[0] + d[1] * k.axis[1] + d[2] * k.axis[2];
      return Math.hypot(d[0] - along * k.axis[0], d[1] - along * k.axis[1], d[2] - along * k.axis[2]) < 1;
    });
    if (!same) columns.push({ pos: c.pos, axis: c.axis });
  }
  return columns.length;
}

export function connectionChecks(asm: Assembly, metrics: Metrics, names: (part: string) => string = (p) => p): Warning[] {
  const held = new Map<string, MatedConnection[]>();
  for (const c of modelConnections(asm, metrics)) {
    for (const end of [c.a, c.b]) {
      let list = held.get(end.key);
      if (!list) held.set(end.key, (list = []));
      list.push(c);
    }
  }
  const inst = new Map(asm.instances.filter((i) => !i.placeholder).map((i) => [i.key, i]));
  const out: Warning[] = [];
  for (const [key, list] of held) {
    const i = inst.get(key);
    if (!i || list.length !== 1) continue;
    const only = list[0];
    if (only.type !== 'stud' && only.type !== 'bar') continue;
    // a single stud flags the piece sitting on it (the socket side); the supporting
    // piece below rests on the ground or on other parts and is not weak. A single
    // bar flags the gripped piece (the male side).
    const heldKey = only.type === 'stud' ? (only.maleKey === only.a.key ? only.b.key : only.a.key) : only.maleKey;
    if (heldKey !== key) continue;
    if (only.type === 'stud' && socketsOf(metrics, i.part) <= 1) continue;
    out.push({
      kind: 'weak',
      itemIds: [i.itemId],
      instanceKeys: [i.key],
      model: i.model,
      message: `${names(i.part)} is held by a single ${only.grip ? 'clip' : only.type}`,
      detail: 'One connection holds it: it can spin or fall when the build plays. Add another stud or use a pin.',
    });
  }
  return out;
}
