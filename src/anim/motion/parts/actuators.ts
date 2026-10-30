/**
 * Linear actuators: a screw inside the body turns with the input axle and
 * pushes the piston out.
 *
 * The stroke and its direction are measured from the part's LDraw shortcut
 * files, `<id>-f1.dat` (contracted) and `<id>-f2.dat` (extended): the sub-part
 * placed differently in the two is the piston. The screw lead is not in the
 * LDraw shape. It is the one per-part constant in part functions: builders
 * measured the 92693 actuator at 60 LDU of travel per 19.9 turns of its input,
 * as recorded by Kinebrick (erik-larsen/kinebrick, CC BY-SA 4.0).
 */
import * as THREE from 'three';
import type { Assembly } from '../../../model/assemble';
import type { LDrawFile } from '../../../ldraw/parse';
import type { MechanicalJoint } from '../../construction/mechanicalConstraintGraph';
import { partFunctions, partId, type Actuator } from './partFunctions';
import type { V3 } from './teeth';

/** Screw lead, LDU of piston travel per input turn, by part id. */
export const ACTUATOR_LEAD: Readonly<Record<string, number>> = { '92693c01': 60 / 19.9 };

export type Screw = { body: string; axis: V3; centre: V3; leadLduPerTurn: number; stroke: [number, number]; input?: string; piston?: string };

/** The actuator of a part with a known lead, from its contracted and extended shortcut files; null otherwise. */
export async function measureActuator(part: string, getFile: (name: string) => Promise<LDrawFile | null>): Promise<Actuator | null> {
  const id = partId(part), lead = ACTUATOR_LEAD[id];
  if (!lead) return null;
  const [contracted, extended] = await Promise.all([getFile(`${id}-f1.dat`), getFile(`${id}-f2.dat`)]);
  if (!contracted || !extended) return null;
  const refs = (f: LDrawFile) => f.cmds.flatMap(c => (c.t === 'ref' ? [{ file: c.file.toLowerCase(), pos: c.pos }] : []));
  const after = refs(extended), name = (file: string) => partId(file);
  // The piston is the sub-part placed differently; the input is the one that
  // stays, other than the body itself.
  let moved: Actuator | null = null, input: string | undefined;
  for (const a of refs(contracted)) {
    const b = after.find(x => x.file === a.file);
    if (!b) continue;
    const d = [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]], length = Math.hypot(d[0], d[1], d[2]);
    if (length > 1) moved = { axis: d.map(x => x / length + 0) as V3, leadLduPerTurn: lead, stroke: [0, length], piston: name(a.file) };
    else if (name(a.file) !== id) input = name(a.file);
  }
  return moved && { ...moved, ...(input ? { input } : {}) };
}

/**
 * Every placed part with a measured actuator. With the measured connectors
 * (libraryConnectors), each also names its placed input axle and piston.
 */
export function findLinearActuators(asm: Assembly, connectors: readonly MechanicalJoint[] = []): Screw[] {
  const partOf = new Map(asm.instances.map(i => [i.key, partId(i.part)]));
  return asm.instances.flatMap(i => {
    const a = partFunctions(i.part)?.actuator;
    if (!a) return [];
    const axis = new THREE.Vector3(...a.axis).transformDirection(i.world).toArray() as V3;
    const centre = new THREE.Vector3().setFromMatrixPosition(i.world).toArray() as V3;
    const held = (part?: string) => part && connectors.find(c => c.female === i.key && partOf.get(c.male) === part)?.male;
    const input = held(a.input), piston = held(a.piston);
    return [{ body: i.key, axis, centre, leadLduPerTurn: a.leadLduPerTurn, stroke: [...a.stroke] as [number, number], ...(input ? { input } : {}), ...(piston ? { piston } : {}) }];
  });
}
